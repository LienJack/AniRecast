import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  all,
  createAgentTask,
  createProject,
  createSource,
  getAgentTask,
  initWorkspace,
  openWorkspace,
  updateSource,
} from '@anirecast/core';
import { afterEach, describe, expect, it } from 'vitest';
import { compareVersions, startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const MOCK = path.resolve(import.meta.dirname, 'fixtures/mock-app-server.mjs');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  delete process.env.MOCK_SKIP_DONE;
});

async function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-dispatch-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project-root', 'ws');
  const ws = initWorkspace(root);
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 10_000 }, 'daemon');
  const project = createProject(ws.db, { name: 'Dispatch', sourceId: src.id }, 'user');
  ws.close();
  process.env.MOCK_LOG = path.join(tmp, 'mock.jsonl');
  process.env.MOCK_PROJECT_ROOT = path.join(tmp, 'project-root');
  const daemon = await startDaemon({
    root,
    port: 0,
    config: { ...TEST_CONFIG, provider: 'fake' },
    dispatch: { command: { command: process.execPath, args: [MOCK], version: 'mock', source: 'config' } },
    log: () => {},
  });
  cleanups.push(() => daemon.stop());
  return { root, projectId: project.id, mockLog: process.env.MOCK_LOG };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('codex dispatcher (mock app-server)', () => {
  it('runs a task in a sandboxed turn under the workspace project and records the thread', async () => {
    const { root, projectId, mockLog } = await setup();
    const ws = openWorkspace(root, { role: 'cli' });
    try {
      const task = createAgentTask(ws.db, {
        kind: 'review_feedback',
        projectId,
        payload: { comment: '頭髮更亮' },
        createdBy: 'user',
      });
      const done = await waitFor(() => {
        const t = getAgentTask(ws.db, task.id);
        return t.status === 'done' ? t : undefined;
      });
      expect(done.resultNote).toBe('mock note');

      const calls = readFileSync(mockLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const start = calls.find((c) => c.method === 'thread/start');
      expect(start.params).toMatchObject({
        cwd: root,
        projectId: 'proj_mock',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        serviceName: 'anirecast',
      });
      expect(calls.find((c) => c.method === 'thread/name/set').params.name).toBe(
        'AniRecast · Dispatch · 角色辨識',
      );
      const turn = calls.find((c) => c.method === 'turn/start');
      expect(turn.params.sandboxPolicy).toEqual({
        type: 'workspaceWrite',
        networkAccess: false,
        writableRoots: [root],
      });
      expect(turn.params.input[0]).toMatchObject({ type: 'skill', name: 'anirecast' });
      expect(turn.params.input[0].path).toMatch(/skills\/anirecast\/SKILL\.md$/);
      expect(calls.find((c) => c.cli)?.cli).toMatchObject({ ok: true, data: { status: 'done' } });

      const threads = all<{ thread_id: string }>(ws.db, 'SELECT thread_id FROM codex_threads');
      expect(threads).toEqual([{ thread_id: 'thr_mock_1' }]);
      await waitFor(() => (all(ws.db, 'SELECT * FROM codex_usage').length > 0 ? true : undefined));
      const kinds = all<{ kind: string }>(
        ws.db,
        `SELECT kind FROM events WHERE kind LIKE 'agent.%' ORDER BY seq`,
      ).map((r) => r.kind);
      expect(kinds).toEqual(expect.arrayContaining(['agent.started', 'agent.progress', 'agent.finished']));
      const actors = all<{ actor: string }>(ws.db, `SELECT actor FROM events WHERE kind = 'agent_task.done'`);
      expect(actors).toEqual([{ actor: 'codex:thr_mock_1' }]);
    } finally {
      ws.close();
    }
  }, 40_000);

  it('turns an unfinished turn into a question for the human', async () => {
    process.env.MOCK_SKIP_DONE = '1';
    const { root, projectId } = await setup();
    const ws = openWorkspace(root, { role: 'cli' });
    try {
      const task = createAgentTask(ws.db, {
        kind: 'review_feedback',
        projectId,
        payload: {},
        createdBy: 'user',
      });
      const t = await waitFor(() => {
        const x = getAgentTask(ws.db, task.id);
        return x.status === 'needs_user' ? x : undefined;
      });
      expect(t.question).toMatch(/沒有標記完成/);
    } finally {
      ws.close();
    }
  }, 40_000);
});

describe('codex version selection', () => {
  it('orders releases above their pre-releases', () => {
    expect(compareVersions('0.163.0-alpha.10.2', '0.156.0')).toBeGreaterThan(0);
    expect(compareVersions('0.164.0', '0.164.0-alpha.1')).toBeGreaterThan(0);
    expect(compareVersions('0.163.0-alpha.10', '0.163.0-alpha.9')).toBeGreaterThan(0);
  });
});
