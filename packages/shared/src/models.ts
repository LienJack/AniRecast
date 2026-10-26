/**
 * Model ids name their backend: `fal:<endpoint>` (fal.ai), `jev:<model>` (the OpenAI-compatible JEV router),
 * anything else Gemini. Kept here because both the planner (core) and the adapters (providers) need it.
 */
export const isFalModel = (model: string): boolean => model.startsWith('fal:');

/** fal's Gemini Omni `edit` endpoint takes the video and a prompt only, no reference images. */
export const isTextOnlyVideoModel = (model: string): boolean =>
  isFalModel(model) && /gemini-omni/.test(model) && model.endsWith('/edit');

/**
 * Selectable models. Video models are all video-to-video edits: the shot goes in, the same shot comes out with
 * the character replaced. They differ in what they take and how their output lines up with the shot.
 */
export interface ImageModelSpec {
  id: string;
  label: string;
  note: string;
  /** Reference images per request. */
  maxRefs: number;
}

export type VideoTiming = 'frames' | 'time';

export interface VideoModelSpec {
  id: string;
  label: string;
  note: string;
  /** Reference images it takes (the storyboard frame, the character design); 0 = prompt and video only. */
  minRefs: number;
  maxRefs: number;
  /** Which references suit it best: the storyboard frame, or one image per new character. */
  refStyle: 'any' | 'board' | 'per-character';
  /** Input length limits. Shorter shots are padded by holding the last frame; the padding is cut off again. */
  minSeconds: number;
  maxSeconds: number;
  /** Output comes in groups of this many frames (Omni: 4); uploads are padded to the step. */
  frameStep: number;
  /** The model only makes whole seconds (Wan 3.0): uploads are padded to the next whole second. */
  wholeSeconds?: boolean;
  /**
   * `frames`: output frame i is input frame i, conformed by count. `time`: the output has its own frame rate
   * (and maybe a slightly different length); it is scaled to the input length (±20%) and resampled to the shot.
   */
  timing: VideoTiming;
}

export const IMAGE_MODELS: readonly ImageModelSpec[] = [
  {
    id: 'gemini-nano-banana-2.1',
    label: 'Nano Banana 2.1',
    note: 'Google 直連；約 USD 0.05／張（2K）',
    maxRefs: 14,
  },
  {
    id: 'fal:openai/gpt-image-2.5/sunburst/edit',
    label: 'GPT Image 2.5 Sunburst',
    note: 'fal；最多 16 張參考圖；約 USD 0.04–0.06／張',
    maxRefs: 16,
  },
];

export const VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: 'gemini-omni-1.1-flash',
    label: 'Gemini Omni Flash 1.1',
    note: 'Google 直連；幀數最準（4 幀一組）；每日 100 次配額；約 USD 0.03／秒（360p）',
    minRefs: 0,
    maxRefs: 10,
    refStyle: 'any',
    minSeconds: 0,
    maxSeconds: 10,
    frameStep: 4,
    timing: 'frames',
  },
  {
    id: 'fal:bytedance/seedance-2.5/us/reference-to-video',
    label: 'Seedance 2.5',
    note: 'fal；輸入至少 1.8 秒（短的會補尾再剪掉）；最低 480p；約 USD 0.3／秒（含輸入秒數）',
    minRefs: 0,
    maxRefs: 9,
    refStyle: 'any',
    minSeconds: 2,
    maxSeconds: 15,
    frameStep: 1,
    timing: 'time',
  },
  {
    id: 'fal:minimax/h3-max/recast',
    label: 'MiniMax H3（Max Recast）',
    note: 'fal；每個新角色一張參考圖（最多 4）；輸入至少 5 秒（短的會補尾）；偏寫實；768P 約 USD 0.30／秒',
    minRefs: 1,
    maxRefs: 4,
    refStyle: 'per-character',
    minSeconds: 5,
    maxSeconds: 15,
    frameStep: 1,
    timing: 'time',
  },
  {
    id: 'fal:alibaba/wan-3.0/reference-to-video',
    label: 'Wan 3.0（reference-to-video）',
    note: 'fal；以原片為參考影片重新生成（不是逐幀編輯）；分鏡圖＋角色圖；長度補到整秒再剪回；輸入秒數也計費，480p 約 USD 0.10／秒',
    minRefs: 0,
    maxRefs: 9,
    refStyle: 'any',
    minSeconds: 2,
    maxSeconds: 15,
    frameStep: 1,
    wholeSeconds: true,
    timing: 'time',
  },
  {
    id: 'fal:fal-ai/wan/v2.7/edit-video',
    label: 'Wan 2.7 Edit',
    note: 'fal；真正的逐幀影片編輯；一張參考圖（分鏡圖）；輸入至少 2 秒；720p 約 USD 0.10／秒',
    minRefs: 0,
    maxRefs: 1,
    refStyle: 'board',
    minSeconds: 2,
    maxSeconds: 10,
    frameStep: 1,
    timing: 'time',
  },
];

/** How long the upload must be for a shot of `seconds`: the model's minimum, then whole seconds if it needs them. */
export function uploadSeconds(spec: VideoModelSpec, seconds: number): number {
  const s = Math.max(seconds, spec.minSeconds);
  return spec.wholeSeconds ? Math.ceil(s - 1e-6) : s;
}

/** The spec of a video model; unknown ids get a cautious default for their backend. */
export function videoModelSpec(model: string): VideoModelSpec {
  const known = VIDEO_MODELS.find((m) => m.id === model);
  if (known) return known;
  const omni = /omni/.test(model);
  return {
    id: model,
    label: model,
    note: '',
    minRefs: 0,
    maxRefs: isTextOnlyVideoModel(model) ? 0 : 10,
    refStyle: 'any',
    minSeconds: isFalModel(model) && !omni ? 2 : 0,
    maxSeconds: 10,
    frameStep: omni ? 4 : 1,
    timing: omni ? 'frames' : 'time',
  };
}

export const imageModelSpec = (model: string): ImageModelSpec =>
  IMAGE_MODELS.find((m) => m.id === model) ?? { id: model, label: model, note: '', maxRefs: 14 };
