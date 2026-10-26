import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CheckIcon, CornerDownLeftIcon, LogInIcon, LogOutIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Kbd,
  Loading,
  PageHeader,
  Tag,
} from '@/components/common';
import { FramePlayer, type FramePlayerHandle } from '@/components/FramePlayer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, fileUrl, isConflict } from '@/lib/api';
import { type Fps, formatTimecode, frameToSeconds, parseTimecode } from '@/lib/format';
import { qk, useAction, useOverview } from '@/lib/queries';
import type { Clip, Job, Source } from '@/lib/types';
import { isTypingTarget } from '@/lib/video';

/** Timecode text field that commits a frame number on Enter/blur (same grammar as the CLI). */
function TimecodeInput({
  label,
  frame,
  fps,
  onCommit,
}: {
  label: string;
  frame: number | null;
  fps: Fps;
  onCommit: (frame: number) => void;
}) {
  const [text, setText] = useState(frame === null ? '' : formatTimecode(frame, fps));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(frame === null ? '' : formatTimecode(frame, fps));
    setBad(false);
  }, [frame, fps]);
  const commit = () => {
    if (!text.trim()) return;
    const f = parseTimecode(text, fps);
    if (f === null) setBad(true);
    else onCommit(f);
  };
  return (
    <Input
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        e.stopPropagation();
      }}
      aria-invalid={bad}
      placeholder="00:01:23.500 或 f:1992"
      className={bad ? 'border-red-500 font-mono' : 'font-mono'}
    />
  );
}

// Two native range inputs on one track: only their thumbs take the pointer, so both handles can be dragged and
// a click on the track itself seeks. Keyboard works on each handle (←/→, Shift for 10 frames).
const HANDLE =
  'pointer-events-none absolute inset-0 h-full w-full appearance-none bg-transparent outline-none ' +
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-3.5 ' +
  '[&::-webkit-slider-thumb]:cursor-ew-resize [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-sm ' +
  '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-sky-400 ' +
  '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-7 [&::-moz-range-thumb]:w-3.5 ' +
  '[&::-moz-range-thumb]:cursor-ew-resize [&::-moz-range-thumb]:rounded-sm [&::-moz-range-thumb]:border-2 ' +
  '[&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-sky-400 ' +
  'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-sky-200';

/**
 * The whole source as a bar with the selection between two handles: drag the left one for the in point and the
 * right one for the out point (exclusive); the player follows the handle so the frame is visible while dragging.
 */
function RangeTrack({
  total,
  inFrame,
  outFrame,
  frame,
  fps,
  onIn,
  onOut,
  onSeek,
}: {
  total: number;
  inFrame: number | null;
  outFrame: number | null;
  frame: number;
  fps: Fps;
  onIn: (f: number) => void;
  onOut: (f: number) => void;
  onSeek: (f: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const lo = inFrame ?? 0;
  const hi = Math.min(outFrame ?? total, total);
  const pct = (f: number) => `${(Math.min(Math.max(f, 0), total) / Math.max(1, total)) * 100}%`;
  const ownKeys = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="flex flex-col gap-1">
      <div
        ref={track}
        className="relative h-9 cursor-pointer select-none"
        onPointerDown={(e) => {
          const r = track.current?.getBoundingClientRect();
          if (!r || e.target !== e.currentTarget) return;
          onSeek(Math.min(total - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * total))));
        }}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-secondary" />
        <div
          className="pointer-events-none absolute top-1/2 h-2.5 -translate-y-1/2 bg-sky-500/50"
          style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }}
        />
        <div
          className="pointer-events-none absolute inset-y-1 w-0.5 bg-foreground"
          style={{ left: pct(frame) }}
          title="目前畫面"
        />
        <input
          type="range"
          aria-label="入點（拖曳調整）"
          min={0}
          max={total}
          step={1}
          value={lo}
          onKeyDown={ownKeys}
          onChange={(e) => {
            const f = Math.min(Number(e.target.value), hi - 1);
            onIn(f);
            onSeek(f);
          }}
          // Near the end the in handle must stay grabbable above the out handle.
          className={`${HANDLE} ${lo > total - 30 ? 'z-20' : 'z-10'}`}
        />
        <input
          type="range"
          aria-label="出點（拖曳調整，不含這一幀）"
          min={0}
          max={total}
          step={1}
          value={hi}
          onKeyDown={ownKeys}
          onChange={(e) => {
            const f = Math.max(Number(e.target.value), lo + 1);
            onOut(f);
            onSeek(f - 1);
          }}
          className={`${HANDLE} z-10`}
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>
          入點 {formatTimecode(lo, fps)} · f {lo}
        </span>
        <span>
          選取 {hi - lo} 幀（{frameToSeconds(hi - lo, fps).toFixed(2)} 秒）
        </span>
        <span>
          最後一幀 {formatTimecode(hi - 1, fps)} · f {hi - 1}
        </span>
      </div>
    </div>
  );
}

function ClipEditor({ source, clip, projectRef }: { source: Source; clip: Clip | null; projectRef: string }) {
  const navigate = useNavigate();
  const fps = { num: source.fpsNum ?? 24, den: source.fpsDen ?? 1 };
  // Same frame count rule as core createClip.
  const totalFrames = Math.max(1, Math.floor(((source.durationMs ?? 0) / 1000) * (fps.num / fps.den)));
  const player = useRef<FramePlayerHandle>(null);
  const [frame, setFrame] = useState(clip?.inFrame ?? 0);
  const [inFrame, setIn] = useState<number | null>(clip?.inFrame ?? null);
  const [outFrame, setOut] = useState<number | null>(clip?.outFrame ?? null);
  const [conflict, setConflict] = useState<string | null>(null);

  const valid =
    inFrame !== null && outFrame !== null && inFrame >= 0 && outFrame > inFrame && inFrame < totalFrames;
  const unchanged = clip && clip.inFrame === inFrame && clip.outFrame === outFrame;

  const confirm = useAction(
    (force: boolean) =>
      api.post<{ clip: Clip; job: Job }>(`/api/projects/${encodeURIComponent(projectRef)}/clip`, {
        in: inFrame,
        out: outFrame,
        force,
      }),
    {
      success: '節選已確認，正在輸出節選檔並偵測分鏡',
      invalidate: [['project'], qk.jobs],
      onSuccess: () => {
        setConflict(null);
        void navigate({ to: '/projects/$ref/shots', params: { ref: projectRef } });
      },
      onError: (e) => {
        if (isConflict(e) && e.message.includes('already has generated')) {
          setConflict(e.message);
          return true;
        }
        return false;
      },
    },
  );

  const keys = useRef({ frame });
  keys.current = { frame };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const p = player.current;
      if (!p) return;
      const k = e.key.toLowerCase();
      if (e.key === 'ArrowLeft') p.step(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') p.step(e.shiftKey ? 10 : 1);
      else if (e.key === ' ') p.togglePlay();
      else if (k === 'i') setIn(keys.current.frame);
      else if (k === 'o') setOut(keys.current.frame + 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const proxy = fileUrl(`cache/sources/${source.id}/proxy.mp4`);
  const lengthFrames = valid ? outFrame - inFrame : 0;

  return (
    <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardContent>
          <FramePlayer
            ref={player}
            src={proxy ?? ''}
            fps={fps}
            totalFrames={totalFrames}
            initialFrame={clip?.inFrame ?? 0}
            onFrame={setFrame}
          />
          <div className="mt-3 flex flex-col gap-2">
            <RangeTrack
              total={totalFrames}
              inFrame={inFrame}
              outFrame={outFrame}
              frame={frame}
              fps={fps}
              onIn={setIn}
              onOut={setOut}
              onSeek={(f) => {
                player.current?.pause();
                player.current?.seekFrame(f);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setIn(frame)} title="把目前畫面設為節選的第一幀（I）">
                <LogInIcon />
                設為入點
              </Button>
              <Button size="sm" onClick={() => setOut(frame + 1)} title="把目前畫面設為節選的最後一幀（O）">
                <LogOutIcon />
                設為出點
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={inFrame === null}
                onClick={() => inFrame !== null && player.current?.seekFrame(inFrame)}
              >
                <CornerDownLeftIcon />
                跳到入點
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={outFrame === null}
                onClick={() => outFrame !== null && player.current?.seekFrame(outFrame - 1)}
              >
                <CornerDownLeftIcon />
                跳到最後一幀
              </Button>
              <span className="ml-auto font-mono text-muted-foreground text-xs">
                目前畫面 f {frame} · {formatTimecode(frame, fps)}
              </span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd> 逐幀（<Kbd>Shift</Kbd> 一次 10 幀）<Kbd>空白</Kbd> 播放／暫停 <Kbd>I</Kbd> 設入點
            <Kbd>O</Kbd> 設出點（包含目前這一幀）
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>節選範圍</CardTitle>
            {clip ? (
              <Tag tone="muted" className="ml-auto">
                目前 v{clip.version}
              </Tag>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="font-mono text-xs">
              目前畫面 f {frame} · {formatTimecode(frame, fps)}
            </div>
            <Field label="跳到時間碼">
              <TimecodeInput
                label="跳到時間碼"
                frame={null}
                fps={fps}
                onCommit={(f) => player.current?.seekFrame(f)}
              />
            </Field>
            <Field label="入點（第一幀）">
              <div className="flex gap-1.5">
                <TimecodeInput label="入點時間碼" frame={inFrame} fps={fps} onCommit={setIn} />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => setIn(frame)}
                  title="設為目前畫面（I）"
                >
                  <LogInIcon />I
                </Button>
              </div>
              {inFrame !== null ? (
                <span className="font-mono text-[11px] text-muted-foreground">f {inFrame}</span>
              ) : null}
            </Field>
            <Field label="出點（不含；最後一幀是出點的前一幀）">
              <div className="flex gap-1.5">
                <TimecodeInput label="出點時間碼" frame={outFrame} fps={fps} onCommit={setOut} />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => setOut(frame + 1)}
                  title="把目前畫面設為最後一幀（O）"
                >
                  <LogOutIcon />O
                </Button>
              </div>
              {outFrame !== null ? (
                <span className="font-mono text-[11px] text-muted-foreground">
                  f {outFrame}（不含），最後一幀 f {outFrame - 1}
                </span>
              ) : null}
            </Field>
            <div className="rounded-md border bg-background/40 p-2 text-xs">
              {valid ? (
                <>
                  長度 {lengthFrames} 幀（{frameToSeconds(lengthFrames, fps).toFixed(3)} 秒）
                  {outFrame > totalFrames ? (
                    <div className="text-amber-300">出點超過片尾，會截到片尾。</div>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">設定入點與出點（出點必須在入點之後）。</span>
              )}
            </div>
            <Button
              disabled={!valid || Boolean(unchanged) || confirm.isPending}
              onClick={() => confirm.mutate(false)}
            >
              <CheckIcon />
              確認節選
            </Button>
            {unchanged ? <span className="text-muted-foreground text-xs">和目前的節選相同。</span> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>來源影片</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            <span className="font-medium">{source.title}</span>
            <span className="text-muted-foreground">
              {source.width}×{source.height} · {(fps.num / fps.den).toFixed(3)} fps · 共 {totalFrames} 幀
            </span>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-primary hover:underline"
              >
                {source.url}
              </a>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={conflict !== null}
        onOpenChange={(o) => !o && setConflict(null)}
        title="目前的節選已有生成結果，確定要重新節選？"
        description="會建立新的節選版本並重新偵測分鏡；舊的節選、分鏡、分鏡圖和分鏡視頻都保留成歷史，不會刪除，但不再屬於目前的節選，需要重新評審與生成。"
        confirmLabel="重新節選"
        destructive
        pending={confirm.isPending}
        onConfirm={() => confirm.mutate(true)}
      />
    </div>
  );
}

export function ClipPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  const { source, clip } = overview.data;
  return (
    <div className="flex flex-col">
      <PageHeader
        title="原片與節選"
        description="逐幀瀏覽原片，設定入點與出點後確認節選。確認後輸出逐幀精確的節選檔並自動偵測分鏡。"
        actions={
          clip ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/projects/$ref/shots" params={{ ref }}>
                查看分鏡
              </Link>
            </Button>
          ) : null
        }
      />
      {source.status !== 'ready' || !source.fpsNum || !source.fpsDen ? (
        <div className="p-5">
          <EmptyState>來源影片還沒準備好（{source.status}）。下載或匯入完成後才能節選。</EmptyState>
        </div>
      ) : (
        <ClipEditor key={clip?.id ?? 'new'} source={source} clip={clip} projectRef={ref} />
      )}
    </div>
  );
}
