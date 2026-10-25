import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDaemonAlive,
  claimNextJob,
  completeJob,
  daemonStatus,
  enqueueJob,
  eventsSince,
  failJob,
  getJob,
  initWorkspace,
  listJobs,
  recoverInterruptedJobs,
  requestCancel,
  retryJob,
  updateJobProgress,
  writeHeartbeat,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

const fresh = () => initWorkspace(path.join(tempDir(), 'ws'));

describe('jobs', () => {
  it('runs queued → running → succeeded and records events in order', () => {
    const ws = fresh();
    const { db } = ws;
    const job = enqueueJob(db, { type: 'noop', lane: 'io', payload: { n: 1 }, requestedBy: 'user' });
    expect(job.status).toBe('queued');
    expect(claimNextJob(db, 'media', 'w1')).toBeUndefined();
    const running = claimNextJob(db, 'io', 'w1');
    expect(running).toMatchObject({ id: job.id, status: 'running', attempts: 1, workerId: 'w1' });
    updateJobProgress(db, job.id, 0.5, 'half');
    const done = completeJob(db, job.id, { ok: true }, 0.12);
    expect(done).toMatchObject({ status: 'succeeded', progress: 1, result: { ok: true }, costActual: 0.12 });
    const kinds = eventsSince(db, 0)
      .filter((e) => e.entityId === job.id)
      .map((e) => e.kind);
    expect(kinds).toEqual(['job.queued', 'job.started', 'job.progress', 'job.succeeded']);
    ws.close();
  });

  it('requeues retryable failures until attempts run out, then fails', () => {
    const ws = fresh();
    const { db } = ws;
    const job = enqueueJob(db, { type: 'flaky', lane: 'generate', requestedBy: 'user', maxAttempts: 2 });
    claimNextJob(db, 'generate', 'w');
    expect(failJob(db, job.id, { code: 'transient', message: 'timeout' }, { retryable: true }).status).toBe(
      'queued',
    );
    claimNextJob(db, 'generate', 'w');
    const failed = failJob(db, job.id, { code: 'transient', message: 'timeout' }, { retryable: true });
    expect(failed).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'transient' } });
    expect(retryJob(db, job.id, 'user').status).toBe('queued');
    ws.close();
  });

  it('cancels queued jobs immediately and flags running ones', () => {
    const ws = fresh();
    const { db } = ws;
    const a = enqueueJob(db, { type: 'a', lane: 'io', requestedBy: 'user' });
    const b = enqueueJob(db, { type: 'b', lane: 'media', requestedBy: 'user' });
    expect(requestCancel(db, a.id, 'user').status).toBe('cancelled');
    claimNextJob(db, 'media', 'w');
    expect(requestCancel(db, b.id, 'user')).toMatchObject({ status: 'running', cancelRequested: true });
    expect(listJobs(db, { status: 'cancelled' }).map((j) => j.id)).toEqual([a.id]);
    ws.close();
  });

  it('recovers jobs left running by a dead daemon', () => {
    const ws = fresh();
    const { db } = ws;
    const job = enqueueJob(db, { type: 'x', lane: 'io', requestedBy: 'user' });
    claimNextJob(db, 'io', 'dead-worker');
    expect(recoverInterruptedJobs(db)).toBe(1);
    expect(getJob(db, job.id).status).toBe('queued');
    ws.close();
  });

  it('sees a job enqueued by another process while holding the database open', () => {
    const ws = fresh();
    const dbFile = path.join(ws.root, 'anirecast.db');
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
      db.exec("INSERT INTO jobs (id, type, lane, status, requested_by, created_at) VALUES ('job_other', 'noop', 'io', 'queued', 'codex:t1', ${Date.now()})");
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dbFile], {
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(claimNextJob(ws.db, 'io', 'daemon')?.id).toBe('job_other');
    ws.close();
  });
});

describe('daemon heartbeat', () => {
  it('distinguishes a live daemon from a stale one', () => {
    const ws = fresh();
    expect(() => assertDaemonAlive(ws.db)).toThrow(/沒有在執行/);
    writeHeartbeat(ws.db, { host: 'h', pid: 1, version: '0.1.0', startedAt: 1_000 }, 1_000);
    expect(daemonStatus(ws.db, 5_000).alive).toBe(true);
    expect(daemonStatus(ws.db, 20_000).alive).toBe(false);
    ws.close();
  });
});
