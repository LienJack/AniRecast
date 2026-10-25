import { readFile } from 'node:fs/promises';
import { AniError } from '@anirecast/shared';
import { mapHttpError } from './gemini.ts';
import type {
  ImageGenRequest,
  ImageGenResult,
  Provider,
  Usage,
  VideoEditRequest,
  VideoEditResult,
  VisionRequest,
  VisionResult,
} from './types.ts';

export const JEV_PREFIX = 'jev:';
/** The router bills in CNY; spend is recorded in USD at this rate. */
export const CNY_PER_USD = 7.2;

type Json = Record<string, unknown>;

/** First JSON object in a reply, tolerating ```json fences or a sentence around it. */
export function parseJsonReply<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new AniError('provider_rejected', 'The model did not answer in JSON');
  return JSON.parse(fenced.slice(start, end + 1)) as T;
}

/**
 * Vision judgements through an OpenAI-compatible router ("JEV", e.g. router.shengsuanyun.com). Models are
 * named `jev:<router model id>`; prices come from the router's model list (CNY per million tokens).
 */
export class JevProvider implements Provider {
  readonly name = 'jev' as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  #prices: Promise<Map<string, { input: number; output: number }>> | undefined;

  constructor(opts: { apiKey: string; baseUrl: string }) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
  }

  static modelId(model: string): string {
    return model.startsWith(JEV_PREFIX) ? model.slice(JEV_PREFIX.length) : model;
  }

  /** CNY per million tokens by model, fetched once; unknown models cost 0 rather than failing the call. */
  async #price(model: string): Promise<{ input: number; output: number }> {
    this.#prices ??= fetch(`${this.#baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.#apiKey}` },
    })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j) => {
        const list = ((j as Json).data ?? []) as Array<{
          id: string;
          pricing?: { input_price?: number; output_price?: number };
        }>;
        return new Map(
          list.map((m) => [
            m.id,
            { input: m.pricing?.input_price ?? 0, output: m.pricing?.output_price ?? 0 },
          ]),
        );
      })
      .catch(() => new Map());
    return (await this.#prices).get(model) ?? { input: 0, output: 0 };
  }

  async analyzeImages<T>(req: VisionRequest): Promise<VisionResult<T>> {
    const t0 = Date.now();
    const model = JevProvider.modelId(req.model);
    const content = [
      ...(await Promise.all(
        req.images.map(async (m) => ({
          type: 'image_url',
          image_url: { url: `data:${m.mimeType};base64,${(await readFile(m.path)).toString('base64')}` },
        })),
      )),
      {
        type: 'text',
        text: `${req.prompt}\n\nReply with one JSON object only, matching this JSON schema:\n${JSON.stringify(req.responseSchema)}`,
      },
    ];
    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw mapHttpError(res.status, json, 'JEV image analysis');
    const choice = (
      json.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined
    )?.[0];
    const text = choice?.message?.content ?? '';
    if (!text) {
      throw new AniError(
        'provider_rejected',
        `JEV returned no content (${choice?.finish_reason ?? 'unknown'})`,
      );
    }
    const u = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    const usage: Usage = {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      raw: json.usage,
    };
    const price = await this.#price(model);
    const costCny = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
    return {
      data: parseJsonReply<T>(text),
      provider: 'jev',
      model: req.model,
      usage,
      costUsd: costCny / CNY_PER_USD,
      latencyMs: Date.now() - t0,
      remote: {},
    };
  }

  async generateImage(_req: ImageGenRequest): Promise<ImageGenResult> {
    throw new AniError('usage', 'The JEV route only analyzes images; use a Gemini or fal model for images');
  }

  async editVideo(_req: VideoEditRequest): Promise<VideoEditResult> {
    throw new AniError('usage', 'The JEV route only analyzes images; use a Gemini or fal model for video');
  }
}
