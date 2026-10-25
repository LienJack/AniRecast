import { readFile, stat } from 'node:fs/promises';
import { AniError } from '@anirecast/shared';
import { imageCost, tokenCost } from './pricing.ts';
import type {
  ImageGenRequest,
  ImageGenResult,
  LocalMedia,
  Provider,
  Usage,
  VideoEditRequest,
  VideoEditResult,
  VisionRequest,
  VisionResult,
} from './types.ts';

const BASE = 'https://generativelanguage.googleapis.com';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete']);

type Json = Record<string, unknown>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface InteractionResponse {
  id?: string;
  status?: string;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
  error?: { message?: string; code?: number };
  [key: string]: unknown;
}

/** HTTP status → AniError. 4xx is a rejection (bad request, policy, key); 429/5xx is worth retrying. */
export function mapHttpError(status: number, body: unknown, what: string): AniError {
  const message = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${status}`;
  // A daily request quota (Omni allows 100 a day on Tier 2) does not clear in seconds; retrying only burns time.
  if (status === 429 && /per day/i.test(message))
    return new AniError('provider_rejected', `${what}: ${message}`, {
      hint: "daily_quota: the model's daily request quota is used up; do not retry until it resets.",
      details: { status, dailyQuota: true },
    });
  if (status === 429 || status >= 500)
    return new AniError('transient', `${what}: ${message}`, { details: { status } });
  const hint =
    status === 401 || status === 403
      ? 'Check the Gemini API key (`anirecast doctor`).'
      : 'The request was rejected; adjust the prompt or inputs and retry.';
  return new AniError('provider_rejected', `${what}: ${message}`, { hint, details: { status } });
}

/** Finds the first base64 media payload of the given kind anywhere in an Interactions response. */
export function findMedia(
  response: unknown,
  kind: 'image' | 'video',
): { data: Buffer; mimeType: string } | undefined {
  let found: { data: Buffer; mimeType: string } | undefined;
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const o = node as Json;
    const mime = (o.mime_type ?? o.mimeType) as string | undefined;
    if (typeof o.data === 'string' && o.data.length > 100 && mime?.startsWith(`${kind}/`)) {
      found = { data: Buffer.from(o.data, 'base64'), mimeType: mime };
      return;
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'signature') walk(v);
  };
  walk(response);
  return found;
}

const usageOf = (r: InteractionResponse): Usage => ({
  inputTokens: r.usage?.total_input_tokens ?? 0,
  outputTokens: r.usage?.total_output_tokens ?? 0,
  raw: r.usage,
});

async function inlineMedia(m: LocalMedia): Promise<Json> {
  return {
    type: m.mimeType.startsWith('video/') ? 'video' : 'image',
    data: (await readFile(m.path)).toString('base64'),
    mime_type: m.mimeType,
  };
}

export interface GeminiOptions {
  apiKey: string;
  fetch?: FetchLike;
  pollMs?: number;
}

export class GeminiProvider implements Provider {
  readonly name = 'gemini' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly pollMs: number;

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.pollMs = options.pollMs ?? 5_000;
  }

  private async request(
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<{ json: InteractionResponse; res: Response }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { 'x-goog-api-key': this.apiKey, ...(init.headers ?? {}) },
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new AniError('transient', `${what}: network error`, { cause: error });
    }
    const text = await res.text();
    let json: InteractionResponse = {};
    try {
      json = text ? (JSON.parse(text) as InteractionResponse) : {};
    } catch {
      json = { error: { message: text.slice(0, 500) } };
    }
    if (!res.ok) throw mapHttpError(res.status, json, what);
    return { json, res };
  }

  /** Creates an interaction and polls it to a terminal state. */
  private async interact(
    body: Json,
    signal: AbortSignal | undefined,
    what: string,
  ): Promise<{ json: InteractionResponse; latencyMs: number }> {
    const t0 = Date.now();
    let { json } = await this.request(
      `${BASE}/v1beta/interactions`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
      },
      what,
    );
    while (json.id && json.status && !TERMINAL.has(json.status)) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      signal?.throwIfAborted();
      ({ json } = await this.request(
        `${BASE}/v1beta/interactions/${json.id}`,
        { method: 'GET', ...(signal ? { signal } : {}) },
        what,
      ));
    }
    if (json.status && json.status !== 'completed') {
      throw new AniError(
        'provider_rejected',
        `${what}: interaction ${json.status}${json.error?.message ? ` (${json.error.message})` : ''}`,
        {
          hint: 'Often a content filter; rephrase the prompt or change the reference images.',
          details: { status: json.status, error: json.error },
        },
      );
    }
    return { json, latencyMs: Date.now() - t0 };
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
    const input = [...(await Promise.all(req.images.map(inlineMedia))), { type: 'text', text: req.prompt }];
    const body: Json = {
      model: req.model,
      input,
      response_format: { type: 'image', aspect_ratio: req.aspectRatio, image_size: req.imageSize },
      ...(req.previousInteractionId ? { previous_interaction_id: req.previousInteractionId } : {}),
    };
    const { json, latencyMs } = await this.interact(body, req.signal, 'Image generation');
    const media = findMedia(json, 'image');
    if (!media)
      throw new AniError('provider_rejected', 'Image generation returned no image', {
        hint: 'Possibly blocked by a content filter.',
      });
    const usage = usageOf(json);
    return {
      ...media,
      provider: this.name,
      model: req.model,
      usage,
      costUsd: imageCost(req.model, req.imageSize, usage.inputTokens),
      latencyMs,
      remote: json.id ? { interactionId: json.id } : {},
    };
  }

  /** Resumable upload to the Files API, then waits for ACTIVE. Returns the file URI. */
  async uploadFile(media: LocalMedia, signal?: AbortSignal): Promise<string> {
    const size = (await stat(media.path)).size;
    const start = await this.fetchImpl(`${BASE}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': media.mimeType,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: media.path.split('/').pop() } }),
      ...(signal ? { signal } : {}),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!start.ok || !uploadUrl)
      throw mapHttpError(start.status, await start.json().catch(() => ({})), 'File upload');
    const put = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: new Uint8Array(await readFile(media.path)),
      ...(signal ? { signal } : {}),
    });
    if (!put.ok) throw mapHttpError(put.status, await put.json().catch(() => ({})), 'File upload');
    let file = ((await put.json()) as { file: { name: string; uri: string; state: string } }).file;
    while (file.state === 'PROCESSING') {
      await new Promise((r) => setTimeout(r, 2_000));
      signal?.throwIfAborted();
      file = (await this.request(`${BASE}/v1beta/${file.name}`, { method: 'GET' }, 'File status'))
        .json as unknown as typeof file;
    }
    if (file.state !== 'ACTIVE') throw new AniError('provider_rejected', `Uploaded file is ${file.state}`);
    return file.uri;
  }

  async editVideo(req: VideoEditRequest): Promise<VideoEditResult> {
    let fileUri = req.cachedFileUri;
    if (!fileUri) {
      req.onStatus?.('uploading source shot');
      fileUri = await this.uploadFile(req.video, req.signal);
    }
    req.onStatus?.('generating');
    const input = [
      { type: 'video', uri: fileUri },
      ...(await Promise.all(req.images.map(inlineMedia))),
      { type: 'text', text: req.prompt },
    ];
    const body: Json = {
      model: req.model,
      input,
      response_format: { type: 'video', aspect_ratio: req.aspectRatio, resolution: req.resolution },
    };
    const { json, latencyMs } = await this.interact(body, req.signal, 'Video edit');
    const media = findMedia(json, 'video');
    if (!media)
      throw new AniError('provider_rejected', 'Video edit returned no video', {
        hint: 'Possibly blocked by a content filter.',
      });
    const usage = usageOf(json);
    return {
      data: media.data,
      mimeType: 'video/mp4',
      provider: this.name,
      model: req.model,
      usage,
      costUsd: tokenCost(req.model, usage),
      latencyMs,
      remote: { ...(json.id ? { interactionId: json.id } : {}), fileUri },
    };
  }

  async analyzeImages<T>(req: VisionRequest): Promise<VisionResult<T>> {
    const t0 = Date.now();
    const parts = [
      ...(await Promise.all(
        req.images.map(async (m) => ({
          inline_data: { mime_type: m.mimeType, data: (await readFile(m.path)).toString('base64') },
        })),
      )),
      { text: req.prompt },
    ];
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: req.responseSchema },
    };
    const { json } = await this.request(
      `${BASE}/v1beta/models/${req.model}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        ...(req.signal ? { signal: req.signal } : {}),
      },
      'Image analysis',
    );
    const r = json as unknown as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const text = r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) {
      throw new AniError(
        'provider_rejected',
        `Image analysis returned no content (${r.candidates?.[0]?.finishReason ?? 'unknown'})`,
      );
    }
    const usage: Usage = {
      inputTokens: r.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0),
      raw: r.usageMetadata,
    };
    return {
      data: JSON.parse(text) as T,
      provider: this.name,
      model: req.model,
      usage,
      costUsd: tokenCost(req.model, usage),
      latencyMs: Date.now() - t0,
      remote: {},
    };
  }
}
