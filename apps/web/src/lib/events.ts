import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { jobTypeLabel } from './labels';
import { qk } from './queries';
import type { AniEvent, Job } from './types';

/** Tiny external store (useSyncExternalStore) so components can subscribe without a state library. */
function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: T | ((prev: T) => T)) => {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Connection = 'connecting' | 'open' | 'closed';
const connection = createStore<Connection>('connecting');
export const useConnection = () => useSyncExternalStore(connection.subscribe, connection.get);

export interface AgentLive {
  taskId: string | null;
  threadId: string | null;
  state: 'running' | 'finished';
  /** Accumulated tail of Codex's current message (the event already carries the whole tail). */
  text: string;
  commands: Array<{ command: string | null; exitCode: number | null; at: number }>;
  turnStatus: string | null;
  at: number;
}

const agentLive = createStore<Record<string, AgentLive>>({});
const EMPTY: AgentLive | undefined = undefined;
/** Live Codex progress for a shot, fed by `agent.*` events. */
export const useAgentLive = (shotId: string | undefined) =>
  useSyncExternalStore(agentLive.subscribe, () => (shotId ? agentLive.get()[shotId] : EMPTY));

function onAgentEvent(e: AniEvent): void {
  const p = (e.payload ?? {}) as {
    shotId?: string | null;
    threadId?: string;
    text?: string;
    command?: string | null;
    exitCode?: number | null;
    turnStatus?: string;
  };
  const shotId = p.shotId;
  if (!shotId) return;
  agentLive.set((all) => {
    const prev = all[shotId];
    const base: AgentLive =
      prev && prev.taskId === e.entityId && e.kind !== 'agent.started'
        ? prev
        : {
            taskId: e.entityId,
            threadId: p.threadId ?? null,
            state: 'running',
            text: '',
            commands: [],
            turnStatus: null,
            at: e.at,
          };
    const next: AgentLive = { ...base, at: e.at, threadId: p.threadId ?? base.threadId };
    if (e.kind === 'agent.progress') next.text = p.text ?? next.text;
    if (e.kind === 'agent.command')
      next.commands = [
        ...base.commands,
        { command: p.command ?? null, exitCode: p.exitCode ?? null, at: e.at },
      ];
    if (e.kind === 'agent.finished') {
      next.state = 'finished';
      next.turnStatus = p.turnStatus ?? null;
    }
    return { ...all, [shotId]: next };
  });
}

/** Which cached queries an event makes stale. */
function keysFor(e: AniEvent): QueryKey[] {
  const project: QueryKey = ['project'];
  const shot: QueryKey = ['shot'];
  const t = e.entityType;
  if (t === 'job') {
    const type = (e.payload as { type?: string } | null)?.type ?? '';
    const keys: QueryKey[] = [qk.jobs, qk.health];
    if (e.kind === 'job.progress' || e.kind === 'job.started') return keys;
    if (type.startsWith('source.')) keys.push(qk.sources);
    if (e.projectId) keys.push(project, shot);
    if (['board.', 'take.', 'render.', 'design.'].some((prefix) => type.startsWith(prefix)))
      keys.push(qk.cost, qk.workspace);
    return keys;
  }
  if (t === 'source') return [qk.sources, project];
  if (t === 'project') return [qk.projects, project];
  if (t === 'persona') return [['personas'], shot, project];
  if (t === 'agent_task') return e.kind.startsWith('agent.') ? [] : [qk.tasks, project, shot];
  if (t === 'workspace' || t === 'daemon') return [qk.workspace, qk.health];
  if (t === 'handoff') return [project, ['codex']];
  if (['clip', 'shot', 'board', 'take', 'render', 'cast', 'tracklet', 'look', 'overlay'].includes(t))
    return [project, shot];
  return [project, shot];
}

function patchJobProgress(qc: QueryClient, e: AniEvent): void {
  const p = e.payload as { progress?: number; message?: string | null };
  qc.setQueryData<Job[]>(qk.jobs, (jobs) =>
    jobs?.map((j) =>
      j.id === e.entityId
        ? { ...j, status: 'running', progress: p.progress ?? j.progress, message: p.message ?? j.message }
        : j,
    ),
  );
}

/** Only a few job outcomes are worth a toast: long user-facing work finishing or failing. */
const TOAST_TYPES = new Set([
  'source.download',
  'source.import',
  'clip.extract',
  'render.compose',
  'cast.identify',
  'cast.tidy',
  'design.analyze',
  'project.style',
]);

function toastFor(e: AniEvent): void {
  const p = e.payload as { type?: string; error?: { message?: string; hint?: string } };
  const type = p.type ?? '';
  if (e.kind === 'job.failed') {
    const message = p.error?.message ?? '';
    toast.error(`${jobTypeLabel(type)}失敗`, {
      description: p.error?.hint ? `${message}（${p.error.hint}）` : message,
    });
  } else if (e.kind === 'job.succeeded' && TOAST_TYPES.has(type)) toast.success(`${jobTypeLabel(type)}完成`);
}

/** One EventSource for the whole app; maps daemon events to TanStack Query invalidations. */
export function useDaemonEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let lastSeq: number | null = null;
    let opened = false;
    let disposed = false;
    const pending = new Map<string, QueryKey>();

    const schedule = (keys: QueryKey[]) => {
      for (const k of keys) pending.set(JSON.stringify(k), k);
      if (flush) return;
      flush = setTimeout(() => {
        flush = undefined;
        for (const k of pending.values()) void qc.invalidateQueries({ queryKey: k });
        pending.clear();
      }, 150);
    };

    const connect = () => {
      connection.set('connecting');
      es = new EventSource(lastSeq === null ? '/api/events' : `/api/events?since=${lastSeq}`);
      es.onopen = () => {
        connection.set('open');
        // After a reconnect, events may have been missed: refresh everything once.
        if (opened) void qc.invalidateQueries();
        opened = true;
      };
      es.addEventListener('event', (msg) => {
        let e: AniEvent;
        try {
          e = JSON.parse((msg as MessageEvent<string>).data) as AniEvent;
        } catch {
          return;
        }
        lastSeq = e.seq;
        if (e.kind.startsWith('agent.')) onAgentEvent(e);
        if (e.kind === 'job.progress') patchJobProgress(qc, e);
        if (e.entityType === 'job') toastFor(e);
        schedule(keysFor(e));
      });
      es.onerror = () => {
        connection.set('closed');
        es?.close();
        if (!disposed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      disposed = true;
      es?.close();
      clearTimeout(retry);
      clearTimeout(flush);
    };
  }, [qc]);
}
