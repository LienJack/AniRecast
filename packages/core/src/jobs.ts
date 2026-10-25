import { AniError, type EnvelopeError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from './db.ts';
import { appendEvent } from './events.ts';

export type Lane = 'generate' | 'media' | 'agent' | 'io';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: string;
  lane: Lane;
  projectId: string | null;
  payload: unknown;
  status: JobStatus;
  progress: number;
  message: string | null;
  result: unknown;
  error: EnvelopeError | null;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  costEstimate: number | null;
  costActual: number | null;
  requestedBy: string;
  workerId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface JobRow {
  id: string;
  type: string;
  lane: Lane;
  project_id: string | null;
  payload_json: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: number;
  cost_estimate: number | null;
  cost_actual: number | null;
  requested_by: string;
  worker_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  type: r.type,
  lane: r.lane,
  projectId: r.project_id,
  payload: fromJson(r.payload_json, {}),
  status: r.status,
  progress: r.progress,
  message: r.message,
  result: fromJson(r.result_json, null),
  error: fromJson<EnvelopeError | null>(r.error_json, null),
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  cancelRequested: r.cancel_requested === 1,
  costEstimate: r.cost_estimate,
  costActual: r.cost_actual,
  requestedBy: r.requested_by,
  workerId: r.worker_id,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface EnqueueInput {
  type: string;
  lane: Lane;
  payload?: unknown;
  projectId?: string | null;
  requestedBy: string;
  maxAttempts?: number;
  costEstimate?: number | null;
}

function jobEvent(db: Db, job: Job, kind: string, actor: string, extra: Record<string, unknown> = {}): void {
  appendEvent(db, {
    actor,
    kind,
    entityType: 'job',
    entityId: job.id,
    projectId: job.projectId,
    payload: { type: job.type, lane: job.lane, status: job.status, ...extra },
  });
}

export function getJob(db: Db, id: string): Job {
  const row = one<JobRow>(db, 'SELECT * FROM jobs WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Job not found: ${id}`);
  return toJob(row);
}

export function enqueueJob(db: Db, input: EnqueueInput, now: number = Date.now()): Job {
  return tx(db, () => {
    const id = newId('job', now);
    run(
      db,
      `INSERT INTO jobs (id, type, lane, project_id, payload_json, status, max_attempts, cost_estimate, requested_by, created_at)
       VALUES (:id, :type, :lane, :projectId, :payload, 'queued', :maxAttempts, :costEstimate, :requestedBy, :now)`,
      {
        id,
        type: input.type,
        lane: input.lane,
        projectId: input.projectId ?? null,
        payload: toJson(input.payload ?? {}),
        maxAttempts: input.maxAttempts ?? 1,
        costEstimate: input.costEstimate ?? null,
        requestedBy: input.requestedBy,
        now,
      },
    );
    const job = getJob(db, id);
    jobEvent(db, job, 'job.queued', input.requestedBy);
    return job;
  });
}

/** Atomically moves the oldest queued job in `lane` to running. Only the daemon calls this. */
export function claimNextJob(
  db: Db,
  lane: Lane,
  workerId: string,
  now: number = Date.now(),
): Job | undefined {
  return tx(db, () => {
    const row = one<{ id: string }>(
      db,
      `SELECT id FROM jobs WHERE lane = :lane AND status = 'queued' AND cancel_requested = 0
       ORDER BY created_at, id LIMIT 1`,
      { lane },
    );
    if (!row) return undefined;
    run(
      db,
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, worker_id = :workerId,
         started_at = :now, progress = 0, message = NULL, error_json = NULL
       WHERE id = :id`,
      { id: row.id, workerId, now },
    );
    const job = getJob(db, row.id);
    jobEvent(db, job, 'job.started', 'daemon', { attempt: job.attempts });
    return job;
  });
}

export function updateJobProgress(db: Db, id: string, progress: number, message?: string): void {
  tx(db, () => {
    run(
      db,
      `UPDATE jobs SET progress = :progress, message = :message WHERE id = :id AND status = 'running'`,
      {
        id,
        progress: Math.max(0, Math.min(1, progress)),
        message: message ?? null,
      },
    );
    jobEvent(db, getJob(db, id), 'job.progress', 'daemon', { progress, message: message ?? null });
  });
}

export function completeJob(
  db: Db,
  id: string,
  result: unknown,
  costActual?: number,
  now: number = Date.now(),
): Job {
  return tx(db, () => {
    run(
      db,
      `UPDATE jobs SET status = 'succeeded', progress = 1, result_json = :result, cost_actual = :cost, finished_at = :now
       WHERE id = :id`,
      { id, result: toJson(result), cost: costActual ?? null, now },
    );
    const job = getJob(db, id);
    jobEvent(db, job, 'job.succeeded', 'daemon');
    return job;
  });
}

/** Records a failure; retryable failures go back to the queue until `max_attempts` is used up. */
export function failJob(
  db: Db,
  id: string,
  error: EnvelopeError,
  { retryable = false }: { retryable?: boolean } = {},
  now: number = Date.now(),
): Job {
  return tx(db, () => {
    const current = getJob(db, id);
    const requeue = retryable && current.attempts < current.maxAttempts && !current.cancelRequested;
    run(
      db,
      `UPDATE jobs SET status = :status, error_json = :error, finished_at = :finished, worker_id = NULL WHERE id = :id`,
      { id, status: requeue ? 'queued' : 'failed', error: toJson(error), finished: requeue ? null : now },
    );
    const job = getJob(db, id);
    jobEvent(db, job, requeue ? 'job.retrying' : 'job.failed', 'daemon', { error });
    return job;
  });
}

export function requestCancel(db: Db, id: string, actor: string, now: number = Date.now()): Job {
  return tx(db, () => {
    const current = getJob(db, id);
    if (TERMINAL_STATUSES.includes(current.status)) return current;
    if (current.status === 'queued') {
      run(
        db,
        `UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = :now WHERE id = :id`,
        {
          id,
          now,
        },
      );
      const job = getJob(db, id);
      jobEvent(db, job, 'job.cancelled', actor);
      return job;
    }
    run(db, 'UPDATE jobs SET cancel_requested = 1 WHERE id = :id', { id });
    const job = getJob(db, id);
    jobEvent(db, job, 'job.cancel_requested', actor);
    return job;
  });
}

/** Called by the worker when it notices `cancel_requested` on a running job. */
export function markCancelled(db: Db, id: string, now: number = Date.now()): Job {
  return tx(db, () => {
    run(db, `UPDATE jobs SET status = 'cancelled', finished_at = :now, worker_id = NULL WHERE id = :id`, {
      id,
      now,
    });
    const job = getJob(db, id);
    jobEvent(db, job, 'job.cancelled', 'daemon');
    return job;
  });
}

export function retryJob(db: Db, id: string, actor: string): Job {
  return tx(db, () => {
    const current = getJob(db, id);
    if (current.status !== 'failed' && current.status !== 'cancelled') {
      throw new AniError(
        'conflict',
        `Only failed or cancelled jobs can be retried (job is ${current.status})`,
      );
    }
    run(
      db,
      `UPDATE jobs SET status = 'queued', cancel_requested = 0, error_json = NULL, finished_at = NULL,
         max_attempts = attempts + 1 WHERE id = :id`,
      { id },
    );
    const job = getJob(db, id);
    jobEvent(db, job, 'job.queued', actor, { retry: true });
    return job;
  });
}

export interface ListJobsFilter {
  status?: JobStatus;
  lane?: Lane;
  projectId?: string;
  limit?: number;
}

export function listJobs(db: Db, filter: ListJobsFilter = {}): Job[] {
  const where: string[] = [];
  const params: Record<string, string | number> = { limit: filter.limit ?? 100 };
  if (filter.status) {
    where.push('status = :status');
    params.status = filter.status;
  }
  if (filter.lane) {
    where.push('lane = :lane');
    params.lane = filter.lane;
  }
  if (filter.projectId) {
    where.push('project_id = :projectId');
    params.projectId = filter.projectId;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return all<JobRow>(
    db,
    `SELECT * FROM jobs ${clause} ORDER BY created_at DESC, id DESC LIMIT :limit`,
    params,
  ).map(toJob);
}

/** On daemon start: jobs left `running` by a dead daemon go back to the queue (or fail if out of attempts). */
export function recoverInterruptedJobs(db: Db): number {
  const stuck = all<JobRow>(db, `SELECT * FROM jobs WHERE status = 'running'`);
  for (const row of stuck) {
    // One free retry for an interruption; a job that keeps killing the daemon fails on its second run.
    const retryable = row.attempts < 2;
    if (retryable) {
      run(db, 'UPDATE jobs SET max_attempts = MAX(max_attempts, attempts + 1) WHERE id = :id', {
        id: row.id,
      });
    }
    failJob(db, row.id, { code: 'transient', message: 'Interrupted by a daemon restart' }, { retryable });
  }
  return stuck.length;
}
