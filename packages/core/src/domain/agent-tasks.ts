import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';

export type AgentTaskKind = 'review_feedback' | 'cast_review';
export type AgentTaskStatus = 'open' | 'claimed' | 'done' | 'needs_user' | 'cancelled';
/** A claim older than this is assumed abandoned and returned to the queue. */
export const AGENT_CLAIM_TIMEOUT_MS = 30 * 60_000;

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

export function listAgentTasks(
  db: Db,
  filter: { status?: AgentTaskStatus; projectId?: string; shotId?: string } = {},
): AgentTask[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  for (const [k, col] of [
    ['status', 'status'],
    ['projectId', 'project_id'],
    ['shotId', 'shot_id'],
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
        payload: toJson(input.payload ?? {}),
        now,
      },
    );
    const task = getAgentTask(db, id);
    event(db, task, 'agent_task.created', input.createdBy);
    return task;
  });
}

/** Oldest open task, claimed atomically. Shots with a task already in progress are skipped. */
export function claimNextAgentTask(
  db: Db,
  claimedBy: string,
  filter: { kind?: AgentTaskKind } = {},
  now: number = Date.now(),
): AgentTask | undefined {
  return tx(db, () => {
    releaseStaleClaims(db, now);
    const row = one<{ id: string }>(
      db,
      `SELECT t.id FROM agent_tasks t WHERE t.status = 'open' ${filter.kind ? 'AND t.kind = :kind' : ''}
         AND NOT EXISTS (SELECT 1 FROM agent_tasks o WHERE o.status = 'claimed' AND o.shot_id IS NOT NULL AND o.shot_id = t.shot_id)
       ORDER BY t.created_at LIMIT 1`,
      filter.kind ? { kind: filter.kind } : {},
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
): AgentTask {
  return tx(db, () => {
    const t = getAgentTask(db, id);
    if (t.status !== 'needs_user') throw new AniError('conflict', 'This task is not waiting for an answer');
    run(
      db,
      `UPDATE agent_tasks SET status = 'open', answer = :answer, claimed_by = NULL, claimed_at = NULL, updated_at = :now WHERE id = :id`,
      { id, answer, now },
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
