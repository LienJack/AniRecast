import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  enqueueJob,
  getJob,
  initWorkspace,
  openWorkspace,
  requestCancel,
} from '@anirecast/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type DaemonHandle, startDaemon } from '../src/index.ts';

const CLI = path.resolve(import.meta.dirname, '../../../packages/cli/src/main.ts');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(): Promise<{ root: string; daemon: DaemonHandle; env: NodeJS.ProcessEnv }> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-daemon-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'ws');
  initWorkspace(root).close();
  const daemon = await startDaemon({ root, port: 0, config: DEFAULT_CONFIG, log: () => {} });
  cleanups.push(() => daemon.stop());
  return { root, daemon, env: { ...process.env, ANIRECAST_CONFIG_DIR: path.join(tmp, 'cfg') } };
}

function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; json: unknown; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, json: JSON.parse(out), stderr: err }));
  });
}

describe('daemon + CLI', () => {
  it('runs a job enqueued by a separate CLI process', async () => {
    const { root, env } = await setup();
    const result = await cli(['--workspace', root, 'jobs', 'noop', '--ms', '100', '--wait'], env);
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
    await expect(startDaemon({ root, port: 0, config: DEFAULT_CONFIG, log: () => {} })).rejects.toThrow(
      /already serving/,
    );
  });
});
