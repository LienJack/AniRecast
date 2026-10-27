import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actorFromEnv,
  claimAgentTask,
  claimNextAgentTask,
  createAgentTask,
  createProject,
  createSource,
  getAgentTask,
  initWorkspace,
  listAgentTasks,
  routeAgentTask,
  routeTask,
  updateConfig,
  updateSource,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

function fixture() {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000 }, 'daemon');
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const task = (payload: Record<string, unknown> = {}, now?: number) =>
    createAgentTask(
      ws.db,
      { kind: 'review_feedback', projectId: project.id, payload, createdBy: 'user' },
      now,
    );
  return { ws, task };
}

describe('who runs a command', () => {
  it('is Codex inside a Codex turn, Claude inside Claude Code, otherwise the human', () => {
    expect(actorFromEnv({})).toBe('user');
    expect(actorFromEnv({ CLAUDECODE: '1' })).toBe('claude');
    expect(actorFromEnv({ CODEX_THREAD_ID: 'thr_1', CLAUDECODE: '1' })).toBe('codex:thr_1');
  });
});

describe('routing agent tasks', () => {
  it("goes to Claude by default and to the human's pick; each agent claims only its own", () => {
    const { ws, task } = fixture();
    const claude = task({}, 1_000);
    const codex = task({ agent: 'codex' }, 2_000);
    expect(claude.payload).toMatchObject({ routedTo: 'claude', routeReasons: ['預設交給 Claude'] });
    expect(codex.payload).toMatchObject({ routedTo: 'codex', routeReasons: ['人類指定 Codex'] });
    expect(listAgentTasks(ws.db, { agent: 'claude' }).map((t) => t.id)).toEqual([claude.id]);

    // Codex never takes Claude's task, not even by id.
    expect(() => claimAgentTask(ws.db, claude.id, 'codex:thr_1')).toThrow(/waits for Claude/);
    expect(claimNextAgentTask(ws.db, 'codex:thr_1', { agent: 'codex' })?.id).toBe(codex.id);
    expect(claimNextAgentTask(ws.db, 'codex:thr_1', { agent: 'codex' })).toBeUndefined();
    expect(claimNextAgentTask(ws.db, 'claude', { agent: 'claude' })?.id).toBe(claude.id);

    // Handed to Claude while Codex held it: back in the queue, for Claude.
    const moved = routeAgentTask(ws.db, codex.id, { to: 'claude', reasons: ['需要改程式'] }, 'codex:thr_1', {
      reopen: true,
    });
    expect(moved).toMatchObject({ status: 'open', claimedBy: null, payload: { routedTo: 'claude' } });
    expect(claimNextAgentTask(ws.db, 'claude', { agent: 'claude' })?.id).toBe(codex.id);
    ws.close();
  });

  it('under `auto` leaves a task for the dispatcher to judge, which sends simple ones to Codex', () => {
    updateConfig((c) => {
      c.agents.default = 'auto';
    });
    try {
      const { ws, task } = fixture();
      const open = task();
      expect(open.payload.routedTo).toBeUndefined();
      // Neither agent sees it until it is routed; the human sees every task.
      expect(claimNextAgentTask(ws.db, 'claude', { agent: 'claude' })).toBeUndefined();
      expect(routeTask(ws, open.id, { fallback: 'auto' })).toEqual({ to: 'codex', reasons: [] });
      expect(routeTask(ws, open.id, { fallback: 'claude' }).to).toBe('claude');
      expect(routeTask(ws, task({ agent: 'claude' }).id, { fallback: 'auto' }).to).toBe('claude');
      expect(claimNextAgentTask(ws.db, 'user')?.id).toBe(open.id);
      expect(getAgentTask(ws.db, open.id).status).toBe('claimed');
      ws.close();
    } finally {
      updateConfig((c) => {
        c.agents.default = 'claude';
      });
    }
  });
});
