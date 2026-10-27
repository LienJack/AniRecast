import { AniError, newId } from '@anirecast/shared';
import { type LocalConfig, loadConfig } from '../config.ts';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';

export type AgentTaskKind = 'review_feedback' | 'cast_review' | 'shot_review' | 'boards_review';
export type AgentTaskStatus = 'open' | 'claimed' | 'done' | 'needs_user' | 'cancelled';
/** A claim older than this is assumed abandoned and returned to the queue. */
export const AGENT_CLAIM_TIMEOUT_MS = 30 * 60_000;
/** Who works on a task, kept in `payload.routedTo`: Claude Code (from its TUI) or Codex (the dispatcher). */
export type RoutedTo = 'claude' | 'codex';
export interface TaskRoute {
  to: RoutedTo;
  reasons: string[];
}

export interface AgentTask {
  id: string;
  kind: AgentTaskKind;
  reviewId: string | null;
  projectId: string;
  shotId: string | null;
  payload: Record<string, unknown>;
  status: AgentTaskStatus;
  claimedBy: string | null;
  claimedAt: number | null;
  question: string | null;
  answer: string | null;
  resultNote: string | null;
  resultTargetId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  kind: AgentTaskKind;
  review_id: string | null;
  project_id: string;
  shot_id: string | null;
  payload_json: string;
  status: AgentTaskStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  question: string | null;
  answer: string | null;
  result_note: string | null;
  result_target_id: string | null;
  created_at: number;
  updated_at: number;
}

const toTask = (r: Row): AgentTask => ({
  id: r.id,
  kind: r.kind,
  reviewId: r.review_id,
  projectId: r.project_id,
  shotId: r.shot_id,
  payload: fromJson(r.payload_json, {}),
  status: r.status,
  claimedBy: r.claimed_by,
  claimedAt: r.claimed_at,
  question: r.question,
  answer: r.answer,
  resultNote: r.result_note,
  resultTargetId: r.result_target_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getAgentTask(db: Db, id: string): AgentTask {
  const row = one<Row>(db, 'SELECT * FROM agent_tasks WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Agent task not found: ${id}`);
  return toTask(row);
}

export const routeOf = (task: AgentTask): RoutedTo | null =>
  task.payload.routedTo === 'claude' || task.payload.routedTo === 'codex' ? task.payload.routedTo : null;

const AGENT_NAME: Record<RoutedTo, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * The route a task gets without judging its shot: a hand-over to Claude, the human's pick, else the configured
 * default. Null when the default is `auto` — the dispatcher judges those (cuts inside the shot need a scan).
 */
export function presetRoute(
  payload: Record<string, unknown>,
  fallback: LocalConfig['agents']['default'],
): TaskRoute | null {
  // Handed over before routes were recorded; it came after the pick, so it wins.
  if (payload.handoff) return { to: 'claude', reasons: ['已交給 Claude 接手'] };
  const agent = payload.agent;
  if (agent === 'claude' || agent === 'codex')
    return { to: agent, reasons: [`人類指定 ${AGENT_NAME[agent]}`] };
  if (fallback !== 'auto') return { to: fallback, reasons: [`預設交給 ${AGENT_NAME[fallback]}`] };
  return null;
}

export function listAgentTasks(
  db: Db,
  /** `agent`: only the tasks routed to that agent (an unrouted task matches neither). */
  filter: { status?: AgentTaskStatus; projectId?: string; shotId?: string; agent?: RoutedTo } = {},
): AgentTask[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  for (const [k, col] of [
    ['status', 'status'],
    ['projectId', 'project_id'],
    ['shotId', 'shot_id'],
    ['agent', "json_extract(payload_json, '$.routedTo')"],
  ] as const) {
    const v = filter[k];
    if (v) {
      where.push(`${col} = :${k}`);
      params[k] = v;
    }
  }
  return all<Row>(
    db,
    `SELECT * FROM agent_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`,
    params,
  ).map(toTask);
}

function event(
  db: Db,
  task: AgentTask,
  kind: string,
  actor: string,
  extra: Record<string, unknown> = {},
): void {
  appendEvent(db, {
    actor,
    kind,
    entityType: 'agent_task',
    entityId: task.id,
    projectId: task.projectId,
    payload: { kind: task.kind, shotId: task.shotId, status: task.status, ...extra },
  });
}

/**
 * A new open task, routed right away when that needs no judging (see `presetRoute`), so Claude finds its tasks even
 * when the dispatcher is off.
 */
export function createAgentTask(
  db: Db,
  input: {
    kind: AgentTaskKind;
    projectId: string;
    shotId?: string | null;
    reviewId?: string | null;
    payload?: Record<string, unknown>;
    createdBy: string;
  },
  now: number = Date.now(),
): AgentTask {
  const route = presetRoute(input.payload ?? {}, loadConfig().agents.default);
  const payload = {
    ...input.payload,
    ...(route ? { routedTo: route.to, routeReasons: route.reasons } : {}),
  };
  return tx(db, () => {
    const id = newId('task', now);
    run(
      db,
      `INSERT INTO agent_tasks (id, kind, review_id, project_id, shot_id, payload_json, status, created_at, updated_at)
       VALUES (:id, :kind, :reviewId, :projectId, :shotId, :payload, 'open', :now, :now)`,
      {
        id,
        kind: input.kind,
        reviewId: input.reviewId ?? null,
        projectId: input.projectId,
        shotId: input.shotId ?? null,
        payload: toJson(payload),
        now,
      },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.created', input.createdBy, route ? { routedTo: route.to } : {});
    return task;
  });
}

/**
 * Records who works on a task (`payload.routedTo`, with the reasons). `reopen` gives a claimed or waiting task back
 * to the queue for its new agent; `extra` is merged into the payload too.
 */
export function routeAgentTask(
  db: Db,
  id: string,
  route: TaskRoute,
  actor: string,
  opts: { reopen?: boolean; extra?: Record<string, unknown> } = {},
  now: number = Date.now(),
): AgentTask {
  return tx(db, () => {
    const t = getAgentTask(db, id);
    const payload = { ...t.payload, ...opts.extra, routedTo: route.to, routeReasons: route.reasons };
    run(
      db,
      opts.reopen
        ? `UPDATE agent_tasks SET payload_json = :payload, status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = :now WHERE id = :id`
        : 'UPDATE agent_tasks SET payload_json = :payload, updated_at = :now WHERE id = :id',
      { id, payload: toJson(payload), now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.routed', actor, { to: route.to, reasons: route.reasons });
    return task;
  });
}

/**
 * Oldest open task, claimed atomically. Shots with a task already in progress are skipped. `agent` takes only
 * the tasks routed to that agent.
 */
export function claimNextAgentTask(
  db: Db,
  claimedBy: string,
  filter: { kind?: AgentTaskKind; agent?: RoutedTo } = {},
  now: number = Date.now(),
): AgentTask | undefined {
  return tx(db, () => {
    releaseStaleClaims(db, now);
    const row = one<{ id: string }>(
      db,
      `SELECT t.id FROM agent_tasks t WHERE t.status = 'open' ${filter.kind ? 'AND t.kind = :kind' : ''}
         ${filter.agent ? "AND json_extract(t.payload_json, '$.routedTo') = :agent" : ''}
         AND NOT EXISTS (SELECT 1 FROM agent_tasks o WHERE o.status = 'claimed' AND o.shot_id IS NOT NULL AND o.shot_id = t.shot_id)
       ORDER BY t.created_at LIMIT 1`,
      { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.agent ? { agent: filter.agent } : {}) },
    );
    if (!row) return undefined;
    run(
      db,
      `UPDATE agent_tasks SET status = 'claimed', claimed_by = :claimedBy, claimed_at = :now, updated_at = :now WHERE id = :id`,
      { id: row.id, claimedBy, now },
    );
    const task = getAgentTask(db, row.id);
    event(db, task, 'agent_task.claimed', claimedBy);
    return task;
  });
}

export function claimAgentTask(db: Db, id: string, claimedBy: string, now: number = Date.now()): AgentTask {
  return tx(db, () => {
    const t = getAgentTask(db, id);
    if (t.status !== 'open') throw new AniError('conflict', `Task is ${t.status}, not open`);
    if (claimedBy.startsWith('codex:') && routeOf(t) === 'claude')
      throw new AniError('conflict', 'This task waits for Claude; Codex takes only the tasks routed to it');
    run(
      db,
      `UPDATE agent_tasks SET status = 'claimed', claimed_by = :claimedBy, claimed_at = :now, updated_at = :now WHERE id = :id`,
      { id, claimedBy, now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.claimed', claimedBy);
    return task;
  });
}

export function completeAgentTask(
  db: Db,
  id: string,
  result: { note: string; targetId?: string | null },
  actor: string,
  now: number = Date.now(),
): AgentTask {
  return tx(db, () => {
    const t = getAgentTask(db, id);
    if (t.status === 'done' || t.status === 'cancelled')
      throw new AniError('conflict', `Task is already ${t.status}`);
    run(
      db,
      `UPDATE agent_tasks SET status = 'done', result_note = :note, result_target_id = :targetId, updated_at = :now WHERE id = :id`,
      { id, note: result.note, targetId: result.targetId ?? null, now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.done', actor, { note: result.note, targetId: result.targetId ?? null });
    return task;
  });
}

export function askUser(
  db: Db,
  id: string,
  question: string,
  actor: string,
  now: number = Date.now(),
): AgentTask {
  return tx(db, () => {
    run(
      db,
      `UPDATE agent_tasks SET status = 'needs_user', question = :question, updated_at = :now WHERE id = :id`,
      { id, question, now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.needs_user', actor, { question });
    return task;
  });
}

export function answerAgentTask(
  db: Db,
  id: string,
  answer: string,
  actor: string,
  now: number = Date.now(),
  /** Images the human attached to the answer (workspace paths); Codex gets them with it. */
  images: string[] = [],
): AgentTask {
  return tx(db, () => {
    const t = getAgentTask(db, id);
    if (t.status !== 'needs_user') throw new AniError('conflict', 'This task is not waiting for an answer');
    const payload = {
      ...((t.payload as Record<string, unknown> | null) ?? {}),
      ...(images.length ? { answerImages: images } : {}),
    };
    run(
      db,
      `UPDATE agent_tasks SET status = 'open', answer = :answer, payload_json = :payload, claimed_by = NULL, claimed_at = NULL, updated_at = :now WHERE id = :id`,
      { id, answer, payload: JSON.stringify(payload), now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.answered', actor, { answer });
    return task;
  });
}

export function cancelAgentTask(db: Db, id: string, actor: string, now: number = Date.now()): AgentTask {
  return tx(db, () => {
    run(
      db,
      `UPDATE agent_tasks SET status = 'cancelled', updated_at = :now WHERE id = :id AND status IN ('open', 'claimed', 'needs_user')`,
      { id, now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.cancelled', actor);
    return task;
  });
}

/** Returns claims left behind by a crashed or abandoned agent turn to the queue. */
export function releaseStaleClaims(db: Db, now: number = Date.now()): number {
  return run(
    db,
    `UPDATE agent_tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = :now WHERE status = 'claimed' AND claimed_at < :cutoff`,
    {
      now,
      cutoff: now - AGENT_CLAIM_TIMEOUT_MS,
    },
  ).changes;
}

/** Gives a claimed task back to the queue (dispatcher failure before Codex could act). */
export function releaseAgentTask(db: Db, id: string, actor: string, now: number = Date.now()): AgentTask {
  return tx(db, () => {
    run(
      db,
      `UPDATE agent_tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = :now WHERE id = :id AND status = 'claimed'`,
      { id, now },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.released', actor);
    return task;
  });
}
