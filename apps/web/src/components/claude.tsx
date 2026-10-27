import { ClipboardCopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/lib/queries';
import type { AgentTask, ReviewResult, RoutedTo } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Who a task was routed to (`payload.routedTo`, as core's `routeOf`); null until the dispatcher judges it. */
export const routeOf = (t: AgentTask): RoutedTo | null =>
  t.payload.routedTo === 'claude' || t.payload.routedTo === 'codex' ? t.payload.routedTo : null;

const active = (t: AgentTask) => t.status !== 'done' && t.status !== 'cancelled';

/** 等 Claude 處理: routed to Claude and not finished; it stays open until Claude Code takes it from its TUI. */
export const waitingForClaude = (t: AgentTask) => routeOf(t) === 'claude' && active(t);

/** The agent working on (or waiting for) a task, for labels: Codex unless routed to or claimed by Claude. */
export const agentName = (t: AgentTask) =>
  routeOf(t) === 'claude' || t.claimedBy === 'claude' ? 'Claude' : 'Codex';

/** The toast after 要求修改: who the new task went to, when it was routed at once. */
export const sentTo = (r: ReviewResult) =>
  r.task && routeOf(r.task) ? `意見已交給 ${agentName(r.task)}` : '意見已送出';

/** The configured default for tasks nobody picked an agent for (`agents.default`); Claude when unknown. */
export const useDefaultAgent = () => useSettings().data?.agents?.default ?? 'claude';

/** `cd <workspace> && claude "處理 AniRecast 待辦任務"`, from `/api/settings`; undefined until known. */
export const useClaudeCommand = () => useSettings().data?.agents?.claudeCommand;

export const copyText = (text: string, done: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    () => toast.error('無法寫入剪貼簿', { description: text }),
  );

/** Copies the command that starts Claude Code on the waiting tasks (`fallback`: one the server just returned). */
export function CopyClaudeCommand({
  fallback,
  label = '複製指令',
  className,
}: {
  fallback?: string;
  label?: string;
  className?: string;
}) {
  const command = useClaudeCommand() ?? fallback;
  if (!command) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn('h-6 px-1.5 text-[11px]', className)}
      title={command}
      onClick={() => void copyText(command, '指令已複製：貼到終端機執行，再說「處理任務」')}
    >
      <ClipboardCopyIcon />
      {label}
    </Button>
  );
}

/**
 * How many of these tasks wait for Claude, with the command to start it — for the task centre and the overview.
 * Nothing when none waits (one waiting for the human's answer is not counted).
 */
export function ClaudeQueue({ tasks, className }: { tasks: AgentTask[] | undefined; className?: string }) {
  const waiting = (tasks ?? []).filter((t) => waitingForClaude(t) && t.status !== 'needs_user');
  if (!waiting.length) return null;
  const working = waiting.filter((t) => t.status === 'claimed').length;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-sky-100 text-xs',
        className,
      )}
    >
      <span>
        {waiting.length} 個任務等 Claude 處理{working ? `（${working} 個處理中）` : ''}：在 Claude Code
        說「處理任務」
      </span>
      <CopyClaudeCommand label="複製啟動指令" className="ml-auto" />
    </div>
  );
}
