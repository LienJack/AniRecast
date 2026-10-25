import { newId } from '@anirecast/shared';
import { all, type Db, one, run, toJson } from '../db.ts';

export type ThreadScope = 'shot' | 'project_cast';

export function findCodexThread(db: Db, scope: ThreadScope, scopeId: string): string | undefined {
  return one<{ thread_id: string }>(
    db,
    'SELECT thread_id FROM codex_threads WHERE scope = :scope AND scope_id = :scopeId',
    { scope, scopeId },
  )?.thread_id;
}

export function saveCodexThread(
  db: Db,
  scope: ThreadScope,
  scopeId: string,
  threadId: string,
  now: number = Date.now(),
): void {
  run(
    db,
    `INSERT INTO codex_threads (scope, scope_id, thread_id, created_at) VALUES (:scope, :scopeId, :threadId, :now)
     ON CONFLICT (scope, scope_id) DO UPDATE SET thread_id = :threadId, created_at = :now`,
    { scope, scopeId, threadId, now },
  );
}

export function recordCodexUsage(
  db: Db,
  input: { taskId: string | null; threadId: string; tokens: unknown },
  now: number = Date.now(),
): void {
  run(
    db,
    'INSERT INTO codex_usage (id, task_id, thread_id, tokens_json, at) VALUES (:id, :taskId, :threadId, :tokens, :now)',
    {
      id: newId('cxu', now),
      taskId: input.taskId,
      threadId: input.threadId,
      tokens: toJson(input.tokens),
      now,
    },
  );
}

export function codexThreadsForProject(
  db: Db,
  projectId: string,
): Array<{ scope: ThreadScope; scopeId: string; threadId: string }> {
  return all<{ scope: ThreadScope; scope_id: string; thread_id: string }>(
    db,
    `SELECT ct.scope, ct.scope_id, ct.thread_id FROM codex_threads ct
     WHERE (ct.scope = 'project_cast' AND ct.scope_id = :projectId)
        OR (ct.scope = 'shot' AND ct.scope_id IN (SELECT s.id FROM shots s JOIN clips c ON c.id = s.clip_id WHERE c.project_id = :projectId))`,
    { projectId },
  ).map((r) => ({ scope: r.scope, scopeId: r.scope_id, threadId: r.thread_id }));
}
