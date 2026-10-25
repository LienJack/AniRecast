/** Frame and time helpers. Same math as packages/media `probe.ts` so Web and CLI agree to the frame. */

export interface Fps {
  num: number;
  den: number;
}

export const fpsValue = (fps: Fps): number => fps.num / fps.den;

/** Same as media `secondsToFrame`: nearest frame. */
export const secondsToFrame = (seconds: number, fps: Fps): number =>
  Math.round((seconds * fps.num) / fps.den);

/** Same as media `frameToSeconds`: start of that frame. */
export const frameToSeconds = (frame: number, fps: Fps): number => (frame * fps.den) / fps.num;

/** Frame shown at a playback position (tolerant of float error just below a frame boundary). */
export const frameAtTime = (t: number, fps: Fps): number =>
  Math.max(0, Math.floor((t * fps.num) / fps.den + 0.01));

/** Seek target for a frame: its middle, so decoders never land on the previous one. */
export const seekTimeForFrame = (frame: number, fps: Fps): number => ((frame + 0.5) * fps.den) / fps.num;

export function formatTimecode(frame: number, fps: Fps): string {
  const total = frameToSeconds(frame, fps);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

/** Same grammar as media `parseTimecode`: `83.5`, `1:23.5`, `00:01:23.500` or `f:1992`. */
export function parseTimecode(input: string, fps: Fps): number | null {
  const s = input.trim();
  const frame = /^f:(\d+)$/i.exec(s);
  if (frame) return Number(frame[1]);
  const parts = s.split(':');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const seconds = parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  return secondsToFrame(seconds, fps);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} 秒`;
}

export const formatUsd = (usd: number | null | undefined): string =>
  usd === null || usd === undefined ? '—' : `USD ${usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2)}`;

const dateFmt = new Intl.DateTimeFormat('zh-Hant', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export const formatTime = (ms: number | null | undefined): string => (ms ? dateFmt.format(ms) : '—');

export function formatAgo(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${Math.max(s, 0)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return formatTime(ms);
}

export const shortId = (id: string | null | undefined): string => (id ? id.slice(-6) : '—');
