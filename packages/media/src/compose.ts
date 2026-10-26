import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { exec } from './exec.ts';
import { type FfmpegRunOptions, ffmpeg } from './ffmpeg.ts';
import { probe } from './probe.ts';

const ensureDir = (file: string) => mkdirSync(path.dirname(file), { recursive: true });

/**
 * Scales a shot for upload, audio dropped. Timing is untouched; with `frameStep` the last frame is repeated
 * until the count is a multiple of it (Omni returns whole groups of 4 frames), and conform trims them again.
 */
export async function scaleForUpload(
  input: string,
  output: string,
  height: number,
  opts: FfmpegRunOptions & {
    frameStep?: number;
    minFrames?: number;
    /** Restamp every frame to this rate (no frame dropped or repeated), for models with a minimum rate. */
    fps?: number;
  } = {},
): Promise<{ frames: number; padded: number }> {
  ensureDir(output);
  const { frameStep, minFrames, fps, ...run } = opts;
  const frames = (await probe(input, { countFrames: true, ...(run.signal ? { signal: run.signal } : {}) }))
    .frameCount;
  // Hold the last frame to reach a model's minimum length, then to its frame step.
  const long = Math.max(frames, minFrames ?? 0);
  const padded = long - frames + (frameStep ? (frameStep - (long % frameStep)) % frameStep : 0);
  const pad = padded > 0 ? `,tpad=stop_mode=clone:stop=${padded}` : '';
  const restamp = fps ? `,setpts=N/(${fps}*TB)` : '';
  await ffmpeg(
    [
      '-i',
      input,
      '-an',
      '-vf',
      `scale=-2:${height}:flags=lanczos,format=yuv420p${pad}${restamp}`,
      // Restamped frames already sit on the new rate, so cfr neither drops nor repeats any.
      ...(fps ? ['-fps_mode', 'cfr', '-r', String(fps)] : ['-fps_mode', 'passthrough']),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '16',
      output,
    ],
    run,
  );
  return { frames, padded };
}

export interface ConformSpec {
  frames: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  /**
   * Frames the generated clip may differ by at its end: extra frames are cut, missing ones repeat the last
   * frame. 0 (default) makes any mismatch a hard failure.
   */
  endTolerance?: number;
}

export interface ConformResult {
  framesIn: number;
  framesOut: number;
  /** framesOut − framesIn when it was absorbed at the end: positive = cut, negative = last frame repeated. */
  endAdjust: number;
  sourceFps: string;
  sourceSize: string;
}

/**
 * Brings a generated clip back onto the clip's timeline: verifies the frame count first (beyond
 * `endTolerance` a mismatch is a hard failure), restamps to the clip rate, scales to the tier size, drops audio.
 */
export async function conformTake(
  raw: string,
  output: string,
  spec: ConformSpec,
  opts: FfmpegRunOptions = {},
): Promise<ConformResult> {
  const p = await probe(raw, { countFrames: true, ...(opts.signal ? { signal: opts.signal } : {}) });
  const endAdjust = p.frameCount - spec.frames;
  if (Math.abs(endAdjust) > (spec.endTolerance ?? 0)) {
    throw new AniError(
      'provider_rejected',
      `Generated clip has ${p.frameCount} frames, the shot has ${spec.frames}`,
      {
        hint: 'conform_mismatch: regenerate this take; takes are never stretched, only trimmed or held at the end.',
        details: { conform_mismatch: true, framesIn: spec.frames, framesOut: p.frameCount },
      },
    );
  }
  ensureDir(output);
  const rate = `${spec.fpsNum}/${spec.fpsDen}`;
  await ffmpeg(
    [
      '-i',
      raw,
      '-an',
      '-vf',
      `setpts=N/(${rate}*TB)${endAdjust < 0 ? `,tpad=stop_mode=clone:stop=${-endAdjust}` : ''},scale=${spec.width}:${spec.height}:flags=lanczos,setsar=1,format=yuv420p`,
      '-fps_mode',
      'cfr',
      '-r',
      rate,
      '-frames:v',
      String(spec.frames),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '16',
      output,
    ],
    { ...opts, totalFrames: spec.frames },
  );
  return {
    framesIn: spec.frames,
    framesOut: p.frameCount,
    endAdjust,
    sourceFps: `${p.fpsNum}/${p.fpsDen}`,
    sourceSize: `${p.width}x${p.height}`,
  };
}

export interface TimeConformSpec {
  /** Frames of the shot (the start of the upload; anything after was padding). */
  frames: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  /** Length of what was uploaded, padding included. */
  inputSeconds: number;
  /** How far the output length may differ from the input before it counts as a different take (0.2 = ±20%). */
  tolerance?: number;
}

export interface TimeConformResult {
  framesIn: number;
  framesOut: number;
  /** Output seconds / input seconds before scaling (1 = same length). */
  speed: number;
  sourceFps: string;
  sourceSize: string;
}

/**
 * For models with their own frame rate and timing (Seedance, H3, Wan): scales the output to the uploaded
 * length (within `tolerance`), resamples it by time to the clip rate and keeps the first `frames` frames — the
 * shot; padding held at the end of the upload is dropped. Fails beyond the tolerance rather than warping.
 */
export async function conformByTime(
  raw: string,
  output: string,
  spec: TimeConformSpec,
  opts: FfmpegRunOptions = {},
): Promise<TimeConformResult> {
  const p = await probe(raw, { countFrames: true, ...(opts.signal ? { signal: opts.signal } : {}) });
  const outSeconds = p.durationMs / 1000 || p.frameCount / (p.fpsNum / p.fpsDen);
  const speed = outSeconds / spec.inputSeconds;
  if (!(outSeconds > 0) || Math.abs(speed - 1) > (spec.tolerance ?? 0.2)) {
    throw new AniError(
      'provider_rejected',
      `Generated clip is ${outSeconds.toFixed(2)} s, the upload was ${spec.inputSeconds.toFixed(2)} s`,
      {
        hint: 'conform_mismatch: the model changed the length too much to line up with the shot; regenerate or use another model.',
        details: { conform_mismatch: true, framesIn: spec.frames, framesOut: p.frameCount, speed },
      },
    );
  }
  ensureDir(output);
  const rate = `${spec.fpsNum}/${spec.fpsDen}`;
  await ffmpeg(
    [
      '-i',
      raw,
      '-an',
      '-vf',
      // Rescale time to the upload length, resample to the clip rate, hold the end if rounding left it short.
      `setpts=(PTS-STARTPTS)/${speed},fps=${rate},tpad=stop_mode=clone:stop=${spec.frames},scale=${spec.width}:${spec.height}:flags=lanczos,setsar=1,format=yuv420p`,
      '-fps_mode',
      'cfr',
      '-r',
      rate,
      '-frames:v',
      String(spec.frames),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '16',
      output,
    ],
    { ...opts, totalFrames: spec.frames },
  );
  return {
    framesIn: spec.frames,
    framesOut: p.frameCount,
    speed: Number(speed.toFixed(4)),
    sourceFps: `${p.fpsNum}/${p.fpsDen}`,
    sourceSize: `${p.width}x${p.height}`,
  };
}

/**
 * A still image as a clip of exactly `frames` frames at the clip rate and the given size, with a slow push-in
 * (4% by default) so it does not read as a frozen frame. For shots that keep the approved board instead of a
 * generated video.
 */
export async function stillClip(
  image: string,
  output: string,
  spec: { frames: number; fpsNum: number; fpsDen: number; width: number; height: number; zoom?: number },
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  const rate = `${spec.fpsNum}/${spec.fpsDen}`;
  const { width: w, height: h, frames } = spec;
  const zoom = spec.zoom ?? 0.04;
  await ffmpeg(
    [
      '-i',
      image,
      '-an',
      '-vf',
      // Work at twice the size so the zoom moves in sub-pixel steps instead of jittering.
      `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},` +
        `zoompan=z='1+${zoom}*on/${Math.max(1, frames - 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
        `:d=${frames}:s=${w}x${h}:fps=${rate},setsar=1,format=yuv420p`,
      '-frames:v',
      String(frames),
      '-r',
      rate,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '16',
      output,
    ],
    { ...opts, totalFrames: frames },
  );
}

/**
 * Four frames across one cut in a row: the end of shot A, a red bar where the cut is, the start of shot B.
 * Frames must share a height (extract them at the same width from one clip).
 */
export async function boundarySheet(
  frames: [string, string, string, string],
  output: string,
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  await ffmpeg(
    [
      ...frames.flatMap((f) => ['-i', f]),
      '-filter_complex',
      '[0][1]hstack=inputs=2[a];[2][3]hstack=inputs=2[b];[a]pad=iw+16:ih:0:0:color=red[ap];[ap][b]hstack=inputs=2',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      output,
    ],
    opts,
  );
}

export interface RenderSegment {
  file: string;
  frames: number;
}

/**
 * Concatenates per-shot segments at a uniform size and rate, muxes the master audio, and optionally marks
 * the frame as a draft with a corner block (no font dependency).
 */
export async function renderSequence(
  segments: RenderSegment[],
  audio: string,
  output: string,
  spec: Omit<ConformSpec, 'frames'> & { draftMark?: boolean },
  opts: FfmpegRunOptions = {},
): Promise<number> {
  if (segments.length === 0) throw new AniError('usage', 'Nothing to render');
  ensureDir(output);
  const rate = `${spec.fpsNum}/${spec.fpsDen}`;
  const inputs = segments.flatMap((s) => ['-i', s.file]);
  const chains = segments.map(
    (s, i) =>
      `[${i}:v]trim=end_frame=${s.frames},setpts=N/(${rate}*TB),scale=${spec.width}:${spec.height}:flags=lanczos,setsar=1,format=yuv420p[v${i}]`,
  );
  const total = segments.reduce((n, s) => n + s.frames, 0);
  let graph = `${chains.join(';')};${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[cat]`;
  graph += spec.draftMark
    ? `;[cat]drawbox=x=iw-iw/12:y=0:w=iw/12:h=ih/24:color=red@0.85:t=fill[v]`
    : ';[cat]null[v]';
  await ffmpeg(
    [
      ...inputs,
      '-i',
      audio,
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      `${segments.length}:a`,
      '-fps_mode',
      'cfr',
      '-r',
      rate,
      '-frames:v',
      String(total),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '17',
      '-af',
      'apad',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-shortest',
      '-movflags',
      '+faststart',
      output,
    ],
    { ...opts, totalFrames: total },
  );
  // AAC padding used to end the file a frame early under -shortest; count what was actually written.
  const written = (
    await probe(output, { countFrames: true, ...(opts.signal ? { signal: opts.signal } : {}) })
  ).frameCount;
  if (written !== total) throw new AniError('internal', `Render wrote ${written} frames, expected ${total}`);
  return written;
}

/**
 * Two clips of the same length side by side (`h`, the exported comparison) or stacked (`v`, the proxy the
 * web slider crops from, so both halves always come from the same decoded frame).
 */
export async function stackCompare(
  original: string,
  edited: string,
  output: string,
  {
    layout,
    height,
    audioFrom,
    crf = 20,
  }: { layout: 'h' | 'v'; height: number; audioFrom?: string; crf?: number },
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  const stack = layout === 'h' ? 'hstack' : 'vstack';
  await ffmpeg(
    [
      '-i',
      original,
      '-i',
      edited,
      ...(audioFrom ? ['-i', audioFrom] : []),
      '-filter_complex',
      `[0:v]scale=-2:${height},setsar=1[a];[1:v]scale=-2:${height},setsar=1[b];[a][b]${stack}=inputs=2,format=yuv420p[v]`,
      '-map',
      '[v]',
      ...(audioFrom ? ['-map', '2:a', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : ['-an']),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(crf),
      '-g',
      '12',
      '-movflags',
      '+faststart',
      output,
    ],
    opts,
  );
}

/**
 * A still contact sheet of a stacked (original over edited) clip: `count` evenly spaced frames in a row,
 * so an agent that cannot watch video can still judge motion and identity.
 */
export async function contactSheet(
  stacked: string,
  output: string,
  frames: number,
  count = 5,
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  const step = Math.max(1, Math.floor(frames / count));
  await ffmpeg(
    [
      '-i',
      stacked,
      '-vf',
      `select='not(mod(n\\,${step}))',scale=-2:540,tile=${count}x1`,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      output,
    ],
    opts,
  );
}

/**
 * Grid of crops for a reviewer: each row is one group (e.g. one cast member), every cell letterboxed to
 * `cell`×`cell`. Rows are padded with dark cells so they line up.
 */
export async function cropGrid(
  rows: string[][],
  output: string,
  { cell = 180, maxPerRow = 6 }: { cell?: number; maxPerRow?: number } = {},
  opts: FfmpegRunOptions = {},
): Promise<void> {
  const trimmed = rows.map((r) => r.slice(0, maxPerRow)).filter((r) => r.length > 0);
  if (trimmed.length === 0) throw new AniError('usage', 'No crops to lay out');
  ensureDir(output);
  const width = Math.max(...trimmed.map((r) => r.length));
  const inputs: string[] = [];
  const chains: string[] = [];
  const rowLabels: string[] = [];
  let n = 0;
  for (const [ri, row] of trimmed.entries()) {
    const cells: string[] = [];
    for (const file of row) {
      inputs.push('-i', file);
      chains.push(
        `[${n}:v]scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=0x202020,setsar=1,format=yuv420p[c${n}]`,
      );
      cells.push(`[c${n}]`);
      n++;
    }
    for (let k = row.length; k < width; k++) {
      chains.push(`color=c=0x101010:size=${cell}x${cell}:d=1,format=yuv420p[e${ri}_${k}]`);
      cells.push(`[e${ri}_${k}]`);
    }
    chains.push(
      cells.length > 1 ? `${cells.join('')}hstack=inputs=${cells.length}[r${ri}]` : `${cells[0]}null[r${ri}]`,
    );
    rowLabels.push(`[r${ri}]`);
  }
  chains.push(
    rowLabels.length > 1
      ? `${rowLabels.join('')}vstack=inputs=${rowLabels.length}[out]`
      : `${rowLabels[0]}null[out]`,
  );
  await ffmpeg(
    [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '3', output],
    opts,
  );
}

/**
 * One reference image made of several (a design sheet and an expression sheet, three storyboard frames), laid out
 * by shape so nothing is letterboxed: landscape images stacked at full width, portrait ones side by side at full
 * height, a mix in square cells.
 */
export async function composeReference(
  files: string[],
  output: string,
  { size = 1280 }: { size?: number } = {},
  opts: FfmpegRunOptions = {},
): Promise<void> {
  if (files.length === 0) throw new AniError('usage', 'No images to compose');
  const shapes = await Promise.all(files.map((f) => probe(f)));
  const landscape = shapes.every((s) => s.width >= s.height);
  const portrait = shapes.every((s) => s.height > s.width);
  if (!landscape && !portrait) {
    await cropGrid(
      [files.slice(0, 2), files.slice(2, 4)].filter((r) => r.length),
      output,
      { cell: Math.round(size / 2), maxPerRow: 2 },
      opts,
    );
    return;
  }
  ensureDir(output);
  const inputs = files.flatMap((f) => ['-i', f]);
  const even = (expr: string) => `trunc(${expr}/2)*2`;
  const chains = files.map((_, i) =>
    landscape
      ? `[${i}:v]scale=${size}:${even(`${size}*ih/iw`)},setsar=1,format=yuv420p[c${i}]`
      : `[${i}:v]scale=${even(`${size}*iw/ih`)}:${size},setsar=1,format=yuv420p[c${i}]`,
  );
  const cells = files.map((_, i) => `[c${i}]`).join('');
  chains.push(
    files.length > 1
      ? `${cells}${landscape ? 'vstack' : 'hstack'}=inputs=${files.length}[out]`
      : `${cells}null[out]`,
  );
  await ffmpeg(
    [...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '3', output],
    opts,
  );
}

/**
 * Puts `part` (exactly end − start + 1 frames) in place of frames start–end of `base`, keeping every other frame:
 * a partial take redoes only what the human rejected.
 */
export async function spliceRange(
  base: string,
  part: string,
  output: string,
  {
    start,
    end,
    frames,
    fpsNum,
    fpsDen,
  }: { start: number; end: number; frames: number; fpsNum: number; fpsDen: number },
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  const rate = `${fpsNum}/${fpsDen}`;
  const pieces: string[] = [];
  const graph: string[] = [];
  if (start > 0) {
    graph.push(`[0:v]trim=start_frame=0:end_frame=${start},setpts=PTS-STARTPTS[a]`);
    pieces.push('[a]');
  }
  graph.push(`[1:v]trim=start_frame=0:end_frame=${end - start + 1},setpts=PTS-STARTPTS[b]`);
  pieces.push('[b]');
  if (end < frames - 1) {
    graph.push(`[0:v]trim=start_frame=${end + 1},setpts=PTS-STARTPTS[c]`);
    pieces.push('[c]');
  }
  graph.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=0,setsar=1,format=yuv420p[v]`);
  await ffmpeg(
    [
      '-i',
      base,
      '-i',
      part,
      '-filter_complex',
      graph.join(';'),
      '-map',
      '[v]',
      '-an',
      '-fps_mode',
      'cfr',
      '-r',
      rate,
      '-frames:v',
      String(frames),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '12',
      output,
    ],
    { ...opts, totalFrames: frames },
  );
}

/**
 * Mean luma PSNR (dB) between frames [from, from + count) of two clips; Infinity when identical. A re-encode of
 * the same frames scores well above 40, a shifted or different frame far below.
 */
export async function rangePsnr(
  a: string,
  b: string,
  { from, count }: { from: number; count: number },
  opts: FfmpegRunOptions = {},
): Promise<number> {
  const trim = `trim=start_frame=${from}:end_frame=${from + count},setpts=PTS-STARTPTS`;
  const { stderr } = await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      `[0:v]${trim}[x];[1:v]${trim}[y];[x][y]psnr`,
      '-f',
      'null',
      '-',
    ],
    opts.signal ? { signal: opts.signal } : {},
  );
  const m = /PSNR y:(inf|[\d.]+)/.exec(stderr);
  if (!m) throw new AniError('internal', 'ffmpeg printed no PSNR');
  return m[1] === 'inf' ? Number.POSITIVE_INFINITY : Number(m[1]);
}
