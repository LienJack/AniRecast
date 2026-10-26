import { AniError } from '@anirecast/shared';
import { exec } from './exec.ts';

export interface Probe {
  durationMs: number;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  /** Decoded frame count when counted, otherwise estimated from duration × fps. */
  frameCount: number;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec: string | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  duration?: string;
}

export function parseRate(rate: string | undefined): [number, number] {
  const [n, d] = (rate ?? '0/1').split('/').map(Number);
  if (!n || !d) return [0, 1];
  return [n, d];
}

export async function probe(
  file: string,
  { countFrames = false, signal }: { countFrames?: boolean; signal?: AbortSignal } = {},
): Promise<Probe> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
  if (countFrames) args.push('-count_packets');
  const { stdout } = await exec('ffprobe', [...args, file], signal ? { signal } : {});
  const json = JSON.parse(stdout) as { streams: FfprobeStream[]; format: { duration?: string } };
  const video = json.streams.find((s) => s.codec_type === 'video');
  if (!video) throw new AniError('usage', `No video stream in ${file}`);
  const audio = json.streams.find((s) => s.codec_type === 'audio');
  let [fpsNum, fpsDen] = parseRate(video.r_frame_rate);
  if (!fpsNum || fpsNum / fpsDen > 240) [fpsNum, fpsDen] = parseRate(video.avg_frame_rate);
  const durationMs = Math.round(Number(json.format.duration ?? video.duration ?? 0) * 1000);
  const counted = Number(video.nb_read_packets ?? video.nb_frames ?? Number.NaN);
  const frameCount =
    Number.isFinite(counted) && counted > 0 ? counted : Math.round((durationMs / 1000) * (fpsNum / fpsDen));
  return {
    durationMs,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fpsNum,
    fpsDen,
    frameCount,
    videoCodec: video.codec_name,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * Frames that actually decode. `probe` counts packets, and a damaged file still has all of them: shot 11 of the
 * Lycoris OP had 165 packets but decoded 122 frames.
 */
export async function decodedFrames(
  file: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<number> {
  const { stdout } = await exec(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      file,
    ],
    signal ? { signal } : {},
  );
  return Number(stdout.trim()) || 0;
}

/** Seconds → nearest frame index at `fpsNum/fpsDen`. */
export const secondsToFrame = (seconds: number, fpsNum: number, fpsDen: number): number =>
  Math.round((seconds * fpsNum) / fpsDen);
/** Frame index → seconds at the start of that frame. */
export const frameToSeconds = (frame: number, fpsNum: number, fpsDen: number): number =>
  (frame * fpsDen) / fpsNum;

/** Parses `83.5`, `1:23.5`, `00:01:23.500` or `f:1992` into a frame index. */
export function parseTimecode(input: string, fpsNum: number, fpsDen: number): number {
  const s = input.trim();
  const frame = /^f:(\d+)$/i.exec(s);
  if (frame) return Number(frame[1]);
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new AniError('usage', `Bad timecode "${input}" (use 83.5, 1:23.5, 00:01:23.500 or f:1992)`);
  }
  const seconds = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  return secondsToFrame(seconds, fpsNum, fpsDen);
}

export function formatTimecode(frame: number, fpsNum: number, fpsDen: number): string {
  const total = frameToSeconds(frame, fpsNum, fpsDen);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

/** A picture change inside a clip, from ffmpeg's scene score. */
export interface SceneChange {
  frame: number;
  seconds: number;
  score: number;
  /** `cut` when it stands alone; `motion` when others are within a few frames (a whip pan, fast action, a flash). */
  kind: 'cut' | 'motion';
}

/**
 * Where the picture changes inside a clip: hard cuts, and runs of change every few frames that are fast motion
 * rather than cuts. A shot that is really several cuts can be redone cut by cut (partial takes) with invisible joins.
 */
export async function sceneChanges(
  file: string,
  { threshold = 0.3, signal }: { threshold?: number; signal?: AbortSignal } = {},
): Promise<SceneChange[]> {
  const p = await probe(file, signal ? { signal } : {});
  const fps = p.fpsNum / p.fpsDen;
  const { stderr } = await exec(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-an',
      '-vf',
      `select='gt(scene,${threshold})',metadata=print`,
      '-f',
      'null',
      '-',
    ],
    signal ? { signal } : {},
  );
  const found: Array<{ frame: number; seconds: number; score: number }> = [];
  let at: number | null = null;
  for (const line of stderr.split('\n')) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) at = Number(t[1]);
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s && at !== null) {
      found.push({
        frame: Math.round(at * fps),
        seconds: Number(at.toFixed(3)),
        score: Number(Number(s[1]).toFixed(3)),
      });
      at = null;
    }
  }
  return found.map((c) => ({
    ...c,
    kind: found.some((o) => o !== c && Math.abs(o.frame - c.frame) <= 4) ? 'motion' : 'cut',
  }));
}
