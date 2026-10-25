import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, LockIcon, SendIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Tag, Thumb } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { formatAgo } from '@/lib/format';
import {
  ASSIGNED_BY_LABEL,
  actorLabel,
  MODE_LABEL,
  MODE_TONE,
  STAGE_LABEL,
  STAGE_TONE,
  TASK_KIND_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  VERSION_STATUS_LABEL,
  VERSION_STATUS_TONE,
} from '@/lib/labels';
import { qk, useAction } from '@/lib/queries';
import type { AgentTask, AssignedBy, ShotMode, ShotStage, TextOverlay, VersionStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

export const StageBadge = ({ stage }: { stage: ShotStage }) => (
  <Tag tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Tag>
);
export const ModeBadge = ({ mode }: { mode: ShotMode }) => (
  <Tag tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Tag>
);
export const VersionBadge = ({ status }: { status: VersionStatus }) => (
  <Tag tone={VERSION_STATUS_TONE[status]}>{VERSION_STATUS_LABEL[status]}</Tag>
);

export function AssignedByBadge({ by }: { by: AssignedBy }) {
  return (
    <Tag tone={by === 'user' ? 'accent' : by === 'codex' ? 'info' : 'muted'}>
      {by === 'user' ? <LockIcon /> : null}
      {ASSIGNED_BY_LABEL[by]}
    </Tag>
  );
}

export const codexThreadUrl = (threadId: string) => `codex://threads/${threadId}`;

/** `codex:<thread>` actors link to their Codex thread. */
export function ActorLink({ actor }: { actor: string }) {
  const thread = actor.startsWith('codex:') ? actor.slice('codex:'.length) : null;
  if (!thread) return <span>{actorLabel(actor)}</span>;
  return (
    <a
      href={codexThreadUrl(thread)}
      className="inline-flex items-center gap-0.5 text-sky-300 hover:underline"
    >
      Codex
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

export function OpenInCodex({
  threadId,
  className,
}: {
  threadId: string | null | undefined;
  className?: string;
}) {
  if (!threadId) return null;
  return (
    <Button asChild size="sm" variant="outline" className={className}>
      <a
        href={codexThreadUrl(threadId)}
        title={`thread ${threadId}（打不開時可用 codex resume ${threadId}）`}
      >
        <ExternalLinkIcon />在 Codex 打開
      </a>
    </Button>
  );
}

/** A keyframe with the overlay text boxes drawn on top (red = will be removed, grey = kept). */
export function FrameWithOverlays({
  src,
  alt,
  overlays = [],
  className,
}: {
  src: string | undefined;
  alt: string;
  overlays?: TextOverlay[];
  className?: string;
}) {
  return (
    <div className={cn('relative aspect-video overflow-hidden rounded-md bg-black', className)}>
      <Thumb src={src} alt={alt} fit="contain" className="h-full w-full" />
      {overlays.map((o) => {
        const [x0, y0, x1, y1] = o.bbox;
        return (
          <div
            key={o.id}
            title={o.text ?? ''}
            className={cn(
              'pointer-events-none absolute border',
              o.remove ? 'border-red-400 border-dashed bg-red-500/10' : 'border-white/40',
            )}
            style={{
              left: `${x0 * 100}%`,
              top: `${y0 * 100}%`,
              width: `${(x1 - x0) * 100}%`,
              height: `${(y1 - y0) * 100}%`,
            }}
          />
        );
      })}
    </div>
  );
}

export function TaskCard({
  task,
  showShot,
  projectSlug,
}: {
  task: AgentTask;
  showShot?: boolean;
  projectSlug?: string;
}) {
  const [answer, setAnswer] = useState('');
  const answerTask = useAction((text: string) => api.post(`/api/tasks/${task.id}/answer`, { answer: text }), {
    success: '已回覆，任務會繼續',
    invalidate: [qk.tasks, ['project'], ['shot']],
    onSuccess: () => setAnswer(''),
  });
  const cancel = useAction(() => api.post(`/api/tasks/${task.id}/cancel`), {
    success: '已取消任務',
    invalidate: [qk.tasks, ['project'], ['shot']],
  });
  const payload = task.payload as { comment?: string; targetType?: string; targetId?: string };
  const active = task.status !== 'done' && task.status !== 'cancelled';
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Tag>
        <span className="font-medium text-xs">{TASK_KIND_LABEL[task.kind] ?? task.kind}</span>
        {payload.targetType ? (
          <span className="text-muted-foreground text-xs">
            {payload.targetType === 'board' ? '分鏡圖' : '分鏡視頻'}
          </span>
        ) : null}
        {showShot && task.shotId && projectSlug ? (
          <Link
            to="/projects/$ref/review/$shotId"
            params={{ ref: projectSlug, shotId: task.shotId }}
            className="text-primary text-xs hover:underline"
          >
            開啟分鏡
          </Link>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">{formatAgo(task.updatedAt)}</span>
        {active ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="取消任務"
            title="取消任務"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(undefined)}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {payload.comment ? <div className="text-xs">意見：{payload.comment}</div> : null}
      {task.resultNote ? <div className="text-sky-200 text-xs">Codex：{task.resultNote}</div> : null}
      {task.status === 'needs_user' && task.question ? (
        <div className="flex flex-col gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2">
          <div className="whitespace-pre-wrap text-amber-100 text-xs">Codex 問：{task.question}</div>
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="回覆 Codex…"
            className="min-h-12 text-xs"
          />
          <Button
            size="sm"
            className="self-end"
            disabled={!answer.trim() || answerTask.isPending}
            onClick={() => answerTask.mutate(answer.trim())}
          >
            <SendIcon />
            回覆
          </Button>
        </div>
      ) : null}
      {task.answer ? <div className="text-muted-foreground text-xs">你的回覆：{task.answer}</div> : null}
    </div>
  );
}
