import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe } from '@anirecast/media';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { synthesizeShots } from '../../media/test/fixtures.ts';
import {
  estimateVideoEditCost,
  estimateVisionCost,
  FakeProvider,
  FalProvider,
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

  it('drives MiniMax H3 Recast and Wan edit with their own fields', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anirecast-fal-'));
    const bodies: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/storage/upload/initiate'))
        return Response.json({
          upload_url: 'https://up/x',
          file_url: `https://cdn/${JSON.parse(String(init?.body)).file_name}`,
        });
      if (u.startsWith('https://up/')) return new Response(null, { status: 200 });
      if (u.startsWith('https://queue.fal.run/')) {
        bodies[u.slice('https://queue.fal.run/'.length)] = JSON.parse(String(init?.body));
        return Response.json({
          request_id: 'r',
          status_url: 'https://q/status',
          response_url: 'https://q/resp',
        });
      }
      if (u === 'https://q/status') return Response.json({ status: 'COMPLETED' });
      if (u === 'https://q/resp')
        return Response.json(
          { video: { url: 'https://cdn/out.mp4' } },
          { headers: { 'x-fal-billable-units': '5' } },
        );
      if (u === 'https://cdn/out.mp4') return new Response(new Uint8Array([1, 2, 3]));
      if (u.includes('/models/pricing')) return Response.json({ prices: [{ unit_price: 0.3 }] });
      throw new Error(`unexpected fetch ${u}`);
    });
    try {
      for (const f of ['video.mp4', 'a.png', 'b.png']) writeFileSync(path.join(dir, f), f);
      const fal = new FalProvider({ apiKey: 'test-key' });
      const base = {
        prompt: 'Replace the girl on the left.',
        video: { path: path.join(dir, 'video.mp4'), mimeType: 'video/mp4' },
        inputFrames: 120,
        inputSeconds: 5,
        images: ['a.png', 'b.png'].map((f) => ({ path: path.join(dir, f), mimeType: 'image/png' })),
        resolution: '360p' as const,
        aspectRatio: '16:9' as const,
      };
      const h3 = await fal.editVideo({ ...base, model: 'fal:minimax/h3-max/recast' });
      expect(bodies['minimax/h3-max/recast']).toEqual({
        prompt: 'Replace the girl on the left.',
        video_url: 'https://cdn/video.mp4',
        reference_image_urls: ['https://cdn/a.png', 'https://cdn/b.png'],
        resolution: '768P',
      });
      expect(h3.costUsd).toBeCloseTo(1.5);
      await fal.editVideo({ ...base, model: 'fal:fal-ai/wan/v2.7/edit-video', resolution: '1080p' });
      expect(bodies['fal-ai/wan/v2.7/edit-video']).toEqual({
        prompt: 'Replace the girl on the left.',
        video_url: 'https://cdn/video.mp4',
        reference_image_url: 'https://cdn/a.png',
        duration: 0,
        resolution: '1080p',
        audio_setting: 'origin',
      });
      await fal.editVideo({
        ...base,
        prompt: 'Replace the girl with the character shown in <IMAGE_REF_0> and <IMAGE_REF_1>.',
        inputSeconds: 3,
        model: 'fal:alibaba/wan-3.0/reference-to-video',
      });
      const wan3 = bodies['alibaba/wan-3.0/reference-to-video'] as Record<string, unknown>;
      expect(wan3).toMatchObject({
        reference_video_urls: ['https://cdn/video.mp4'],
        reference_image_urls: ['https://cdn/a.png', 'https://cdn/b.png'],
        duration: 3,
        resolution: '480p',
        aspect_ratio: '16:9',
        audio: false,
      });
      expect(wan3.prompt).toMatch(/^Video 1 is the original anime shot\./);
      expect(wan3.prompt).toContain('shown in Image 1 and Image 2.');
      expect(falVideoFamily('fal:alibaba/wan-3.0/reference-to-video')).toBe('wan-reference');
      await expect(
        fal.editVideo({ ...base, images: [], model: 'fal:minimax/h3-max/recast' }),
      ).rejects.toThrow(/reference image of each new character/);
      expect(falVideoFamily('fal:minimax/h3-max/recast')).toBe('h3-recast');
      expect(estimateVideoEditCost('fal:minimax/h3-max/recast', 1.2, '360p')).toBeCloseTo(1.5);
      expect(estimateVideoEditCost('fal:fal-ai/wan/v2.7/edit-video', 3, '720p')).toBeCloseTo(0.3);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('a flaky line to fal', () => {
  const down = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

  it('retries uploads and polling through network errors, and never resubmits a paid request mid-send', {
    timeout: 60_000,
  }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anirecast-fal-net-'));
    let initiate = 0;
    let submits = 0;
    let resetSubmit = false;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/storage/upload/initiate')) {
        initiate++;
        if (initiate <= 2) throw down('ECONNRESET');
        return Response.json({ upload_url: 'https://up/x', file_url: 'https://cdn/a.png' });
      }
      if (u.startsWith('https://up/')) return new Response(null, { status: 200 });
      if (u.startsWith('https://queue.fal.run/')) {
        submits++;
        if (resetSubmit) throw down('ECONNRESET');
        if (submits === 1) throw down('ENOTFOUND');
        void init;
        return Response.json({
          request_id: 'r',
          status_url: 'https://q/status',
          response_url: 'https://q/resp',
        });
      }
      if (u === 'https://q/status') return Response.json({ status: 'COMPLETED' });
      if (u === 'https://q/resp') return Response.json({ images: [{ url: 'https://cdn/out.png' }] });
      if (u === 'https://cdn/out.png')
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
      if (u.includes('/models/pricing')) return Response.json({ prices: [{ unit_price: 0.04 }] });
      throw new Error(`unexpected fetch ${u}`);
    });
    try {
      writeFileSync(path.join(dir, 'a.png'), 'a');
      const fal = new FalProvider({ apiKey: 'test-key' });
      const req = {
        model: 'fal:openai/gpt-image-2.5/sunburst/edit',
        prompt: 'p',
        images: [{ path: path.join(dir, 'a.png'), mimeType: 'image/png' }],
        aspectRatio: '16:9' as const,
        imageSize: '1K' as const,
      };
      const run = fal.generateImage(req);
      // Two upload resets and a submit that never connected (ENOTFOUND) were retried.
      await expect(run).resolves.toMatchObject({ provider: 'fal' });
      expect([initiate, submits]).toEqual([3, 2]);
      // A reset while submitting may have reached fal: not resent, but transient so the job is retried.
      resetSubmit = true;
      submits = 0;
      const again = fal.generateImage(req).catch((e: unknown) => e);
      expect(await again).toMatchObject({
        code: 'transient',
        message: expect.stringContaining('ECONNRESET'),
      });
      expect(submits).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
