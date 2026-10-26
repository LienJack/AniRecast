import { type ReactNode, useEffect, useState } from 'react';
import { useJobs } from '@/lib/queries';
import type { Job } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Work in progress, shown without spinners (index.css: .sweep, .skeleton, .text-shimmer, .aurora, .ghost):
 * a band of light crosses what is being made, shaped like the result (a turnaround, a grid of faces, poses) or a
 * blurred ghost of the picture it starts from, with a shimmering label, the time so far and the job's progress.
 */

/** Seconds since `since` (epoch ms), ticking once a second; null without a start. */
export function useElapsed(since: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : null;
}

export const formatClock = (s: number) =>
  s < 60 ? `${s} 秒` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The queued or running job whose payload has `key` = `id` (its progress arrives live from the event stream). */
export function useActiveJob(key: string, id: string | null | undefined, type?: string): Job | undefined {
  const jobs = useJobs();
  if (!id) return undefined;
  return jobs.data?.find(
    (j) =>
      (j.status === 'queued' || j.status === 'running') &&
      (!type || j.type === type) &&
      (j.payload as Record<string, unknown> | null)?.[key] === id,
  );
}

/** Text with light running through it, like "Thinking…". */
export function ShimmerText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-shimmer', className)}>{children}</span>;
}

export type GeneratingShape = 'turnaround' | 'expressions' | 'poses' | 'none';

const block = 'bg-foreground/[0.07]';

/** A standing figure: head and body. */
function Figure({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-full flex-col items-center gap-[5%]', className)}>
      <div className={cn('aspect-square w-[46%] shrink-0 rounded-full', block)} />
      <div className={cn('w-full flex-1 rounded-t-[45%] rounded-b-md', block)} />
    </div>
  );
}

/** The layout of the sheet being drawn, in faint blocks. */
function ShapeSkeleton({ shape }: { shape: GeneratingShape }) {
  if (shape === 'turnaround')
    return (
      <div className="absolute inset-0 flex items-end justify-center gap-[9%] px-[14%] pt-[9%] pb-[16%]">
        {[0, 1, 2].map((i) => (
          <Figure key={i} className="w-[13%]" />
        ))}
      </div>
    );
  if (shape === 'expressions')
    return (
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-2 gap-[3%] px-[8%] pt-[6%] pb-[14%]">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={cn('flex items-center justify-center rounded-lg', block)}>
            <div className="aspect-square h-[62%] rounded-full bg-foreground/[0.06]" />
          </div>
        ))}
      </div>
    );
  if (shape === 'poses')
    return (
      <div className="absolute inset-0 flex items-end justify-center gap-[6%] px-[10%] pt-[9%] pb-[16%]">
        {['h-[92%] -rotate-6', 'h-[78%] rotate-3', 'h-full', 'h-[84%] rotate-6'].map((c) => (
          <Figure key={c} className={cn('w-[12%] origin-bottom', c)} />
        ))}
      </div>
    );
  return null;
}

/**
 * Placeholder for a version being made. `backdrop` (the picture it starts from: the original frame, the previous
 * version, the template) shows blurred and breathing; without one, `shape` sketches the expected layout.
 */
export function Generating({
  queued,
  label,
  since,
  progress,
  message,
  backdrop,
  shape = 'none',
  className,
}: {
  queued?: boolean;
  label?: string;
  since?: number | null;
  progress?: number | null;
  message?: string | null;
  backdrop?: string | null;
  shape?: GeneratingShape;
  className?: string;
}) {
  const elapsed = useElapsed(since);
  const title = label ?? (queued ? '排隊中' : '生成中');
  const pct = progress != null && progress > 0 ? Math.round(progress * 100) : null;
  return (
    <div
      role="status"
      aria-label={`${title}${elapsed !== null ? `，已 ${formatClock(elapsed)}` : ''}`}
      className={cn('relative overflow-hidden rounded-md bg-muted/70', className)}
    >
      {queued ? null : <div className="aurora" />}
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          aria-hidden
          className={cn(
            'absolute inset-0 size-full scale-105 object-cover blur-[10px] saturate-[.6]',
            queued ? 'opacity-25 grayscale' : 'ghost',
          )}
        />
      ) : (
        <ShapeSkeleton shape={shape} />
      )}
      <div className={cn('sweep absolute inset-0', queued && 'sweep-slow')} />
      <div className="absolute bottom-2.5 left-2.5 z-10 flex max-w-[calc(100%-1.25rem)] items-center gap-2 rounded-full bg-black/45 px-2.5 py-1 text-xs backdrop-blur-sm">
        <ShimmerText className={cn('font-medium', queued ? 'text-muted-foreground' : 'text-sky-200')}>
          {title}
        </ShimmerText>
        {message ? <span className="truncate text-[11px] text-muted-foreground">{message}</span> : null}
        {pct !== null ? (
          <span className="font-mono text-[11px] text-sky-200/80 tabular-nums">{pct}%</span>
        ) : null}
        {elapsed !== null ? (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {formatClock(elapsed)}
          </span>
        ) : null}
      </div>
      {pct !== null ? (
        <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-foreground/5">
          <div
            className="h-full bg-linear-to-r from-sky-400/50 to-violet-400/80 transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Over a thumbnail whose shot is being generated: the light sweeps across it and a small label says so. */
export function GeneratingOverlay({ label = '生成中', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('pointer-events-none absolute inset-0', className)}>
      <div className="sweep absolute inset-0 bg-black/20" />
      <span className="absolute bottom-1.5 left-1.5 z-10 rounded bg-black/65 px-1.5 text-[11px]">
        <ShimmerText className="text-sky-200">{label}</ShimmerText>
      </span>
    </div>
  );
}
