import { existsSync } from 'node:fs';
import path from 'node:path';
import { type Job, listJobs, openWorkspace, TERMINAL_STATUSES } from '@anirecast/core';
import { describe, expect, it } from 'vitest';
import { synthesizeShots } from '../../../packages/media/test/fixtures.ts';
import { cliData, setupWorkspace } from './helpers.ts';

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
