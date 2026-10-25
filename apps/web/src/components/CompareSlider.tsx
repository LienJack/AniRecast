import {
  ChevronFirstIcon,
  ChevronLastIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  StepBackIcon,
  StepForwardIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { type Fps, formatTimecode, fpsValue, seekTimeForFrame } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useFrameClock } from '@/lib/video';

export interface CompareSliderHandle {
  togglePlay: () => void;
  pause: () => void;
  /** Steps by `delta` frames (pauses first). */
  step: (delta: number) => void;
  seekFrame: (frame: number) => void;
}

export interface CompareSliderProps {
  /** URL of a vertically stacked proxy: original on top, edited below, same frames. */
  src: string;
  fps: Fps;
  /** Known frame count; otherwise derived from the video duration. */
  frameCount?: number | null;
  leftLabel?: string;
  rightLabel?: string;
  loop?: boolean;
  /** Show a sound toggle (render proxies carry the original audio; take proxies are silent). */
  audio?: boolean;
  className?: string;
  ref?: Ref<CompareSliderHandle>;
}

const RATES = [1, 0.5, 0.25] as const;

/**
 * Interactive before/after slider (design §7.6). ONE `<video>` decodes the stacked proxy; a canvas draws
 * the left part from the top half and the right part from the bottom half of the same decoded frame, so
 * both sides are always the same frame. The video stays rendered under the canvas (never display:none)
 * so frame callbacks keep firing.
 */
export function CompareSlider({
  src,
  fps,
  frameCount,
  leftLabel = '原片',
  rightLabel = '新版本',
  loop: initialLoop = true,
  audio = false,
  className,
  ref,
}: CompareSliderProps) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef(0.5);
  const frameRef = useRef(0);
  const [divider, setDivider] = useState(0.5);
  const [frame, setFrame] = useState(0);
  const [duration, setDuration] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(initialLoop);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [muted, setMuted] = useState(true);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const dragging = useRef(false);
  const scrubId = useId();

  const lastFrame = Math.max(0, (frameCount ?? (duration ? Math.round(duration * fpsValue(fps)) : 1)) - 1);

  const draw = useCallback(() => {
    const v = video;
    const c = canvasRef.current;
    if (!v || !c || v.readyState < 2) return;
    const w = v.videoWidth;
    const h = Math.floor(v.videoHeight / 2);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      setAspect(w / h);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const sx = Math.round(dividerRef.current * w);
    const bottom = v.videoHeight - h;
    if (sx > 0) ctx.drawImage(v, 0, 0, sx, h, 0, 0, sx, h);
    if (sx < w) ctx.drawImage(v, sx, bottom, w - sx, h, sx, 0, w - sx, h);
  }, [video]);

  useFrameClock(video, fps, (f) => {
    draw();
    frameRef.current = f;
    setFrame(f);
  });

  useEffect(() => {
    dividerRef.current = divider;
    draw();
  }, [divider, draw]);

  useEffect(() => {
    if (video) video.loop = loop;
  }, [video, loop]);

  useEffect(() => {
    if (video) video.playbackRate = rate;
  }, [video, rate]);

  // A new source starts paused at frame 0.
  useEffect(() => {
    if (!src) return;
    setStatus('loading');
    setPlaying(false);
    setFrame(0);
    frameRef.current = 0;
  }, [src]);

  const seekFrame = useCallback(
    (f: number) => {
      if (!video) return;
      const target = Math.min(Math.max(0, Math.round(f)), lastFrame);
      video.currentTime = seekTimeForFrame(target, fps);
      frameRef.current = target;
      setFrame(target);
    },
    [video, fps, lastFrame],
  );

  const pause = useCallback(() => video?.pause(), [video]);
  const togglePlay = useCallback(() => {
    if (!video) return;
    if (video.paused) {
      if (!loop && frameRef.current >= lastFrame) video.currentTime = 0;
      void video.play().catch(() => setPlaying(false));
    } else video.pause();
  }, [video, loop, lastFrame]);
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

  const setFromPointer = (clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDivider(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  const onDividerKey = (e: KeyboardEvent) => {
    const big = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, number> = { ArrowLeft: -big, ArrowRight: big };
    if (e.key in moves) setDivider((d) => Math.min(1, Math.max(0, d + (moves[e.key] ?? 0))));
    else if (e.key === 'Home') setDivider(0);
    else if (e.key === 'End') setDivider(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        ref={stageRef}
        className="relative w-full overflow-hidden rounded-md bg-black"
        style={{ aspectRatio: aspect }}
      >
        <video
          ref={setVideo}
          src={src}
          muted={muted}
          playsInline
          preload="auto"
          className="absolute inset-0 h-full w-full"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onLoadedData={() => {
            setStatus('ready');
            draw();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setStatus('error')}
        />
        <canvas ref={canvasRef} className="absolute inset-0 z-10 h-full w-full bg-black" />
        <div className="pointer-events-none absolute inset-0 z-20">
          <span className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/90">
            {leftLabel}
          </span>
          <span className="absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/90">
            {rightLabel}
          </span>
          <div
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/90 shadow"
            style={{ left: `${divider * 100}%` }}
          >
            <span className="absolute top-1/2 left-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-black/70 text-[10px] text-white">
              ⇔
            </span>
          </div>
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="對比分隔線（← → 移動）"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(divider * 100)}
          aria-orientation="horizontal"
          className="absolute inset-0 z-30 cursor-ew-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) setFromPointer(e.clientX);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onDoubleClick={() => setDivider(0.5)}
          onKeyDown={onDividerKey}
        />
        {status !== 'ready' ? (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 text-muted-foreground text-xs">
            {status === 'error' ? (
              '無法載入對比影片'
            ) : (
              <>
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                載入中…
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="第一幀" onClick={() => step(-frameRef.current)}>
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
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="最後一幀"
          onClick={() => step(lastFrame - frameRef.current)}
        >
          <ChevronLastIcon />
        </Button>
        <label htmlFor={scrubId} className="sr-only">
          進度
        </label>
        <input
          id={scrubId}
          type="range"
          min={0}
          max={lastFrame}
          step={1}
          value={Math.min(frame, lastFrame)}
          onChange={(e) => {
            video?.pause();
            seekFrame(Number(e.target.value));
          }}
          className="mx-1 h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="w-[13.5rem] shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatTimecode(frame, fps)} · f {frame}/{lastFrame}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="w-12 font-mono"
          aria-label="播放速度"
          onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length] ?? 1)}
        >
          {rate}×
        </Button>
        {audio ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={muted ? '開啟聲音' : '靜音'}
            aria-pressed={!muted}
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? <VolumeXIcon /> : <Volume2Icon />}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant={loop ? 'secondary' : 'ghost'}
          aria-label="循環播放"
          aria-pressed={loop}
          onClick={() => setLoop((l) => !l)}
        >
          <RepeatIcon />
        </Button>
      </div>
    </div>
  );
}
