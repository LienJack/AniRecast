import {
  ChevronFirstIcon,
  ChevronLastIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  StepBackIcon,
  StepForwardIcon,
} from 'lucide-react';
import { type Ref, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { type Fps, formatTimecode, seekTimeForFrame } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useFrameClock } from '@/lib/video';

export interface FramePlayerHandle {
  togglePlay: () => void;
  pause: () => void;
  step: (delta: number) => void;
  seekFrame: (frame: number) => void;
}

export interface FramePlayerProps {
  src: string;
  fps: Fps;
  /** Frames in the video file. */
  totalFrames: number;
  /** Optional inclusive [start, end] window: scrubbing and looping stay inside it. */
  range?: [number, number];
  /** Frame to show first. */
  initialFrame?: number;
  /** In point and exclusive out point to highlight on the timeline. */
  marks?: { in: number | null; out: number | null };
  onFrame?: (frame: number) => void;
  className?: string;
  ref?: Ref<FramePlayerHandle>;
}

/** Frame-accurate single-video player: rVFC frame clock, ±1 frame stepping, timecode and frame number. */
export function FramePlayer({
  src,
  fps,
  totalFrames,
  range,
  initialFrame,
  marks,
  onFrame,
  className,
  ref,
}: FramePlayerProps) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [frame, setFrame] = useState(initialFrame ?? range?.[0] ?? 0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef(frame);
  const scrubId = useId();
  const lo = range?.[0] ?? 0;
  const hi = Math.max(lo, range?.[1] ?? totalFrames - 1);

  const seekFrame = useCallback(
    (f: number) => {
      if (!video) return;
      const target = Math.min(Math.max(lo, Math.round(f)), hi);
      video.currentTime = seekTimeForFrame(target, fps);
      frameRef.current = target;
      setFrame(target);
      onFrame?.(target);
    },
    [video, fps, lo, hi, onFrame],
  );

  useFrameClock(video, fps, (f) => {
    if (range && video && !video.paused && f > hi) {
      seekFrame(lo);
      return;
    }
    frameRef.current = f;
    setFrame(f);
    onFrame?.(f);
  });

  // Jump to the starting frame once the video can seek (only on load / when the window changes).
  const startFrame = initialFrame ?? range?.[0];
  const seekRef = useRef(seekFrame);
  seekRef.current = seekFrame;
  useEffect(() => {
    if (ready && startFrame !== undefined) seekRef.current(startFrame);
  }, [ready, startFrame]);

  const pause = useCallback(() => video?.pause(), [video]);
  const togglePlay = useCallback(() => {
    if (!video) return;
    if (video.paused) {
      if (frameRef.current >= hi) seekFrame(lo);
      void video.play().catch(() => setPlaying(false));
    } else video.pause();
  }, [video, hi, lo, seekFrame]);
  const step = useCallback(
    (delta: number) => {
      video?.pause();
      seekFrame(frameRef.current + delta);
    },
    [video, seekFrame],
  );
  useImperativeHandle(ref, () => ({ togglePlay, pause, step, seekFrame }), [
    togglePlay,
    pause,
    step,
    seekFrame,
  ]);

  const span = Math.max(1, hi - lo + 1);
  const pct = (f: number) => `${((Math.min(Math.max(f, lo), hi + 1) - lo) / span) * 100}%`;
  const inMark = marks?.in ?? null;
  const outMark = marks?.out ?? null;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
        <video
          ref={setVideo}
          src={src}
          muted
          playsInline
          preload="auto"
          className="h-full w-full object-contain"
          onLoadedData={() => setReady(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setFailed(true)}
        />
        {!ready || failed ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-muted-foreground text-xs">
            {failed ? (
              '無法載入影片'
            ) : (
              <>
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                載入中…
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="relative h-1.5 w-full rounded-full bg-secondary">
        {inMark !== null || outMark !== null ? (
          <div
            className="absolute inset-y-0 rounded-full bg-primary/50"
            style={{
              left: pct(inMark ?? lo),
              width: `calc(${pct(outMark ?? hi + 1)} - ${pct(inMark ?? lo)})`,
            }}
          />
        ) : null}
        <div className="absolute inset-y-[-3px] w-0.5 bg-foreground" style={{ left: pct(frame) }} />
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="第一幀" onClick={() => seekFrame(lo)}>
          <ChevronFirstIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="上一幀" onClick={() => step(-1)}>
          <StepBackIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label={playing ? '暫停' : '播放'}
          onClick={togglePlay}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="下一幀" onClick={() => step(1)}>
          <StepForwardIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="最後一幀" onClick={() => seekFrame(hi)}>
          <ChevronLastIcon />
        </Button>
        <label htmlFor={scrubId} className="sr-only">
          時間軸
        </label>
        <input
          id={scrubId}
          type="range"
          min={lo}
          max={hi}
          step={1}
          value={Math.min(Math.max(frame, lo), hi)}
          onChange={(e) => {
            video?.pause();
            seekFrame(Number(e.target.value));
          }}
          className="mx-1 h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatTimecode(frame, fps)} · f {frame}
        </span>
      </div>
    </div>
  );
}
