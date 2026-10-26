import { enqueueJob, getJob, openWorkspace, requestCancel } from '@anirecast/core';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { cli, setupWorkspace as setup, TEST_CONFIG } from './helpers.ts';

describe('daemon + CLI', () => {
  it('runs a job enqueued by a separate CLI process', async () => {
    const { root, env } = await setup();
    const result = await cli({ root, env }, ['jobs', 'noop', '--ms', '100', '--wait']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      data: { type: 'noop', status: 'succeeded', result: { sleptMs: 100 } },
    });
    expect(result.stderr).toMatch(/noop (queued|running|succeeded)/);
  });

  it('streams job events over SSE', async () => {
    const { root, daemon } = await setup();
    const controller = new AbortController();
    const res = await fetch(`${daemon.url}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const ws = openWorkspace(root, { role: 'cli' });
    const job = enqueueJob(ws.db, { type: 'noop', lane: 'io', payload: { ms: 50 }, requestedBy: 'user' });
    ws.close();
    let text = '';
    const decoder = new TextDecoder();
    while (!text.includes('job.succeeded')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain(`"entityId":"${job.id}"`);
    expect(text).toMatch(/job\.queued[\s\S]*job\.started[\s\S]*job\.succeeded/);
  });

  it('stops promptly while a browser holds a live-update connection', async () => {
    const { root, daemon } = await setup();
    const res = await fetch(`${daemon.url}/api/events`);
    const reader = res.body!.getReader();
    await reader.read();
    const t0 = Date.now();
    await daemon.stop();
    expect(Date.now() - t0).toBeLessThan(2_500);
    // The shutdown finished its bookkeeping (it used to hang until launchd killed it).
    const ws = openWorkspace(root, { role: 'cli' });
    const stopped = ws.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'daemon.stopped'`).get() as {
      n: number;
    };
    ws.close();
    expect(stopped.n).toBe(1);
    await reader.cancel().catch(() => {});
  });

  it('cancels a running job', async () => {
    const { root } = await setup();
    const ws = openWorkspace(root, { role: 'cli' });
    try {
      const job = enqueueJob(ws.db, {
        type: 'noop',
        lane: 'io',
        payload: { ms: 10_000 },
        requestedBy: 'user',
      });
      for (let i = 0; i < 50 && getJob(ws.db, job.id).status !== 'running'; i++)
        await new Promise((r) => setTimeout(r, 50));
      requestCancel(ws.db, job.id, 'user');
      for (let i = 0; i < 100 && getJob(ws.db, job.id).status === 'running'; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(getJob(ws.db, job.id).status).toBe('cancelled');
    } finally {
      ws.close();
    }
  });

  it('refuses a second daemon on the same workspace', async () => {
    const { root } = await setup();
    await expect(
      startDaemon({ root, port: 0, config: TEST_CONFIG, dispatch: false, log: () => {} }),
    ).rejects.toThrow(/already serving/);
  });
});
