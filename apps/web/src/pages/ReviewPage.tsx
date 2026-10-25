import { Link, Navigate, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowUpCircleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SparklesIcon,
  UndoIcon,
  VideoIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CompareSlider, type CompareSliderHandle } from '@/components/CompareSlider';
import { DiscussInCodex } from '@/components/codex';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Kbd,
  Loading,
  PageHeader,
  Tag,
  Thumb,
} from '@/components/common';
import {
  ActorLink,
  FrameWithOverlays,
  ModeBadge,
  OpenInCodex,
  StageBadge,
  TaskCard,
  VersionBadge,
} from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, fileUrl } from '@/lib/api';
import { useAgentLive } from '@/lib/events';
import { formatAgo, formatTime, formatUsd } from '@/lib/format';
import {
  MODE_LABEL,
  SHOT_MODES,
  STAGE_TONE,
  TIER_LABEL,
  TIERS,
  VERDICT_LABEL,
  VERDICT_TONE,
} from '@/lib/labels';
import { useAction, useOverview, useShot } from '@/lib/queries';
import type {
  AgentTask,
  Board,
  BoardQueue,
  GenerationTier,
  OverviewShot,
  ReviewResult,
  ShotDetail,
  ShotMode,
  Take,
  TakeQueue,
  Verdict,
  WithReviews,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { isTypingTarget } from '@/lib/video';

type Target = { type: 'board' | 'take'; id: string };

const REVIEW_STAGES = new Set(['board_review', 'take_review']);

/** `/projects/$ref/review` → first shot waiting for review (or the first one that is generated at all). */
export function ReviewIndexPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  const shots = overview.data?.shots ?? [];
  const pick =
    shots.find((s) => REVIEW_STAGES.has(s.stage)) ??
    shots.find((s) => s.mode === 'replace' || s.mode === 'clean') ??
    shots[0];
  if (!pick)
    return (
      <div className="p-6">
        <EmptyState>
          這個項目還沒有分鏡。
          <Link to="/projects/$ref/clip" params={{ ref }} className="text-primary hover:underline">
            先去節選
          </Link>
        </EmptyState>
      </div>
    );
  return <Navigate to="/projects/$ref/review/$shotId" params={{ ref, shotId: pick.id }} replace />;
}

const comparePathOf = (take: Take): string | null =>
  typeof take.remote.comparePath === 'string' ? take.remote.comparePath : null;

function defaultTarget(d: ShotDetail): Target | null {
  const tierTakes = d.takes.filter((t) => t.tier === d.project.tier);
  const latestTake = tierTakes.at(-1) ?? d.takes.at(-1);
  const latestBoard = d.boards.at(-1);
  if (d.stage === 'board_review' && latestBoard) return { type: 'board', id: latestBoard.id };
  if (latestTake) return { type: 'take', id: latestTake.id };
  if (latestBoard) return { type: 'board', id: latestBoard.id };
  return null;
}

/** Codex's one-line notes that produced a version (task result) or are working on feedback about it. */
function notesFor(tasks: AgentTask[], versionId: string) {
  return {
    produced: tasks.filter((t) => t.resultTargetId === versionId && t.resultNote),
    about: tasks.filter((t) => (t.payload as { targetId?: string }).targetId === versionId),
  };
}

function ShotStrip({
  shots,
  current,
  projectRef,
}: {
  shots: OverviewShot[];
  current: string;
  projectRef: string;
}) {
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, []);
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b px-5 py-2">
      {shots.map((s) => (
        <Link
          key={s.id}
          ref={s.id === current ? activeRef : undefined}
          to="/projects/$ref/review/$shotId"
          params={{ ref: projectRef, shotId: s.id }}
          className={cn(
            'relative w-24 shrink-0 overflow-hidden rounded border-2',
            s.id === current ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100',
          )}
          title={`#${s.orderIndex + 1}`}
        >
          <Thumb src={fileUrl(s.thumb)} alt={`分鏡 ${s.orderIndex + 1}`} className="aspect-video w-full" />
          <span className="absolute top-0.5 left-0.5 rounded bg-black/70 px-1 font-mono text-[10px]">
            {s.orderIndex + 1}
          </span>
          <span
            className={cn(
              'absolute inset-x-0 bottom-0 h-1',
              {
                success: 'bg-emerald-400',
                warning: 'bg-amber-400',
                info: 'bg-sky-400',
                danger: 'bg-red-500',
                neutral: 'bg-zinc-500',
                muted: 'bg-zinc-700',
                accent: 'bg-violet-400',
              }[STAGE_TONE[s.stage]],
            )}
          />
        </Link>
      ))}
    </div>
  );
}

function CodexLive({ shotId, threadId }: { shotId: string; threadId: string | null }) {
  const live = useAgentLive(shotId);
  if (!live) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-2.5">
      <div className="flex items-center gap-2 text-xs">
        <SparklesIcon className={cn('size-3.5 text-sky-300', live.state === 'running' && 'animate-pulse')} />
        <span className="font-medium">
          {live.state === 'running' ? 'Codex 正在處理…' : `Codex 這一輪結束（${live.turnStatus ?? '—'}）`}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">{formatAgo(live.at)}</span>
      </div>
      {live.state === 'running' ? (
        <div className="text-[11px] text-amber-200/80">
          處理中請不要在 Codex 桌面端對同一個 thread 發訊息。
        </div>
      ) : null}
      {live.commands.length ? (
        <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
          {live.commands.slice(-5).map((c) => (
            <div key={`${c.at}-${c.command}`} className="truncate">
              <span className={c.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>$</span> {c.command}
            </div>
          ))}
        </div>
      ) : null}
      {live.text ? (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">{live.text.slice(-1200)}</div>
      ) : null}
      <OpenInCodex threadId={live.threadId ?? threadId} className="self-start" />
    </div>
  );
}

function ReviewsList({ reviews }: { reviews: WithReviews<Board>['reviews'] }) {
  if (!reviews.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {reviews.map((r) => (
        <div key={r.id} className="flex items-start gap-1.5 text-xs">
          <Tag tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Tag>
          <span className="flex-1 whitespace-pre-wrap">{r.comment}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            <ActorLink actor={r.createdBy} /> · {formatAgo(r.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function VersionRow({
  v,
  kind,
  selected,
  onSelect,
  tasks,
  extra,
}: {
  v: WithReviews<Board> | WithReviews<Take>;
  kind: 'board' | 'take';
  selected: boolean;
  onSelect: () => void;
  tasks: AgentTask[];
  extra?: ReactNode;
}) {
  const notes = notesFor(tasks, v.id);
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md border p-2',
        selected ? 'border-primary bg-primary/5' : 'bg-background/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onSelect}
          className="flex items-center gap-1.5 font-medium text-sm hover:text-primary"
          aria-pressed={selected}
        >
          {kind === 'board' ? <ImageIcon className="size-3.5" /> : <VideoIcon className="size-3.5" />}v
          {v.version}
        </button>
        <VersionBadge status={v.status} />
        {'tier' in v ? <Tag tone="muted">{TIER_LABEL[v.tier]}</Tag> : null}
        {'framesOut' in v && v.framesIn !== null ? (
          <Tag tone={v.framesIn === v.framesOut ? 'muted' : 'danger'}>
            {v.framesOut ?? '?'}/{v.framesIn} 幀
          </Tag>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          <ActorLink actor={v.createdBy} /> · {formatUsd(v.costUsd)} · {formatTime(v.createdAt)}
        </span>
      </div>
      {v.error ? <div className="text-red-300 text-xs">失敗原因：{v.error}</div> : null}
      {notes.produced.map((t) => (
        <div key={t.id} className="text-sky-200 text-xs">
          Codex：{t.resultNote}
        </div>
      ))}
      <ReviewsList reviews={v.reviews} />
      {notes.about
        .filter((t) => t.status !== 'done')
        .map((t) => (
          <div key={t.id} className="text-[11px] text-muted-foreground">
            意見已交給 Codex（
            {t.status === 'needs_user' ? '需要你回覆' : t.status === 'claimed' ? '處理中' : t.status}）
          </div>
        ))}
      {extra}
    </div>
  );
}

export function ReviewPage() {
  const { ref, shotId } = useParams({ from: '/projects/$ref/review/$shotId' });
  const overview = useOverview(ref);
  const detail = useShot(shotId);
  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorState error={detail.error} />;
  return <ReviewBody key={shotId} d={detail.data} shots={overview.data?.shots ?? []} projectRef={ref} />;
}

function ReviewBody({ d, shots, projectRef }: { d: ShotDetail; shots: OverviewShot[]; projectRef: string }) {
  const navigate = useNavigate();
  const sliderRef = useRef<CompareSliderHandle>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [target, setTarget] = useState<Target | null>(() => defaultTarget(d));
  const [comment, setComment] = useState('');
  const [extra, setExtra] = useState('');
  const [tier, setTier] = useState<GenerationTier>(d.project.tier);
  const [forceTake, setForceTake] = useState(false);
  const [confirmKeep, setConfirmKeep] = useState(false);
  const commentId = useId();
  const extraId = useId();
  const [tab, setTab] = useState<'board' | 'take'>(
    target?.type ?? (d.shot.mode === 'replace' ? 'board' : 'take'),
  );

  const shot = d.shot;
  const index = shots.findIndex((s) => s.id === shot.id);
  const prev = index > 0 ? shots[index - 1] : undefined;
  const next = index >= 0 ? shots[index + 1] : undefined;
  const fps = { num: d.fps.num, den: d.fps.den };

  // Keep the selection valid as versions appear (a new version generated for this shot becomes current).
  const latestIds = `${d.boards.at(-1)?.id}|${d.takes.at(-1)?.id}`;
  const seenLatest = useRef(latestIds);
  useEffect(() => {
    if (seenLatest.current !== latestIds) {
      seenLatest.current = latestIds;
      const t = defaultTarget(d);
      setTarget(t);
      if (t) setTab(t.type);
    }
  }, [latestIds, d]);

  const board = d.boards.find((b) => target?.type === 'board' && b.id === target.id) ?? d.boards.at(-1);
  const take =
    d.takes.find((t) => target?.type === 'take' && t.id === target.id) ??
    d.takes.filter((t) => t.tier === d.project.tier).at(-1) ??
    d.takes.at(-1);
  const current: (WithReviews<Board> | WithReviews<Take>) | undefined =
    target?.type === 'board'
      ? d.boards.find((b) => b.id === target.id)
      : d.takes.find((t) => t.id === target?.id);

  const repKeyframe =
    d.keyframes.find((k) => k.frame === shot.repFrame) ??
    d.keyframes.find((k) => k.role === 'rep') ??
    d.keyframes.find((k) => k.role === 'mid');
  const removable = d.overlays.filter((o) => o.remove);

  const review = useAction(
    (v: { verdict: Verdict; comment?: string }) =>
      api.post<ReviewResult>('/api/reviews', {
        targetId: current?.id,
        verdict: v.verdict,
        comment: v.comment,
      }),
    {
      success: (r, v) =>
        v.verdict === 'changes'
          ? r.task
            ? '意見已送出，Codex 會接手處理'
            : '意見已送出'
          : v.verdict === 'regenerate'
            ? '已排入重新生成'
            : `已${VERDICT_LABEL[v.verdict]}`,
      onSuccess: (_r, v) => {
        if (v.verdict === 'changes') setComment('');
        setConfirmKeep(false);
      },
    },
  );

  const reportQueue = (r: BoardQueue | TakeQueue, what: string) => {
    if (r.queued.length) toast.success(`已排入${what}生成`);
    for (const e of r.errors) toast.error(`${what}無法生成`, { description: e.error.message });
  };
  const genBoard = useAction(
    () =>
      api.post<BoardQueue>(`/api/projects/${encodeURIComponent(projectRef)}/boards`, {
        shotIds: [shot.id],
        ...(extra.trim() ? { extra: extra.trim() } : {}),
      }),
    { onSuccess: (r) => reportQueue(r, '分鏡圖') },
  );
  const genTake = useAction(
    () =>
      api.post<TakeQueue>(`/api/projects/${encodeURIComponent(projectRef)}/takes`, {
        shotIds: [shot.id],
        tier,
        force: forceTake,
        ...(extra.trim() ? { extra: extra.trim() } : {}),
      }),
    { onSuccess: (r) => reportQueue(r, '分鏡視頻') },
  );
  const stillTake = useAction(() => api.post(`/api/shots/${shot.id}/still-take`, { tier }), {
    success: '已排入：用分鏡圖做靜態鏡頭（不呼叫模型、不收費）',
  });
  const setMode = useAction((mode: ShotMode) => api.patch(`/api/shots/${shot.id}`, { mode }), {
    success: (_r, mode) => `處理方式改為${MODE_LABEL[mode]}`,
  });
  const promote = useAction((id: string) => api.post(`/api/takes/${id}/promote`), {
    success: '已排入下一檔生成，完成後需要再確認一次',
  });

  const canApprove = current && (current.status === 'ready' || current.status === 'approved');
  const approve = () => {
    if (!current) return;
    if (current.status !== 'ready') {
      toast.info(current.status === 'approved' ? '這個版本已經通過' : '只有待評審的版本可以通過');
      return;
    }
    review.mutate({ verdict: 'approve' });
  };
  const requestChanges = () => {
    if (!comment.trim()) {
      toast.error('要求修改需要填寫意見');
      commentRef.current?.focus();
      return;
    }
    review.mutate({ verdict: 'changes', comment: comment.trim() });
  };

  const keys = useRef({ approve, prev, next });
  keys.current = { approve, prev, next };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const k = keys.current;
      const go = (s: OverviewShot | undefined) =>
        s &&
        void navigate({ to: '/projects/$ref/review/$shotId', params: { ref: projectRef, shotId: s.id } });
      if (e.key === 'a' || e.key === 'A') k.approve();
      else if (e.key === 'r' || e.key === 'R') {
        commentRef.current?.focus();
        e.preventDefault();
      } else if (e.key === 'ArrowRight') go(k.next);
      else if (e.key === 'ArrowLeft') go(k.prev);
      else if (e.key === ' ') sliderRef.current?.togglePlay();
      else if (e.key === ',') sliderRef.current?.step(-1);
      else if (e.key === '.') sliderRef.current?.step(1);
      else return;
      if (e.key === ' ') e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, projectRef]);

  const takeCompare = take ? comparePathOf(take) : null;
  const hasBoardStage = shot.mode === 'replace';
  const boardApproved = d.boards.some((b) => b.status === 'approved');
  const generates = shot.mode === 'replace' || shot.mode === 'clean';
  const openTasks = d.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');

  return (
    <div className="flex flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            評審台 · 分鏡 #{shot.orderIndex + 1}
            <ModeBadge mode={shot.mode} />
            <StageBadge stage={d.stage} />
          </span>
        }
        description={
          <span>
            f {shot.startFrame}–{shot.endFrame}（{shot.frameCount} 幀，{d.seconds} 秒）· 目前檔位{' '}
            {TIER_LABEL[d.project.tier]} · 快捷鍵 <Kbd>A</Kbd> 通過 <Kbd>R</Kbd> 要求修改 <Kbd>←</Kbd>
            <Kbd>→</Kbd> 上／下一鏡 <Kbd>空白</Kbd> 播放 <Kbd>,</Kbd>
            <Kbd>.</Kbd> 逐幀
          </span>
        }
        actions={
          <>
            <DiscussInCodex
              projectRef={projectRef}
              targetType={current ? (target?.type ?? 'shot') : 'shot'}
              targetId={current?.id ?? shot.id}
              what={
                current
                  ? `分鏡 #${shot.orderIndex + 1} 的${target?.type === 'board' ? '分鏡圖' : '分鏡視頻'} v${current.version}`
                  : `分鏡 #${shot.orderIndex + 1}`
              }
            />
            <OpenInCodex threadId={d.codexThreadId} />
            <Button
              size="sm"
              variant="outline"
              disabled={!prev}
              onClick={() =>
                prev &&
                void navigate({
                  to: '/projects/$ref/review/$shotId',
                  params: { ref: projectRef, shotId: prev.id },
                })
              }
            >
              <ChevronLeftIcon />
              上一鏡
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!next}
              onClick={() =>
                next &&
                void navigate({
                  to: '/projects/$ref/review/$shotId',
                  params: { ref: projectRef, shotId: next.id },
                })
              }
            >
              下一鏡
              <ChevronRightIcon />
            </Button>
          </>
        }
      />
      <ShotStrip shots={shots} current={shot.id} projectRef={projectRef} />
      <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          {hasBoardStage ? (
            <Card>
              <CardHeader>
                <ImageIcon className="size-4" />
                <CardTitle>分鏡圖</CardTitle>
                {board ? (
                  <span className="text-muted-foreground text-xs">
                    v{board.version} · <VersionBadge status={board.status} />
                  </span>
                ) : null}
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    原代表幀 f {repKeyframe?.frame ?? shot.repFrame}
                    {removable.length ? `（紅框：要去掉的字幕 ${removable.length} 處）` : ''}
                  </span>
                  <FrameWithOverlays src={fileUrl(repKeyframe?.path)} alt="原代表幀" overlays={d.overlays} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">
                    {board ? `分鏡圖 v${board.version}` : '還沒有分鏡圖'}
                  </span>
                  {board?.path ? (
                    <Thumb
                      src={fileUrl(board.path)}
                      alt={`分鏡圖 v${board.version}`}
                      fit="contain"
                      className="aspect-video w-full rounded-md"
                      zoom
                      gallery={[
                        ...(repKeyframe ? [{ src: fileUrl(repKeyframe.path) ?? '', alt: '原代表幀' }] : []),
                        { src: fileUrl(board.path) ?? '', alt: `分鏡圖 v${board.version}` },
                      ]}
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
                      {board
                        ? board.status === 'failed'
                          ? '生成失敗'
                          : '生成中…'
                        : '按右側「生成分鏡圖」開始'}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex flex-col gap-2">
                <span className="text-muted-foreground text-xs">
                  {shot.mode === 'clean'
                    ? '去字分鏡：不做分鏡圖，直接生成分鏡視頻。'
                    : shot.mode === 'keep'
                      ? '這一鏡沿用原片，不需要生成。'
                      : '這一鏡已排除。'}
                </span>
                <div className="max-w-xl">
                  <FrameWithOverlays src={fileUrl(repKeyframe?.path)} alt="原代表幀" overlays={d.overlays} />
                </div>
              </CardContent>
            </Card>
          )}
          {generates || d.takes.length ? (
            <Card>
              <CardHeader>
                <VideoIcon className="size-4" />
                <CardTitle>分鏡視頻</CardTitle>
                {take ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                    v{take.version} · {TIER_LABEL[take.tier]} · <VersionBadge status={take.status} />
                  </span>
                ) : null}
              </CardHeader>
              <CardContent>
                {take && takeCompare ? (
                  <CompareSlider
                    ref={sliderRef}
                    src={fileUrl(takeCompare) ?? ''}
                    fps={fps}
                    frameCount={take.framesOut ?? shot.frameCount}
                    leftLabel="原片"
                    rightLabel={`v${take.version}`}
                  />
                ) : (
                  <div className="flex aspect-video items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
                    {take
                      ? take.status === 'failed'
                        ? `生成失敗：${take.error ?? ''}`
                        : '生成中，完成後會出現對比播放器…'
                      : '還沒有分鏡視頻'}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>版本歷史</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs value={tab} onValueChange={(v) => setTab(v as 'board' | 'take')}>
                <TabsList>
                  {hasBoardStage || d.boards.length ? (
                    <TabsTrigger value="board">分鏡圖（{d.boards.length}）</TabsTrigger>
                  ) : null}
                  <TabsTrigger value="take">分鏡視頻（{d.takes.length}）</TabsTrigger>
                </TabsList>
                <TabsContent value="board" className="flex flex-col gap-2">
                  {[...d.boards].reverse().map((b) => (
                    <VersionRow
                      key={b.id}
                      v={b}
                      kind="board"
                      tasks={d.tasks}
                      selected={current?.id === b.id}
                      onSelect={() => setTarget({ type: 'board', id: b.id })}
                    />
                  ))}
                  {!d.boards.length ? <EmptyState>還沒有分鏡圖版本</EmptyState> : null}
                </TabsContent>
                <TabsContent value="take" className="flex flex-col gap-2">
                  {[...d.takes].reverse().map((t) => (
                    <VersionRow
                      key={t.id}
                      v={t}
                      kind="take"
                      tasks={d.tasks}
                      selected={current?.id === t.id}
                      onSelect={() => setTarget({ type: 'take', id: t.id })}
                      extra={
                        t.status === 'approved' && t.tier !== 'final' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-start"
                            disabled={promote.isPending}
                            onClick={() => promote.mutate(t.id)}
                          >
                            <ArrowUpCircleIcon />
                            升級到{TIER_LABEL[TIERS[TIERS.indexOf(t.tier) + 1] ?? 'final']}
                          </Button>
                        ) : null
                      }
                    />
                  ))}
                  {!d.takes.length ? <EmptyState>還沒有分鏡視頻版本</EmptyState> : null}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>評審</CardTitle>
              {current ? (
                <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  {target?.type === 'board' ? '分鏡圖' : '分鏡視頻'} v{current.version}
                  <VersionBadge status={current.status} />
                </span>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {!current ? (
                <span className="text-muted-foreground text-xs">還沒有可以評審的版本。</span>
              ) : (
                <>
                  <Button
                    variant="success"
                    disabled={!canApprove || current.status === 'approved' || review.isPending}
                    onClick={approve}
                  >
                    <CheckIcon />
                    通過 <Kbd>A</Kbd>
                  </Button>
                  <Label htmlFor={commentId} className="mt-1">
                    要求修改（必填意見，會交給 Codex 處理）
                  </Label>
                  <Textarea
                    id={commentId}
                    ref={commentRef}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) requestChanges();
                      if (e.key === 'Escape') e.currentTarget.blur();
                    }}
                    placeholder="例如：頭髮改成銀色，逆光再強一點（⌘↵ 送出）"
                  />
                  <Button
                    variant="destructive"
                    disabled={review.isPending || !comment.trim()}
                    onClick={requestChanges}
                  >
                    <MessageSquareIcon />
                    要求修改 <Kbd>R</Kbd>
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        review.isPending || current.status === 'queued' || current.status === 'generating'
                      }
                      onClick={() => review.mutate({ verdict: 'regenerate' })}
                    >
                      <RefreshCwIcon />
                      直接重生
                    </Button>
                    <Button
                      variant="outline"
                      disabled={review.isPending}
                      onClick={() => setConfirmKeep(true)}
                    >
                      <UndoIcon />
                      此鏡沿用原片
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>生成</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">處理方式</span>
                <Select value={shot.mode} onValueChange={(v) => setMode.mutate(v as ShotMode)}>
                  <SelectTrigger size="sm" className="flex-1" aria-label="處理方式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHOT_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {generates ? (
                <>
                  <Label htmlFor={extraId}>附加提示（可留空）</Label>
                  <Textarea
                    id={extraId}
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                    placeholder="加在提示詞後面的補充說明"
                    className="min-h-12"
                  />
                </>
              ) : null}
              {hasBoardStage ? (
                <Button
                  variant="secondary"
                  disabled={genBoard.isPending}
                  onClick={() => genBoard.mutate(undefined)}
                >
                  <ImageIcon />
                  生成分鏡圖
                </Button>
              ) : null}
              {generates ? (
                <>
                  <div className="flex items-center gap-2">
                    <Select value={tier} onValueChange={(v) => setTier(v as GenerationTier)}>
                      <SelectTrigger size="sm" className="flex-1" aria-label="生成檔位">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIERS.map((t) => (
                          <SelectItem key={t} value={t}>
                            {TIER_LABEL[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="secondary"
                      disabled={genTake.isPending}
                      onClick={() => genTake.mutate(undefined)}
                    >
                      <VideoIcon />
                      生成分鏡視頻
                    </Button>
                  </div>
                  {hasBoardStage ? (
                    <Label className="text-[11px]">
                      <Checkbox checked={forceTake} onCheckedChange={(v) => setForceTake(v === true)} />
                      分鏡圖未通過也強制生成
                    </Label>
                  ) : null}
                  {hasBoardStage && boardApproved ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={stillTake.isPending}
                      title="影片模型一直擋這個分鏡時使用：把已通過的分鏡圖做成同長度的鏡頭，帶一點推近"
                      onClick={() => stillTake.mutate(undefined)}
                    >
                      <ImageIcon />
                      改用分鏡圖做靜態鏡頭
                    </Button>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground text-xs">沿用原片或排除的分鏡不需要生成。</span>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SparklesIcon className="size-4" />
              <CardTitle>Codex</CardTitle>
              <OpenInCodex threadId={d.codexThreadId} className="ml-auto" />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <CodexLive shotId={shot.id} threadId={d.codexThreadId} />
              {openTasks.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
              {!openTasks.length ? (
                <span className="text-muted-foreground text-xs">
                  這一鏡目前沒有進行中的 Codex 任務。按「要求修改」後會自動交給 Codex。
                </span>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirmKeep}
        onOpenChange={setConfirmKeep}
        title="這一鏡改為沿用原片？"
        description="處理方式會改成「沿用原片」，合成時使用原片段，不再生成。之後可以在分鏡頁改回來。"
        confirmLabel="沿用原片"
        pending={review.isPending}
        onConfirm={() => review.mutate({ verdict: 'keep_original' })}
      />
    </div>
  );
}
