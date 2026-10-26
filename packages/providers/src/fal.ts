import { stat as fsStat, readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { AniError, isTextOnlyVideoModel } from '@anirecast/shared';
import type {
  ImageGenRequest,
  ImageGenResult,
  LocalMedia,
  Provider,
  VideoEditRequest,
  VideoEditResult,
  VisionRequest,
  VisionResult,
} from './types.ts';

export const FAL_PREFIX = 'fal:';
const QUEUE = 'https://queue.fal.run';
const STORAGE = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const PLATFORM = 'https://api.fal.ai/v1';

type Json = Record<string, unknown>;

/** How a fal endpoint is driven for a video edit. */
export type FalVideoFamily = 'omni-edit' | 'seedance-reference' | 'h3-recast' | 'wan-edit' | 'wan-reference';

export function falVideoFamily(model: string): FalVideoFamily | undefined {
  const id = model.startsWith(FAL_PREFIX) ? model.slice(FAL_PREFIX.length) : model;
  if (/gemini-omni/.test(id) && id.endsWith('/edit')) return 'omni-edit';
  if (/seedance/.test(id) && id.endsWith('/reference-to-video')) return 'seedance-reference';
  if (/minimax\/h3/.test(id) && id.endsWith('/recast')) return 'h3-recast';
  if (/wan/.test(id) && id.endsWith('/edit-video')) return 'wan-edit';
  if (/wan-3/.test(id) && id.endsWith('/reference-to-video')) return 'wan-reference';
  return undefined;
}

/** Whether a video model can be given reference images (board, persona). */
export function videoModelTakesImages(model: string): boolean {
  return !isTextOnlyVideoModel(model);
}

/** fal reports problems as `{detail: [{msg, type}]}` or `{detail: "..."}`; content blocks become safety blocks. */
export function falError(status: number, body: unknown, what: string): AniError {
  const detail = (body as { detail?: unknown })?.detail;
  const first = Array.isArray(detail)
    ? (detail[0] as { msg?: string; type?: string; loc?: unknown[] } | undefined)
    : undefined;
  // Which input was refused, when fal says (["body", "video_urls", 0] → video_urls.0).
  const where = Array.isArray(first?.loc) ? first.loc.filter((l) => l !== 'body').join('.') : '';
  const message =
    (first?.msg ? `${first.msg}${where ? ` (${where})` : ''}` : undefined) ??
    (typeof detail === 'string' ? detail : `HTTP ${status}`);
  if (first?.type === 'content_policy_violation')
    return new AniError('provider_rejected', `${what}: Request blocked by the safety filter (${message})`, {
      hint: 'safety_block: change the prompt, the board or the persona look.',
      details: { status, type: first.type },
    });
  if (status === 429 || status >= 500)
    return new AniError('transient', `${what}: ${message}`, { details: { status } });
  const hint =
    status === 401 || status === 403
      ? 'Check the fal.ai key (`anirecast auth status`).'
      : 'The request was rejected; adjust the prompt or inputs and retry.';
  return new AniError('provider_rejected', `${what}: ${message}`, {
    hint,
    details: { status, type: first?.type },
  });
}

/** Turns `<IMAGE_REF_n>` (planner order: board first, then personas) into Seedance's `@Image{n+1}`. */
/** Prompts name references as <IMAGE_REF_n>; models without that syntax get plain words. */
export const plainRefs = (prompt: string, name: (n: number) => string): string =>
  prompt.replace(/<IMAGE_REF_(\d+)>/g, (_m, n: string) => name(Number(n)));

/**
 * Wan 3.0 reference-to-video makes a new clip from references: Video 1 (the shot) gives motion, framing and
 * timing; the images (storyboard frame, characters) are Image 1, 2 … in order.
 */
export function toWanReferencePrompt(prompt: string): string {
  return `Video 1 is the original anime shot. Remake it shot for shot: the same camera movement, framing, composition, timing, background, lighting, colours and actions, in the same anime style; change only what follows. ${plainRefs(prompt, (n) => `Image ${n + 1}`)}`;
}

export function toSeedancePrompt(prompt: string): string {
  return `Edit @Video1. ${prompt.replace(/<IMAGE_REF_(\d+)>/g, (_m, n: string) => `@Image${Number(n) + 1}`)}`;
}

/**
 * Video edits on fal.ai: Gemini Omni `edit` (video and prompt only) and Seedance reference-to-video in editing
 * mode (video plus reference images). Models are named `fal:<endpoint id>`. Cost is fal's billable units for
 * the request times the endpoint's list price.
 */
/** The low-level cause of a failed fetch (ECONNRESET, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT …). */
export const networkCause = (error: unknown): string => {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (error as Error).message ?? String(error);
};
/** Failures before the request reached the server: safe to retry even a paid submit. */
const CONNECT_FAILURES =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH|CERT|TLS/i;
const BACKOFF_MS = [1500, 4000, 8000];

/**
 * fetch with retries for a flaky line to fal (an outage of a few minutes broke whole batches): network errors are
 * retried with backoff — any of them for uploads and polling, only connection failures for a paid submit — and
 * what still fails is a transient error (the job is retried) naming its cause.
 */
async function netFetch(
  url: string,
  init: RequestInit,
  what: string,
  opts: { submit?: boolean } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if ((error as Error).name === 'AbortError' || init.signal?.aborted) throw error;
      const cause = networkCause(error);
      const retry = attempt < BACKOFF_MS.length && (!opts.submit || CONNECT_FAILURES.test(cause));
      if (!retry) throw new AniError('transient', `${what}: network error (${cause})`, { cause: error });
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }
}

/**
 * PUTs a file over HTTP/1.1. Node's fetch speaks HTTP/2 to fal's upload host, and several large bodies at once
 * reset the streams (ERR_HTTP2_STREAM_ERROR): every frame-by-frame part failed before its first image.
 */
function putHttp1(url: string, body: Buffer, contentType: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'PUT',
        headers: { 'content-type': contentType, 'content-length': body.length },
        ...(signal ? { signal } : {}),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export class FalProvider implements Provider {
  readonly name = 'fal' as const;
  readonly #key: string;
  readonly #prices = new Map<string, Promise<number>>();

  readonly #put: typeof putHttp1;

  /** `put` replaces the HTTP/1.1 upload (tests route it through their fetch stub). */
  constructor(opts: { apiKey: string; put?: typeof putHttp1 }) {
    this.#key = opts.apiKey;
    this.#put = opts.put ?? putHttp1;
  }

  get #auth() {
    return { authorization: `Key ${this.#key}` };
  }

  /** Files already on fal's CDN this run (path, size and mtime → URL): design sheets go up once, not per frame. */
  readonly #uploaded = new Map<string, string>();

  /** Uploads several files, at most four at a time (dozens at once broke fal's HTTP/2 streams). */
  async #uploadAll(media: LocalMedia[], signal?: AbortSignal): Promise<string[]> {
    const urls: string[] = new Array(media.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < media.length; i = next++) urls[i] = await this.#upload(media[i]!, signal);
    };
    await Promise.all(Array.from({ length: Math.min(4, media.length) }, worker));
    return urls;
  }

  /** Uploads in flight, shared by every request that needs the same file. */
  readonly #pending = new Map<string, Promise<string>>();
  /** Uploads running now across all requests, and those waiting for a turn. */
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  async #upload(media: LocalMedia, signal?: AbortSignal): Promise<string> {
    const stat = await fsStat(media.path).catch(() => null);
    const key = stat ? `${media.path}:${stat.size}:${stat.mtimeMs}` : null;
    const cached = key ? this.#uploaded.get(key) : undefined;
    if (cached) return cached;
    const inFlight = key ? this.#pending.get(key) : undefined;
    if (inFlight) return inFlight;
    const run = (async () => {
      // At most four uploads at a time across every request: three frame-by-frame parts at once (nine image
      // calls, each with its references) broke fal's HTTP/2 streams.
      if (this.#active >= 4) await new Promise<void>((resolve) => this.#waiting.push(resolve));
      this.#active++;
      try {
        return await this.#uploadOnce(media, signal);
      } finally {
        this.#active--;
        this.#waiting.shift()?.();
      }
    })();
    if (key) this.#pending.set(key, run);
    try {
      const url = await run;
      if (key) this.#uploaded.set(key, url);
      return url;
    } finally {
      if (key) this.#pending.delete(key);
    }
  }

  async #uploadOnce(media: LocalMedia, signal?: AbortSignal): Promise<string> {
    const init = await netFetch(
      STORAGE,
      {
        method: 'POST',
        headers: { ...this.#auth, 'content-type': 'application/json' },
        body: JSON.stringify({ content_type: media.mimeType, file_name: path.basename(media.path) }),
        ...(signal ? { signal } : {}),
      },
      'fal upload',
    );
    const target = (await init.json().catch(() => ({}))) as { upload_url?: string; file_url?: string };
    if (!init.ok || !target.upload_url || !target.file_url) throw falError(init.status, target, 'fal upload');
    const body = await readFile(media.path);
    for (let attempt = 0; ; attempt++) {
      try {
        const status = await this.#put(target.upload_url, body, media.mimeType, signal);
        if (status < 200 || status >= 300) throw falError(status, {}, 'fal upload');
        return target.file_url;
      } catch (error) {
        if (signal?.aborted || error instanceof AniError || attempt >= BACKOFF_MS.length) {
          if (error instanceof AniError) throw error;
          throw new AniError('transient', `fal upload: network error (${networkCause(error)})`, {
            cause: error,
          });
        }
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
  }

  /** List price per billable unit of an endpoint (seconds for Omni, 1000 tokens for Seedance). */
  #unitPrice(endpoint: string): Promise<number> {
    let p = this.#prices.get(endpoint);
    if (!p) {
      p = fetch(`${PLATFORM}/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`, {
        headers: this.#auth,
      })
        .then((r) => (r.ok ? r.json() : { prices: [] }))
        .then((j) =>
          Number(((j as Json).prices as Array<{ unit_price?: number }> | undefined)?.[0]?.unit_price ?? 0),
        )
        .catch(() => 0);
      this.#prices.set(endpoint, p);
    }
    return p;
  }

  /** Submits to fal's queue and waits for the result; returns the output and the billable units. */
  async #run(
    endpoint: string,
    input: Json,
    what: string,
    signal?: AbortSignal,
    onStatus?: (m: string) => void,
  ): Promise<{ output: Json; units: number; requestId: string }> {
    const submit = await netFetch(
      `${QUEUE}/${endpoint}`,
      {
        method: 'POST',
        headers: { ...this.#auth, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        ...(signal ? { signal } : {}),
      },
      what,
      { submit: true },
    );
    const queued = (await submit.json().catch(() => ({}))) as {
      request_id?: string;
      status_url?: string;
      response_url?: string;
    };
    if (!submit.ok || !queued.status_url || !queued.response_url) throw falError(submit.status, queued, what);
    const deadline = Date.now() + 20 * 60_000;
    let last = '';
    for (;;) {
      if (signal?.aborted) throw new AniError('transient', `${what}: cancelled`);
      const s = await netFetch(
        queued.status_url,
        { headers: this.#auth, ...(signal ? { signal } : {}) },
        what,
      );
      const status = ((await s.json().catch(() => ({}))) as { status?: string }).status ?? 'UNKNOWN';
      if (status !== last) onStatus?.(`fal ${status.toLowerCase().replace('_', ' ')}`);
      last = status;
      if (status === 'COMPLETED') break;
      if (Date.now() > deadline) throw new AniError('transient', `${what}: still ${status} after 20 minutes`);
      await new Promise((r) => setTimeout(r, 2500));
    }
    const res = await netFetch(
      queued.response_url,
      { headers: this.#auth, ...(signal ? { signal } : {}) },
      what,
    );
    const output = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || output.detail) throw falError(res.status, output, what);
    return {
      output,
      units: Number(res.headers.get('x-fal-billable-units') ?? 0),
      requestId: queued.request_id ?? '',
    };
  }

  async editVideo(req: VideoEditRequest): Promise<VideoEditResult> {
    const t0 = Date.now();
    const endpoint = req.model.startsWith(FAL_PREFIX) ? req.model.slice(FAL_PREFIX.length) : req.model;
    const family = falVideoFamily(endpoint);
    if (!family) {
      throw new AniError('usage', `fal endpoint ${endpoint} is not set up for shot edits`, {
        hint: 'Use a fal Omni …/edit, Seedance …/reference-to-video, MiniMax H3 …/recast or Wan …/edit-video endpoint.',
      });
    }
    req.onStatus?.('uploading to fal');
    const videoUrl = await this.#upload(req.video, req.signal);
    let input: Json;
    const high = req.resolution === '1080p' || req.resolution === '4k';
    if (family === 'omni-edit') {
      input = { prompt: req.prompt, video_url: videoUrl, resolution: req.resolution };
    } else if (family === 'h3-recast') {
      // One reference per new character, replacing the main people left to right; 5–30 s input.
      if (!req.images.length)
        throw new AniError('usage', 'MiniMax H3 Recast needs a reference image of each new character');
      const imageUrls = await this.#uploadAll(req.images.slice(0, 4), req.signal);
      input = {
        prompt: plainRefs(req.prompt, (n) => `reference image ${n + 1}`).slice(0, 2000),
        video_url: videoUrl,
        reference_image_urls: imageUrls,
        resolution: high ? '1080P' : '768P',
      };
    } else if (family === 'wan-reference') {
      const imageUrls = await this.#uploadAll(req.images.slice(0, 9), req.signal);
      input = {
        prompt: toWanReferencePrompt(req.prompt),
        reference_video_urls: [videoUrl],
        reference_image_urls: imageUrls,
        // Whole seconds only; the upload was padded to exactly this length.
        duration: Math.max(2, Math.round(req.inputSeconds)),
        resolution: high ? '1080p' : req.resolution === '720p' ? '720p' : '480p',
        aspect_ratio: req.aspectRatio,
        audio: false,
      };
    } else if (family === 'wan-edit') {
      // duration 0 keeps the input length; one optional reference image (the storyboard frame).
      const ref = req.images[0] ? await this.#upload(req.images[0], req.signal) : null;
      input = {
        prompt: plainRefs(req.prompt, () => 'the reference image'),
        video_url: videoUrl,
        ...(ref ? { reference_image_url: ref } : {}),
        duration: 0,
        resolution: high ? '1080p' : '720p',
        audio_setting: 'origin',
      };
    } else {
      const imageUrls = await this.#uploadAll(req.images, req.signal);
      input = {
        prompt: toSeedancePrompt(req.prompt),
        video_urls: [videoUrl],
        image_urls: imageUrls,
        task: 'editing',
        duration: 'auto',
        // Seedance has no 360p; its smallest size is 480p.
        resolution: req.resolution === '360p' ? '480p' : req.resolution === '4k' ? '1080p' : req.resolution,
        aspect_ratio: req.aspectRatio,
        generate_audio: false,
        // The standard encode came back at ~2 Mbps for 1080p, visibly softer than the source.
        bitrate_mode: 'high',
      };
    }
    const { output, units, requestId } = await this.#run(
      endpoint,
      input,
      'fal video edit',
      req.signal,
      req.onStatus,
    );
    const url = (output.video as { url?: string } | undefined)?.url;
    if (!url) throw new AniError('provider_rejected', 'fal returned no video');
    const video = await netFetch(url, req.signal ? { signal: req.signal } : {}, 'fal download');
    if (!video.ok) throw falError(video.status, {}, 'fal download');
    const unitPrice = await this.#unitPrice(endpoint);
    return {
      data: Buffer.from(await video.arrayBuffer()),
      mimeType: 'video/mp4',
      provider: 'fal',
      model: req.model,
      usage: { inputTokens: 0, outputTokens: 0, raw: { billableUnits: units, unitPrice, family } },
      costUsd: units * unitPrice,
      latencyMs: Date.now() - t0,
      remote: { interactionId: requestId },
    };
  }

  /** Reference-guided image models on fal (GPT Image 2.5 `…/edit`): up to 16 reference images. */
  async generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
    const t0 = Date.now();
    const endpoint = req.model.startsWith(FAL_PREFIX) ? req.model.slice(FAL_PREFIX.length) : req.model;
    if (!/gpt-image/.test(endpoint) || !endpoint.endsWith('/edit'))
      throw new AniError('usage', `fal endpoint ${endpoint} is not set up for reference images`, {
        hint: 'Use fal:openai/gpt-image-2.5/sunburst/edit.',
      });
    const imageUrls = await this.#uploadAll(req.images.slice(0, 16), req.signal);
    const long = req.imageSize === '1K' ? 1536 : 2048;
    const short = Math.round(((req.imageSize === '1K' ? 1536 : 2048) * 9) / 16 / 16) * 16;
    const image_size =
      req.aspectRatio === '1:1'
        ? { width: long, height: long }
        : req.aspectRatio === '9:16'
          ? { width: short, height: long }
          : { width: long, height: short };
    const { output, units, requestId } = await this.#run(
      endpoint,
      {
        prompt: req.prompt,
        image_urls: imageUrls,
        image_size,
        quality: 'high',
        output_format: 'png',
        num_images: 1,
      },
      'fal image',
      req.signal,
    );
    const first = (output.images as Array<{ url?: string; content_type?: string }> | undefined)?.[0];
    if (!first?.url) throw new AniError('provider_rejected', 'fal returned no image');
    const file = await netFetch(first.url, req.signal ? { signal: req.signal } : {}, 'fal download');
    if (!file.ok) throw falError(file.status, {}, 'fal download');
    const unitPrice = await this.#unitPrice(endpoint);
    return {
      data: Buffer.from(await file.arrayBuffer()),
      mimeType: first.content_type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      provider: 'fal',
      model: req.model,
      usage: { inputTokens: 0, outputTokens: 0, raw: { billableUnits: units, unitPrice } },
      costUsd: units * unitPrice,
      latencyMs: Date.now() - t0,
      remote: { interactionId: requestId },
    };
  }

  async analyzeImages<T>(_req: VisionRequest): Promise<VisionResult<T>> {
    throw new AniError('usage', 'Use a Gemini or jev: model for image analysis');
  }
}
