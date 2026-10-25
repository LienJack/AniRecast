import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { exec } from './exec.ts';
import { frameToSeconds } from './probe.ts';

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  /** Fraction 0..1 of `totalFrames` processed. */
  onProgress?: (fraction: number) => void;
  totalFrames?: number;
}

/** Runs ffmpeg with `-progress pipe:2` parsing so long encodes can report progress. */
export async function ffmpeg(args: string[], opts: FfmpegRunOptions = {}): Promise<void> {
  await exec(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:2', ...args],
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      onStderrLine: (line) => {
        if (!opts.onProgress || !opts.totalFrames) return;
        const m = /^frame=(\d+)/.exec(line);
        if (m) opts.onProgress(Math.min(1, Number(m[1]) / opts.totalFrames));
      },
    },
  );
}

const ensureDir = (file: string) => mkdirSync(path.dirname(file), { recursive: true });
const rate = (fpsNum: number, fpsDen: number) => `${fpsNum}/${fpsDen}`;

export interface SegmentSpec {
  /** First frame (inclusive) in the input's frame numbering at fpsNum/fpsDen. */
  startFrame: number;
  frameCount: number;
  fpsNum: number;
  fpsDen: number;
}

/**
 * Frame-accurate, constant-frame-rate H.264 extraction. Input seeking with re-encoding is
 * sample-accurate, and `-frames:v` pins the exact count.
 */
export async function extractVideoSegment(
  input: string,
  output: string,
  seg: SegmentSpec,
  {
    crf = 14,
    scaleHeight,
    keyint,
    ...opts
  }: FfmpegRunOptions & { crf?: number; scaleHeight?: number; keyint?: number } = {},
): Promise<void> {
  ensureDir(output);
  const filters = [`fps=${rate(seg.fpsNum, seg.fpsDen)}`];
  if (scaleHeight) filters.push(`scale=-2:${scaleHeight}:flags=lanczos`);
  filters.push('format=yuv420p');
  await ffmpeg(
    [
      '-ss',
      frameToSeconds(seg.startFrame, seg.fpsNum, seg.fpsDen).toFixed(6),
      '-i',
      input,
      '-an',
      '-vf',
      filters.join(','),
      '-fps_mode',
      'cfr',
      '-r',
      rate(seg.fpsNum, seg.fpsDen),
      '-frames:v',
      String(seg.frameCount),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(crf),
      ...(keyint ? ['-g', String(keyint), '-keyint_min', String(keyint)] : []),
      '-movflags',
      '+faststart',
      output,
    ],
    { ...opts, totalFrames: seg.frameCount },
  );
}

/** Extracts the matching audio span as 48 kHz PCM WAV (the master audio for compose). */
export async function extractAudioSegment(
  input: string,
  output: string,
  seg: SegmentSpec,
  opts: FfmpegRunOptions = {},
): Promise<void> {
  ensureDir(output);
  await ffmpeg(
    [
      '-ss',
      frameToSeconds(seg.startFrame, seg.fpsNum, seg.fpsDen).toFixed(6),
      '-i',
      input,
      '-vn',
      '-t',
      frameToSeconds(seg.frameCount, seg.fpsNum, seg.fpsDen).toFixed(6),
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      output,
    ],
    opts,
  );
}

/**
 * Browser proxy: H.264 + AAC, short GOP so seeking and frame stepping are responsive.
 * `audio` muxes a separate audio file instead of the input's own track.
 */
export async function makeProxy(
  input: string,
  output: string,
  { height = 720, audio, ...opts }: FfmpegRunOptions & { height?: number; audio?: string } = {},
): Promise<void> {
  ensureDir(output);
  const inputs = ['-i', input, ...(audio ? ['-i', audio] : [])];
  await ffmpeg(
    [
      ...inputs,
      '-map',
      '0:v:0',
      '-map',
      audio ? '1:a:0?' : '0:a:0?',
      '-vf',
      `scale=-2:'min(${height},ih)':flags=bicubic,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-g',
      '12',
      '-keyint_min',
      '12',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      output,
    ],
    opts,
  );
}

/** Writes one frame (by index at the given rate) as JPEG. */
export async function extractFrame(
  input: string,
  output: string,
  frame: number,
  fpsNum: number,
  fpsDen: number,
  { maxWidth, signal }: { maxWidth?: number; signal?: AbortSignal } = {},
): Promise<void> {
  ensureDir(output);
  await ffmpeg(
    [
      '-ss',
      frameToSeconds(frame, fpsNum, fpsDen).toFixed(6),
      '-i',
      input,
      '-frames:v',
      '1',
      ...(maxWidth ? ['-vf', `scale='min(${maxWidth},iw)':-2`] : []),
      '-q:v',
      '3',
      output,
    ],
    signal ? { signal } : {},
  );
}
