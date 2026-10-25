import { Link, useParams } from '@tanstack/react-router';
import { RotateCcwIcon, SquareIcon } from 'lucide-react';
import { useState } from 'react';
import { DiscussionBadge } from '@/components/codex';
import { EmptyState, ErrorState, Loading, PageHeader, Tag } from '@/components/common';
import { ActorLink, TaskCard } from '@/components/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatAgo, formatTime, formatUsd } from '@/lib/format';
import { JOB_STATUS_LABEL, JOB_STATUS_TONE, jobTypeLabel, LANE_LABEL, TIER_LABEL } from '@/lib/labels';
import {
  qk,
  useAction,
  useCost,
  useDiscussions,
  useHealth,
  useJobs,
  useOverview,
  useProjects,
  useTasks,
} from '@/lib/queries';
import type { GenerationTier, Job } from '@/lib/types';

type JobFilter = 'active' | 'failed' | 'all';

function JobRow({ job, projectSlug }: { job: Job; projectSlug: string | undefined }) {
  const cancel = useAction(() => api.post(`/api/jobs/${job.id}/cancel`), {
    success: '已要求取消',
    invalidate: [qk.jobs],
  });
  const retry = useAction(() => api.post(`/api/jobs/${job.id}/retry`), {
    success: '已重新排入',
    invalidate: [qk.jobs],
  });
  const active = job.status === 'queued' || job.status === 'running';
  return (
    <tr className="border-b border-border/50 align-top">
      <td className="py-1.5 pr-2">
        <div className="font-medium">{jobTypeLabel(job.type)}</div>
        <div className="font-mono text-[10px] text-muted-foreground">{job.id}</div>
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">{LANE_LABEL[job.lane] ?? job.lane}</td>
      <td className="py-1.5 pr-2">
        {projectSlug ? (
          <Link to="/projects/$ref" params={{ ref: projectSlug }} className="text-primary hover:underline">
            {projectSlug}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1.5 pr-2">
        <Tag tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABEL[job.status]}</Tag>
        {job.cancelRequested && active ? <div className="text-[10px] text-amber-300">取消中…</div> : null}
      </td>
      <td className="w-56 py-1.5 pr-2">
        {job.status === 'running' ? (
          <div className="flex flex-col gap-1">
            <Progress value={Math.round(job.progress * 100)} />
            <span className="text-[11px] text-muted-foreground">
              {Math.round(job.progress * 100)}% {job.message ?? ''}
            </span>
          </div>
        ) : job.error ? (
          <div className="text-[11px] text-red-300">
            {job.error.message}
            {job.error.hint ? <div className="text-muted-foreground">{job.error.hint}</div> : null}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">{job.message ?? ''}</span>
        )}
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">
        {job.attempts}/{job.maxAttempts}
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">
        <ActorLink actor={job.requestedBy} />
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground" title={formatTime(job.createdAt)}>
        {formatAgo(job.finishedAt ?? job.startedAt ?? job.createdAt)}
      </td>
      <td className="py-1.5 text-right">
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={cancel.isPending || job.cancelRequested}
            onClick={() => cancel.mutate(undefined)}
          >
            <SquareIcon />
            取消
          </Button>
        ) : job.status === 'failed' || job.status === 'cancelled' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={retry.isPending}
            onClick={() => retry.mutate(undefined)}
          >
            <RotateCcwIcon />
            重試
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function CodexStatusCard() {
  const health = useHealth();
  const codex = health.data?.codex;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Codex 自動派發</CardTitle>
        {codex ? (
          <Tag tone={codex.enabled ? 'success' : 'muted'} className="ml-auto">
            {codex.enabled ? '開啟' : '關閉'}
          </Tag>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        {!codex ? (
          <Loading className="p-0" />
        ) : !codex.enabled ? (
          <span className="text-muted-foreground">
            自動派發已暫停（設定 codex.autoDispatch）。仍可在 Codex 對話裡說「處理評審」以手動模式處理。
          </span>
        ) : (
          <>
            <span>
              執行檔：
              {codex.codex
                ? `${codex.codex.command}（${codex.codex.version ?? '版本不明'}，${codex.codex.source}）`
                : '尚未啟動'}
            </span>
            <span>
              Workspace 專案：
              {codex.projectId ?? (
                <span className="text-amber-300">找不到，請在 Codex 桌面端把 Workspace 資料夾加為專案</span>
              )}
            </span>
            <span>正在處理：{codex.busyTaskId ?? '—'}</span>
            {codex.lastError ? <span className="text-red-300">上次錯誤：{codex.lastError}</span> : null}
            {codex.rateLimits ? (
              <details>
                <summary className="cursor-pointer text-muted-foreground">額度狀態</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 text-[10px]">
                  {JSON.stringify(codex.rateLimits, null, 2)}
                </pre>
              </details>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CostCard() {
  const cost = useCost();
  return (
    <Card>
      <CardHeader>
        <CardTitle>成本帳本（整個 Workspace）</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {cost.isError ? <ErrorState error={cost.error} className="m-0" /> : null}
        {cost.data ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-xl">{formatUsd(cost.data.totalUsd)}</span>
              <span className="text-muted-foreground">
                上限 {cost.data.capUsd === null ? '未設定' : formatUsd(cost.data.capUsd)}
              </span>
            </div>
            {cost.data.breakdown.map((b) => (
              <div key={`${b.model}-${b.tier}`} className="flex gap-2">
                <span className="flex-1 truncate">{b.model}</span>
                <span className="text-muted-foreground">
                  {b.tier ? (TIER_LABEL[b.tier as GenerationTier] ?? b.tier) : ''}
                </span>
                <span className="font-mono">{b.calls} 次</span>
                <span className="font-mono">{formatUsd(b.usd)}</span>
              </div>
            ))}
            {!cost.data.breakdown.length ? (
              <span className="text-muted-foreground">還沒有付費呼叫。</span>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The task centre of one project: its background jobs, its Codex tasks, Codex status and its cost. */
export function ProjectTasksPage() {
  const { ref } = useParams({ from: '/projects/$ref' });
  const overview = useOverview(ref);
  if (overview.isPending) return <Loading />;
  if (overview.isError) return <ErrorState error={overview.error} />;
  return (
    <TasksPage
      projectId={overview.data.project.id}
      projectName={overview.data.project.name}
      projectRef={ref}
    />
  );
}

/** The project's Codex discussions, newest first; a conclusion waiting to be imported stands out. */
function DiscussionsCard({ projectRef }: { projectRef: string }) {
  const discussions = useDiscussions(projectRef);
  const [showClosed, setShowClosed] = useState(false);
  const list = (discussions.data ?? []).filter((h) => showClosed || h.status !== 'closed');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Codex 討論</CardTitle>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? '隱藏已結束' : '包含已結束'}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {discussions.isError ? <ErrorState error={discussions.error} className="m-0" /> : null}
        {list.map((h) => (
          <Link
            key={h.id}
            to="/projects/$ref/codex/$discussionId"
            params={{ ref: projectRef, discussionId: h.id }}
            className="flex flex-col gap-1 rounded-md border bg-background/40 p-2.5 hover:border-foreground/30"
          >
            <span className="flex items-center gap-1.5">
              <DiscussionBadge status={h.status} />
              <span className="truncate font-medium text-xs">{h.targetLabel}</span>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {formatAgo(h.updatedAt)}
              </span>
            </span>
            <span className="line-clamp-2 text-muted-foreground text-xs">{h.topic}</span>
          </Link>
        ))}
        {discussions.data && !list.length ? (
          <span className="text-muted-foreground text-xs">
            還沒有討論。遇到一句意見說不清的問題，在分鏡、角色設計或角色頁按「和 Codex 討論」。
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function TasksPage({
  projectId,
  projectName,
  projectRef,
}: {
  projectId?: string;
  projectName?: string;
  projectRef?: string;
} = {}) {
  const allJobs = useJobs();
  const allTasks = useTasks();
  const projects = useProjects();
  // Scoped to a project when opened from one; jobs without a project (downloads, imports) stay global.
  const scope = <T extends { projectId: string | null }>(list: T[] | undefined) =>
    projectId ? list?.filter((x) => x.projectId === projectId) : list;
  const jobs = { ...allJobs, data: scope(allJobs.data) };
  const tasks = { ...allTasks, data: scope(allTasks.data) };
  const [filter, setFilter] = useState<JobFilter>('all');
  const [showDone, setShowDone] = useState(false);
  const slugOf = (id: string | null) => (id ? projects.data?.find((p) => p.id === id)?.slug : undefined);

  const jobList = (jobs.data ?? []).filter((j) =>
    filter === 'active'
      ? j.status === 'queued' || j.status === 'running'
      : filter === 'failed'
        ? j.status === 'failed'
        : true,
  );
  const taskList = (tasks.data ?? [])
    .filter((t) => showDone || (t.status !== 'done' && t.status !== 'cancelled'))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeCount = (jobs.data ?? []).filter((j) => j.status === 'queued' || j.status === 'running').length;
  const failedCount = (jobs.data ?? []).filter((j) => j.status === 'failed').length;

  return (
    <div className="flex flex-col">
      <PageHeader
        title={projectName ? `任務中心 · ${projectName}` : '任務中心'}
        description="這個項目的背景任務（偵測、生成、合成）、Codex 討論、Codex Agent 任務和成本。"
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>背景任務</CardTitle>
            <Tabs value={filter} onValueChange={(v) => setFilter(v as JobFilter)} className="ml-auto">
              <TabsList>
                <TabsTrigger value="all">全部</TabsTrigger>
                <TabsTrigger value="active">進行中 {activeCount || ''}</TabsTrigger>
                <TabsTrigger value="failed">失敗 {failedCount || ''}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {jobs.isPending ? <Loading /> : null}
            {jobs.isError ? <ErrorState error={jobs.error} /> : null}
            {jobList.length ? (
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1.5 font-normal">任務</th>
                    <th className="py-1.5 font-normal">通道</th>
                    <th className="py-1.5 font-normal">項目</th>
                    <th className="py-1.5 font-normal">狀態</th>
                    <th className="py-1.5 font-normal">進度／錯誤</th>
                    <th className="py-1.5 font-normal">嘗試</th>
                    <th className="py-1.5 font-normal">發起</th>
                    <th className="py-1.5 font-normal">時間</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobList.map((j) => (
                    <JobRow key={j.id} job={j} projectSlug={slugOf(j.projectId)} />
                  ))}
                </tbody>
              </table>
            ) : jobs.data ? (
              <EmptyState>沒有符合的任務。</EmptyState>
            ) : null}
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          {projectRef ? <DiscussionsCard projectRef={projectRef} /> : null}
          <Card>
            <CardHeader>
              <CardTitle>Agent 任務</CardTitle>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowDone((v) => !v)}>
                {showDone ? '只看進行中' : '包含已完成'}
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {tasks.isError ? <ErrorState error={tasks.error} className="m-0" /> : null}
              {taskList.map((t) => (
                <TaskCard key={t.id} task={t} showShot projectSlug={slugOf(t.projectId)} />
              ))}
              {tasks.data && !taskList.length ? (
                <span className="text-muted-foreground text-xs">沒有 Agent 任務。</span>
              ) : null}
            </CardContent>
          </Card>
          <CodexStatusCard />
          <CostCard />
        </div>
      </div>
    </div>
  );
}
