import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, probe } from '@anirecast/media';
import { estimateImageCost, estimateVideoEditCost, estimateVisionCost } from './pricing.ts';
import type {
  ImageGenRequest,
  ImageGenResult,
  Provider,
  VideoEditRequest,
  VideoEditResult,
  VisionRequest,
  VisionResult,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts';

const RESOLUTION_HEIGHT: Record<string, number> = {
  '360p': 360,
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '4k': 2160,
};

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anirecast-fake-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface FakeOptions {
  /** Canned structured output for analyzeImages, keyed on the request. */
  vision?: (req: VisionRequest) => unknown;
  /** Canned answer for searchWeb. */
  webSearch?: (req: WebSearchRequest) => { text: string; sources: Array<{ title: string; url: string }> };
}

/**
 * Offline stand-in for Gemini: hue-shifts inputs with ffmpeg so outputs are visibly "generated",
 * keeps the input frame count exactly, and costs nothing. Used by tests and by dev runs past the budget.
 */
export class FakeProvider implements Provider {
  readonly name = 'fake' as const;
  private readonly options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
    const t0 = Date.now();
    const data = await withTemp(async (dir) => {
      const out = path.join(dir, 'out.png');
      const first = req.images[0];
      const args = first
        ? ['-i', first.path, '-frames:v', '1', '-vf', 'hue=h=120:s=1.3,scale=1376:-2', out]
        : ['-f', 'lavfi', '-i', 'color=c=0x6040a0:size=1376x768', '-frames:v', '1', out];
      await ffmpeg(args, req.signal ? { signal: req.signal } : {});
      return readFile(out);
    });
    return {
      data,
      mimeType: 'image/png',
      provider: this.name,
      model: req.model,
      usage: { inputTokens: req.images.length * 1120, outputTokens: 1120 },
      costUsd: 0,
      latencyMs: Date.now() - t0,
      remote: { interactionId: `fake-${Date.now()}` },
    };
  }

  async editVideo(req: VideoEditRequest): Promise<VideoEditResult> {
    const t0 = Date.now();
    req.onStatus?.('generating (fake)');
    const height = RESOLUTION_HEIGHT[req.resolution] ?? 720;
    const data = await withTemp(async (dir) => {
      const out = path.join(dir, 'out.mp4');
      const src = await probe(req.video.path);
      await ffmpeg(
        [
          '-i',
          req.video.path,
          '-an',
          '-vf',
          `setpts=N/(24*TB),hue=h=150:s=1.4,scale=-2:${height},format=yuv420p`,
          '-fps_mode',
          'cfr',
          '-r',
          '24',
          '-frames:v',
          String(src.frameCount),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          out,
        ],
        req.signal ? { signal: req.signal } : {},
      );
      return readFile(out);
    });
    return {
      data,
      mimeType: 'video/mp4',
      provider: this.name,
      model: req.model,
      usage: {
        inputTokens: Math.round(req.inputSeconds * 5851),
        outputTokens: Math.round(req.inputSeconds * 5792),
      },
      costUsd: 0,
      latencyMs: Date.now() - t0,
      remote: { interactionId: `fake-${Date.now()}`, fileUri: `fake://${path.basename(req.video.path)}` },
    };
  }

  async searchWeb(req: WebSearchRequest): Promise<WebSearchResult> {
    const answer = this.options.webSearch?.(req) ?? { text: '', sources: [] };
    return {
      ...answer,
      provider: this.name,
      model: req.model,
      usage: { inputTokens: 100, outputTokens: 100 },
      costUsd: 0,
      latencyMs: 1,
      remote: {},
    };
  }

  async analyzeImages<T>(req: VisionRequest): Promise<VisionResult<T>> {
    return {
      data: (this.options.vision?.(req) ?? {}) as T,
      provider: this.name,
      model: req.model,
      usage: { inputTokens: req.images.length * 1100, outputTokens: 500 },
      costUsd: 0,
      latencyMs: 1,
      remote: {},
    };
  }
}

/** What the real call would have cost, so budgets and estimates can be exercised offline. */
export const fakeEstimates = { estimateImageCost, estimateVideoEditCost, estimateVisionCost };
