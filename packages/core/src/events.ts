import { all, type Db, fromJson, one, run, toJson } from './db.ts';

export interface EventInput {
  actor: string;
  kind: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  payload?: unknown;
}

export interface AniEvent {
  seq: number;
  at: number;
  actor: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  projectId: string | null;
  payload: unknown;
}

interface EventRow {
  seq: number;
  at: number;
  actor: string;
  kind: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  payload_json: string;
}

/** Appends an audit/SSE event. Call it inside the same `tx` as the state change it describes. */
export function appendEvent(db: Db, e: EventInput, now: number = Date.now()): number {
  return run(
    db,
    `INSERT INTO events (at, actor, kind, entity_type, entity_id, project_id, payload_json)
     VALUES (:at, :actor, :kind, :entityType, :entityId, :projectId, :payload)`,
    {
      at: now,
      actor: e.actor,
      kind: e.kind,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      projectId: e.projectId ?? null,
      payload: toJson(e.payload ?? {}),
    },
  ).lastInsertRowid;
}

export function eventsSince(db: Db, seq: number, limit = 500): AniEvent[] {
  return all<EventRow>(db, 'SELECT * FROM events WHERE seq > :seq ORDER BY seq LIMIT :limit', {
    seq,
    limit,
  }).map((r) => ({
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    kind: r.kind,
    entityType: r.entity_type,
    entityId: r.entity_id,
    projectId: r.project_id,
    payload: fromJson(r.payload_json, {}),
  }));
}

export function latestEventSeq(db: Db): number {
  return one<{ seq: number | null }>(db, 'SELECT MAX(seq) AS seq FROM events')?.seq ?? 0;
}

/**
 * `codex:<thread>` inside a Codex sandbox turn, `claude` inside Claude Code (its shell sets `CLAUDECODE=1`),
 * otherwise the human user. Codex first: a Codex turn started from a Claude shell is still Codex.
 */
export function actorFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_THREAD_ID) return `codex:${env.CODEX_THREAD_ID}`;
  return env.CLAUDECODE === '1' ? 'claude' : 'user';
}

/** An AI agent (Codex or Claude Code), not the human: it may recommend but never approve. */
export const isAgentActor = (actor: string): boolean => actor.startsWith('codex:') || actor === 'claude';
