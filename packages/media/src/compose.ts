import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { type FfmpegRunOptions, ffmpeg } from './ffmpeg.ts';
import { probe } from './probe.ts';

const ensureDir = (file: string) => mkdirSync(path.dirname(file), { recursive: true });

/** Scales a shot for upload; frame count and timing are untouched, audio dropped. */
export async function scaleForUpload(
  input: string,
  output: string,
  height: number,
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  await ffmpeg(
    [
      '-i',
      input,
      '-an',
      '-vf',
      `scale=-2:${height}:flags=lanczos,format=yuv420p`,
      '-fps_mode',
      'passthrough',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '16',
      output,
    ],
    opts,
  );
}

export interface ConformSpec {
  frames: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
}

export interface ConformResult {
  framesIn: number;
  framesOut: number;
  sourceFps: string;
  sourceSize: string;
}

/**
 * Brings a generated clip back onto the clip's timeline: verifies the frame count first (a mismatch is a
 * hard failure, never silently padded), restamps to the clip rate, scales to the tier size, drops audio.
 */
export async function conformTake(
  raw: string,
  output: string,
  spec: ConformSpec,
  opts: FfmpegRunOptions = {},
): Promise<ConformResult> {
  const p = await probe(raw, { countFrames: true, ...(opts.signal ? { signal: opts.signal } : {}) });
  if (p.frameCount !== spec.frames) {
    throw new AniError(
      'provider_rejected',
      `Generated clip has ${p.frameCount} frames, the shot has ${spec.frames}`,
      {
        hint: 'conform_mismatch: regenerate this take; mismatched takes are never stretched or padded.',
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
      `setpts=N/(${rate}*TB),scale=${spec.width}:${spec.height}:flags=lanczos,setsar=1,format=yuv420p`,
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
    sourceFps: `${p.fpsNum}/${p.fpsDen}`,
    sourceSize: `${p.width}x${p.height}`,
  };
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
  return total;
}

/**
 * Two clips of the same length side by side (`h`, the exported comparison) or stacked (`v`, the proxy the
 * web slider crops from, so both halves always come from the same decoded frame).
 */
export async function stackCompare(
  original: string,
  edited: string,
  output: string,
  { layout, height, audioFrom }: { layout: 'h' | 'v'; height: number; audioFrom?: string },
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
      ...(audioFrom ? ['-map', '2:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'] : ['-an']),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
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
