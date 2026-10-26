import { PauseIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatAgo } from '@/lib/format';
import { qk, useAction, useHealth } from '@/lib/queries';

/** 全部暫停／繼續: stop the daemon from starting new jobs (queued ones wait, running ones finish). */
export function JobsPauseButton() {
  const health = useHealth();
  const paused = health.data?.jobsPaused?.paused ?? false;
  const toggle = useAction(
    () =>
      api.post('/api/jobs/pause', { paused: !paused, ...(paused ? {} : { reason: '在任務中心按了暫停' }) }),
    {
      success: paused ? '已繼續：排隊的任務會開始跑' : '已全部暫停：不再開始新任務',
      invalidate: [qk.health, qk.jobs],
    },
  );
  return (
    <Button
      size="sm"
      variant={paused ? 'default' : 'outline'}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(undefined)}
    >
      {paused ? <PlayIcon /> : <PauseIcon />}
      {paused ? '繼續' : '全部暫停'}
    </Button>
  );
}

/** A strip on every page while jobs are paused, so nothing looks stuck without a reason. */
export function JobsPausedBanner() {
  const health = useHealth();
  const p = health.data?.jobsPaused;
  if (!p?.paused) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-amber-500/40 border-b bg-amber-500/10 px-5 py-1.5 text-amber-200 text-xs">
      <PauseIcon className="size-3.5" />
      <span>
        任務已全部暫停{p.since ? `（${formatAgo(p.since)}）` : ''}：排隊的生成不會開始。
        {p.reason ? `原因：${p.reason}` : ''}
      </span>
      <span className="ml-auto">
        <JobsPauseButton />
      </span>
    </div>
  );
}
