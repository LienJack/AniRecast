import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAgentTask,
  initWorkspace,
  type Job,
  listAgentTasks,
  listJobs,
  openWorkspace,
  TERMINAL_STATUSES,
} from '@anirecast/core';
import { FakeProvider, type VisionRequest } from '@anirecast/providers';
import { describe, expect, it } from 'vitest';
import { synthesizeShots } from '../../../packages/media/test/fixtures.ts';
import { startDaemon } from '../src/index.ts';
import { cliData, setupWorkspace, TEST_CONFIG } from './helpers.ts';

interface ShotView {
  id: string;
  startFrame: number;
  endFrame: number;
  frameCount: number;
  sourcePath: string | null;
  keyframes: { frame: number; role: string; path: string }[];
}

async function waitIdle(root: string, timeoutMs = 120_000): Promise<Job[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ws = openWorkspace(root, { role: 'cli' });
    const jobs = listJobs(ws.db, { limit: 100 });
    ws.close();
    if (jobs.every((j) => TERMINAL_STATUSES.includes(j.status))) return jobs;
    if (Date.now() > deadline)
      throw new Error(`jobs still active: ${JSON.stringify(jobs.map((j) => [j.type, j.status]))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('source → clip → shots', () => {
  it('imports, clips frame-accurately, detects shots and prepares keyframes', async () => {
    const t = await setupWorkspace();
    const video = path.join(t.tmp, 'op.mp4');
    await synthesizeShots(video, [30, 45, 20, 60]);

    const imported = await cliData<{ source: { id: string; status: string; fpsNum: number } }>(t, [
      'source',
      'import',
      video,
      '--title',
      '測試 OP',
      '--wait',
    ]);
    const source = await cliData<{ id: string; status: string; fpsNum: number; title: string }>(t, [
      'source',
      'show',
      imported.source.id,
    ]);
    expect(source).toMatchObject({ status: 'ready', fpsNum: 24000, title: '測試 OP' });

    const project = await cliData<{ id: string; slug: string }>(t, [
      'project',
      'create',
      '--source',
      source.id,
      '--name',
      'Test OP 1',
    ]);
    expect(project.slug).toBe('test-op-1');

    await cliData(t, ['clip', 'set', project.slug, '--in', 'f:10', '--out', 'f:150', '--wait']);
    const jobs = await waitIdle(t.root);
    expect(jobs.filter((j) => j.status !== 'succeeded')).toEqual([]);

    const shots = await cliData<ShotView[]>(t, ['shots', 'list', project.slug]);
    expect(shots.map((s) => s.startFrame)).toEqual([0, 20, 65, 85]);
    expect(shots.reduce((n, s) => n + s.frameCount, 0)).toBe(140);
    for (const s of shots) {
      expect(s.sourcePath && existsSync(path.join(t.root, s.sourcePath))).toBe(true);
      expect(s.keyframes.map((k) => k.role)).toEqual(expect.arrayContaining(['first', 'mid', 'last']));
      for (const k of s.keyframes) expect(existsSync(path.join(t.root, k.path))).toBe(true);
    }

    const [first] = shots;
    const split = await cliData<ShotView[]>(t, ['shots', 'split', first!.id, '--at', '10']);
    expect(split.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [0, 9],
      [10, 19],
    ]);
    await waitIdle(t.root);
    await cliData(t, ['shots', 'merge', split[0]!.id, split[1]!.id]);
    await waitIdle(t.root);
    const after = await cliData<ShotView[]>(t, ['shots', 'list', project.slug]);
    expect(after.map((s) => s.startFrame)).toEqual([0, 20, 65, 85]);
    expect(after[0]!.keyframes.length).toBeGreaterThan(0);
  }, 240_000);
});

describe('cut continuity', () => {
  it('merges cuts the judge is sure about, sends unsure ones to Codex and leaves user cuts alone', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-continuity-'));
    const root = path.join(tmp, 'ws');
    initWorkspace(root).close();
    // The fake judge answers by cut frame: 20 is one moment, 65 is unsure, 85 is a real cut.
    const answers: Record<number, { same_moment: boolean; confidence: number; reason: string }> = {
      20: { same_moment: true, confidence: 0.95, reason: 'same girl, closer framing' },
      65: { same_moment: true, confidence: 0.7, reason: 'maybe the same room' },
      85: { same_moment: false, confidence: 0.95, reason: 'new place' },
    };
    const vision = (req: VisionRequest) => {
      const at = Number(/\/f(\d+)-0\.jpg$/.exec(req.images[0]?.path ?? '')?.[1]);
      return answers[at] ?? { same_moment: false, confidence: 1, reason: 'cut' };
    };
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...TEST_CONFIG, provider: 'fake', continuity: { ...TEST_CONFIG.continuity, enabled: true } },
      provider: new FakeProvider({ vision }),
      dispatch: false,
      log: () => {},
    });
    const t = { root, env: { ...process.env, ANIRECAST_CONFIG_DIR: path.join(tmp, 'cfg') } };
    try {
      const video = path.join(tmp, 'op.mp4');
      await synthesizeShots(video, [30, 45, 20, 60]);
      const { source } = await cliData<{ source: { id: string } }>(t, ['source', 'import', video, '--wait']);
      const project = await cliData<{ slug: string }>(t, [
        'project',
        'create',
        '--source',
        source.id,
        '--name',
        'Cuts',
      ]);
      await cliData(t, ['clip', 'set', project.slug, '--in', 'f:10', '--out', 'f:150', '--wait']);
      const jobs = await waitIdle(root);
      expect(jobs.filter((j) => j.status !== 'succeeded').map((j) => [j.type, j.error])).toEqual([]);
      expect(jobs.map((j) => j.type)).toContain('shots.continuity');

      const shots = await cliData<ShotView[]>(t, ['shots', 'list', project.slug]);
      expect(shots.map((s) => s.startFrame)).toEqual([0, 65, 85]);
      for (const s of shots) expect(s.sourcePath && existsSync(path.join(root, s.sourcePath))).toBe(true);

      const ws = openWorkspace(root, { role: 'cli' });
      const [task] = listAgentTasks(ws.db).filter((x) => x.kind === 'shot_review');
      const payload = getAgentTask(ws.db, task!.id).payload as {
        unsure: Array<{ atFrame: number; sheet: string }>;
        merged: Array<{ shots: number[] }>;
      };
      ws.close();
      expect(payload.unsure.map((u) => u.atFrame)).toEqual([65]);
      expect(existsSync(payload.unsure[0]!.sheet)).toBe(true);
      expect(payload.merged.map((m) => m.shots)).toEqual([[1, 2]]);

      // A cut a person keeps is locked: judging again never merges it, even when the judge is sure.
      await cliData(t, [
        'shots',
        'boundary',
        project.slug,
        '--at',
        '85',
        '--cut',
        '--reason',
        'different scene',
      ]);
      answers[85] = { same_moment: true, confidence: 0.99, reason: 'judge changed its mind' };
      const again = await cliData<{
        result: { merged: unknown[]; suggested: unknown[]; newlyJudged: number };
      }>(t, ['shots', 'continuity', project.slug, '--apply', '--rejudge', '--wait']);
      // Only the unlocked cut (65) is judged again; nothing merges.
      expect(again.result).toMatchObject({ merged: [], suggested: [], newlyJudged: 1 });
      const boundaries = await cliData<Array<{ atFrame: number; verdict: string; locked: boolean }>>(t, [
        'shots',
        'boundaries',
        project.slug,
      ]);
      expect(boundaries.find((b) => b.atFrame === 85)).toMatchObject({ verdict: 'cut', locked: true });
      expect(boundaries.find((b) => b.atFrame === 20)).toMatchObject({ verdict: 'same_moment' });
    } finally {
      await daemon.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 240_000);
});
