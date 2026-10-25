import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe } from '@anirecast/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeShots } from '../../media/test/fixtures.ts';
import { FakeProvider, findMedia, GeminiProvider, mapHttpError, tokenCost } from '../src/index.ts';

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
