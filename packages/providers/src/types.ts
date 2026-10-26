export type Tier = 'draft' | 'preview' | 'final';
export type VideoResolution = '360p' | '480p' | '720p' | '1080p' | '4k';
export type ImageSize = '1K' | '2K' | '4K';

export interface LocalMedia {
  path: string;
  mimeType: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Raw usage object from the provider, kept for the ledger. */
  raw?: unknown;
}

export interface ProviderCallMeta {
  provider: string;
  model: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  /** Remote ids are a cache (files expire ~48h); every request is reproducible from local inputs. */
  remote: { interactionId?: string; fileUri?: string };
}

export interface ImageGenRequest {
  model: string;
  prompt: string;
  images: LocalMedia[];
  aspectRatio: '16:9' | '9:16' | '1:1';
  imageSize: ImageSize;
  previousInteractionId?: string;
  signal?: AbortSignal;
}

export interface ImageGenResult extends ProviderCallMeta {
  data: Buffer;
  mimeType: string;
}

export interface VideoEditRequest {
  model: string;
  prompt: string;
  video: LocalMedia;
  /** Frame count of the input, used to verify and to estimate cost. */
  inputFrames: number;
  inputSeconds: number;
  images: LocalMedia[];
  resolution: VideoResolution;
  aspectRatio: '16:9' | '9:16';
  /** Reuse an uploaded file while it is still valid. */
  cachedFileUri?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

export interface VideoEditResult extends ProviderCallMeta {
  data: Buffer;
  mimeType: 'video/mp4';
}

export interface VisionRequest {
  model: string;
  prompt: string;
  images: LocalMedia[];
  /** JSON schema for structured output. */
  responseSchema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface VisionResult<T> extends ProviderCallMeta {
  data: T;
}

export interface WebSearchRequest {
  model: string;
  /** What to look for, in words; the model searches and answers with its sources. */
  query: string;
  signal?: AbortSignal;
}

export interface WebSearchResult extends ProviderCallMeta {
  text: string;
  /** Pages the answer was grounded on (may be redirect links that resolve to the real page). */
  sources: Array<{ title: string; url: string }>;
}

export interface Provider {
  /** `router` dispatches by model prefix to gemini, fal or jev; `fake` runs offline at no cost. */
  readonly name: 'gemini' | 'fake' | 'fal' | 'jev' | 'router';
  /** Which backend serves a model (for the request log); single-backend providers return their name. */
  backendFor?(model: string): string;
  generateImage(req: ImageGenRequest): Promise<ImageGenResult>;
  editVideo(req: VideoEditRequest): Promise<VideoEditResult>;
  analyzeImages<T>(req: VisionRequest): Promise<VisionResult<T>>;
  /** Web search with sources (Gemini + Google Search); not every backend has it. */
  searchWeb?(req: WebSearchRequest): Promise<WebSearchResult>;
}

/** Omni has no 480p (the API rejects it, verified 2026-10-25), so draft is 360p in and out. */
export const TIER_RESOLUTION: Record<Tier, VideoResolution> = {
  draft: '360p',
  preview: '720p',
  final: '1080p',
};
/** Upload height per tier; input tokens scale with it. Final sends the shot at 1080 (every video is 1080p). */
export const TIER_UPLOAD_HEIGHT: Record<Tier, number> = { draft: 360, preview: 720, final: 1080 };
/** Conformed output size per tier. */
export const TIER_SIZE: Record<Tier, { width: number; height: number }> = {
  draft: { width: 640, height: 360 },
  preview: { width: 1280, height: 720 },
  final: { width: 1920, height: 1080 },
};

export const mimeFor = (file: string): string => {
  const ext = file.toLowerCase().split('.').pop();
  return ext === 'png'
    ? 'image/png'
    : ext === 'webp'
      ? 'image/webp'
      : ext === 'mp4'
        ? 'video/mp4'
        : 'image/jpeg';
};
