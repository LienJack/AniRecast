import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe } from '@anirecast/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeShots } from '../../media/test/fixtures.ts';
import {
  estimateVideoEditCost,
  estimateVisionCost,
  FakeProvider,
  falError,
  falVideoFamily,
  findMedia,
  GeminiProvider,
  mapHttpError,
  parseJsonReply,
  RoutedProvider,
  tokenCost,
  toSeedancePrompt,
  videoModelTakesImages,
} from '../src/index.ts';

let dir: string;
let video: string;
let image: string;
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'anirecast-prov-'));
  video = path.join(dir, 'shot.mp4');
  await synthesizeShots(video, [48]);
  image = path.join(dir, 'ref.png');
  writeFileSync(image, PNG_1PX);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pricing', () => {
  it('reproduces the spike costs from real usage', () => {
    // Omni image-to-video 10 s: 1,165 input / 57,920 output tokens.
    expect(tokenCost('gemini-omni-1.1-flash', { inputTokens: 1165, outputTokens: 57920 })).toBeCloseTo(
      1.015,
      2,
    );
    // Omni 4 s edit: 25,683 input / 23,168 output tokens.
    expect(tokenCost('gemini-omni-1.1-flash', { inputTokens: 25683, outputTokens: 23168 })).toBeCloseTo(
      0.444,
      2,
    );
  });
});

describe('fake provider', () => {
  it('keeps the frame count and scales to the requested resolution', async () => {
    const fake = new FakeProvider();
    const result = await fake.editVideo({
      model: 'gemini-omni-1.1-flash',
      prompt: 'x',
      video: { path: video, mimeType: 'video/mp4' },
      inputFrames: 48,
      inputSeconds: 2,
      images: [],
      resolution: '360p',
      aspectRatio: '16:9',
    });
    const out = path.join(dir, 'fake-out.mp4');
    writeFileSync(out, result.data);
    expect(await probe(out, { countFrames: true })).toMatchObject({ frameCount: 48, height: 360 });
    expect(result.costUsd).toBe(0);
  }, 60_000);
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('gemini provider (mocked HTTP)', () => {
  it('builds an image request with inline references and parses the image', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = new GeminiProvider({
      apiKey: 'k',
      pollMs: 1,
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse({
          id: 'v1_x',
          status: 'completed',
          usage: { total_input_tokens: 2365, total_output_tokens: 1485 },
          steps: [
            {
              signature: 'x'.repeat(5000),
              content: [
                { type: 'image', mime_type: 'image/jpeg', data: PNG_1PX.toString('base64').repeat(3) },
              ],
            },
          ],
        });
      },
    });
    const result = await provider.generateImage({
      model: 'gemini-nano-banana-2.1',
      prompt: 'swap',
      images: [{ path: image, mimeType: 'image/png' }],
      aspectRatio: '16:9',
      imageSize: '1K',
    });
    expect(calls[0]!.url).toMatch(/\/v1beta\/interactions$/);
    expect(calls[0]!.body).toMatchObject({
      model: 'gemini-nano-banana-2.1',
      response_format: { type: 'image', aspect_ratio: '16:9', image_size: '1K' },
      input: [
        { type: 'image', mime_type: 'image/png' },
        { type: 'text', text: 'swap' },
      ],
    });
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.remote.interactionId).toBe('v1_x');
    expect(result.costUsd).toBeCloseTo(0.0336 + (2365 * 1.5) / 1e6, 4);
  });

  it('uploads the shot, polls the interaction and returns the edited video', async () => {
    const seen: string[] = [];
    let polls = 0;
    const provider = new GeminiProvider({
      apiKey: 'k',
      pollMs: 1,
      fetch: async (url, init) => {
        seen.push(`${init?.method ?? 'GET'} ${url.replace('https://generativelanguage.googleapis.com', '')}`);
        if (url.endsWith('/upload/v1beta/files'))
          return jsonResponse({}, 200, { 'x-goog-upload-url': 'https://upload.example/u' });
        if (url === 'https://upload.example/u')
          return jsonResponse({ file: { name: 'files/abc', uri: 'https://f/abc', state: 'PROCESSING' } });
        if (url.endsWith('/v1beta/files/abc'))
          return jsonResponse({ name: 'files/abc', uri: 'https://f/abc', state: 'ACTIVE' });
        if (url.endsWith('/v1beta/interactions')) return jsonResponse({ id: 'i1', status: 'in_progress' });
        polls++;
        return jsonResponse({
          id: 'i1',
          status: polls < 2 ? 'in_progress' : 'completed',
          usage: { total_input_tokens: 1000, total_output_tokens: 2000 },
          steps: [
            {
              content: [
                { type: 'video', mime_type: 'video/mp4', data: Buffer.alloc(300).toString('base64') },
              ],
            },
          ],
        });
      },
    });
    const result = await provider.editVideo({
      model: 'gemini-omni-1.1-flash',
      prompt: 'replace',
      video: { path: video, mimeType: 'video/mp4' },
      inputFrames: 48,
      inputSeconds: 2,
      images: [{ path: image, mimeType: 'image/png' }],
      resolution: '360p',
      aspectRatio: '16:9',
    });
    expect(seen.slice(0, 4)).toEqual([
      'POST /upload/v1beta/files',
      'POST https://upload.example/u',
      'GET /v1beta/files/abc',
      'POST /v1beta/interactions',
    ]);
    expect(polls).toBe(2);
    expect(result.data.length).toBe(300);
    expect(result.remote).toEqual({ interactionId: 'i1', fileUri: 'https://f/abc' });
  });

  it('maps HTTP errors and failed interactions', async () => {
    expect(mapHttpError(400, { error: { message: 'bad' } }, 'X').code).toBe('provider_rejected');
    expect(mapHttpError(429, {}, 'X').code).toBe('transient');
    const daily = mapHttpError(
      429,
      {
        error: {
          message:
            'Rate limit exceeded for model gemini-omni-1.1-flash (limit: 100 requests per day on Tier 2).',
        },
      },
      'Video edit',
    );
    expect(daily).toMatchObject({ code: 'provider_rejected', details: { dailyQuota: true } });
    expect(mapHttpError(503, {}, 'X').code).toBe('transient');
    const provider = new GeminiProvider({
      apiKey: 'k',
      pollMs: 1,
      fetch: async () => jsonResponse({ id: 'i', status: 'failed', error: { message: 'SAFETY' } }),
    });
    await expect(
      provider.generateImage({ model: 'm', prompt: 'p', images: [], aspectRatio: '16:9', imageSize: '1K' }),
    ).rejects.toMatchObject({ code: 'provider_rejected' });
  });

  it('ignores signature blobs when looking for media', () => {
    expect(findMedia({ steps: [{ signature: 'A'.repeat(500) }] }, 'video')).toBeUndefined();
  });
});

describe('fal and JEV routes', () => {
  it('sends each model to its backend and names the missing key', async () => {
    const fake = new FakeProvider({ vision: () => ({ ok: true }) });
    const routed = new RoutedProvider({ jev: fake });
    expect(routed.backendFor('jev:google/gemini-3.8-flash')).toBe('jev');
    expect(routed.backendFor('fal:bytedance/seedance-2.5/us/reference-to-video')).toBe('fal');
    expect(routed.backendFor('gemini-omni-1.1-flash')).toBe('gemini');
    const r = await routed.analyzeImages<{ ok: boolean }>({
      model: 'jev:x',
      prompt: 'p',
      images: [],
      responseSchema: {},
    });
    expect(r.data.ok).toBe(true);
    await expect(
      routed.editVideo({
        model: 'fal:google/gemini-omni-flash/v1.1/edit',
        prompt: 'p',
        video: { path: video, mimeType: 'video/mp4' },
        inputFrames: 1,
        inputSeconds: 1,
        images: [],
        resolution: '360p',
        aspectRatio: '16:9',
      }),
    ).rejects.toThrow(/No fal API key/);
  });

  it('turns fal content blocks into safety blocks and maps Seedance prompts', () => {
    const blocked = falError(
      422,
      { detail: [{ type: 'content_policy_violation', msg: 'The output contains sexual content.' }] },
      'fal video edit',
    );
    expect(blocked.code).toBe('provider_rejected');
    expect(blocked.message).toMatch(/Request blocked by the safety filter/);
    expect(falError(422, { detail: [{ type: 'greater_than_equal', msg: 'too short' }] }, 'x').message).toBe(
      'x: too short',
    );
    expect(falError(503, { detail: 'busy' }, 'x').code).toBe('transient');
    expect(toSeedancePrompt('Replace her with <IMAGE_REF_0> and <IMAGE_REF_2>.')).toBe(
      'Edit @Video1. Replace her with @Image1 and @Image3.',
    );
    expect(falVideoFamily('fal:google/gemini-omni-flash/v1.1/edit')).toBe('omni-edit');
    expect(falVideoFamily('fal:bytedance/seedance-2.5/us/reference-to-video')).toBe('seedance-reference');
    expect(falVideoFamily('fal:google/gemini-omni-flash/v1.1/reference-to-video')).toBeUndefined();
    expect(videoModelTakesImages('fal:google/gemini-omni-flash/v1.1/edit')).toBe(false);
    expect(videoModelTakesImages('gemini-omni-1.1-flash')).toBe(true);
  });

  it('reads JSON replies and estimates fal and JEV costs', () => {
    expect(parseJsonReply<{ a: number }>('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply('no json here')).toThrow(/did not answer in JSON/);
    // Omni edit on fal: USD 0.03 per output second.
    expect(estimateVideoEditCost('fal:google/gemini-omni-flash/v1.1/edit', 3, '360p')).toBeCloseTo(0.09);
    // Seedance: at least 4 s at 480p plus the 1.5 s reference at 0.6x, USD 0.0214 per 1000 tokens.
    const seedance = estimateVideoEditCost('fal:bytedance/seedance-2.5/us/reference-to-video', 1.5, '360p');
    expect(seedance).toBeGreaterThan(0.9);
    expect(seedance).toBeLessThan(1.1);
    expect(estimateVisionCost('jev:google/gemini-3.8-flash', 4)).toBeLessThan(0.01);
  });
});
