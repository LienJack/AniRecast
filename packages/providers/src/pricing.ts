import { FAL_PREFIX, falVideoFamily } from './fal.ts';
import { CNY_PER_USD, JEV_PREFIX } from './jev.ts';
import type { ImageSize, Usage, VideoResolution } from './types.ts';

/** USD per 1M tokens, from ai.google.dev pricing (checked 2026-10-25; Flash prices rise 2027-01-01). */
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  'gemini-omni-1.1-flash': { input: 1.5, output: 17.5 },
  'gemini-omni-flash-preview': { input: 1.5, output: 17.5 },
  'gemini-nano-banana-2.1': { input: 1.5, output: 0 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
};

/** Per-image output price for Nano Banana 2.1. */
export const IMAGE_PRICE: Record<ImageSize, number> = { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 };

/**
 * Omni output tokens per second. 360p, 720p and 1080p are measured (2026-10-25: 1,931, 5,792
 * and 8,680); 4k is not measured yet and reuses 1080p as a floor. 480p is rejected by the API.
 */
export const OMNI_OUTPUT_TOKENS_PER_SECOND: Record<VideoResolution, number> = {
  '360p': 1931,
  '480p': 1931,
  '720p': 5792,
  '1080p': 8680,
  '4k': 8680,
};
/** Uploaded video input tokens per second, measured by input height (360p: 1,786; 720p: 5,851). */
export function omniInputTokensPerSecond(inputHeight: number): number {
  return inputHeight <= 400 ? 1786 : 5851;
}
export const OMNI_INPUT_TOKENS_PER_SECOND = 5851;

export function tokenCost(model: string, usage: Pick<Usage, 'inputTokens' | 'outputTokens'>): number {
  const price = TOKEN_PRICES[model] ?? { input: 1.5, output: 17.5 };
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export function imageCost(model: string, size: ImageSize, inputTokens: number): number {
  return IMAGE_PRICE[size] + tokenCost(model, { inputTokens, outputTokens: 0 });
}

/** fal list prices (USD, checked 2026-10-25): Omni edit per output second, Seedance 2.5 per 1000 tokens. */
const FAL_OMNI_PER_SECOND = 0.03;
const FAL_SEEDANCE_PER_1K_TOKENS = 0.0214;
const SEEDANCE_SIZE: Record<string, [number, number]> = {
  '480p': [854, 480],
  '720p': [1280, 720],
  '1080p': [1920, 1080],
};

/**
 * Seedance bills width × height × 24 fps × seconds / 1024 tokens, at least 4 s of output, plus the reference
 * video at 0.6× (fal, 2026-10). 360p requests run at 480p.
 */
function seedanceEstimate(seconds: number, resolution: VideoResolution): number {
  const [w, h] = SEEDANCE_SIZE[
    resolution === '360p' ? '480p' : resolution === '4k' ? '1080p' : resolution
  ] ?? [854, 480];
  const perSecond = (w * h * 24) / 1024;
  const tokens = Math.max(4, seconds) * perSecond + seconds * perSecond * 0.6;
  return (tokens / 1000) * FAL_SEEDANCE_PER_1K_TOKENS;
}

export function estimateVideoEditCost(
  model: string,
  seconds: number,
  resolution: VideoResolution,
  refImages = 2,
  inputHeight = 720,
): number {
  if (model.startsWith(FAL_PREFIX)) {
    const family = falVideoFamily(model);
    const high = resolution === '1080p' || resolution === '4k';
    // Per output second (fal pricing, 2026-10-25): H3 Recast 768P 0.30 / 1080P 0.45, Wan 2.7 edit 0.10 / 0.15.
    if (family === 'h3-recast') return Math.max(5, seconds) * (high ? 0.45 : 0.3);
    if (family === 'wan-edit') return Math.max(2, seconds) * (high ? 0.15 : 0.1);
    // Wan 3.0 reference-to-video bills the reference video's seconds as well as the output's.
    if (family === 'wan-reference')
      return 2 * Math.max(2, Math.ceil(seconds)) * (high ? 0.2 : resolution === '720p' ? 0.1 : 0.05);
    return family === 'seedance-reference'
      ? seedanceEstimate(seconds, resolution)
      : Math.max(1, seconds) * FAL_OMNI_PER_SECOND;
  }
  const inputTokens = seconds * omniInputTokensPerSecond(inputHeight) + refImages * 1100 + 200;
  const outputTokens = seconds * OMNI_OUTPUT_TOKENS_PER_SECOND[resolution];
  return tokenCost(model, { inputTokens, outputTokens });
}

export function estimateImageCost(model: string, size: ImageSize, refImages: number): number {
  // GPT Image 2.5 on fal bills per request in USD units; observed around 0.1–0.2 at high quality.
  if (model.startsWith(FAL_PREFIX)) return 0.25;
  return imageCost(model, size, refImages * 1120 + 200);
}

export function estimateVisionCost(model: string, images: number): number {
  // JEV router prices are CNY per 1M tokens; gemini-3.8-flash there is 5.25 in / 26.25 out.
  if (model.startsWith(JEV_PREFIX))
    return ((images * 1100 + 800) * 5.25 + 600 * 26.25) / 1_000_000 / CNY_PER_USD;
  return tokenCost(model, { inputTokens: images * 1100 + 800, outputTokens: 1500 });
}
