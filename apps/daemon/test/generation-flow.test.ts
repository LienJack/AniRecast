import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCastMember,
  createTracklet,
  DEFAULT_CONFIG,
  findActiveClip,
  getProject,
  initWorkspace,
  type Job,
  listJobs,
  listShots,
  openWorkspace,
  replaceAutoOverlays,
  TERMINAL_STATUSES,
} from '@anirecast/core';
import { ffmpeg, probe } from '@anirecast/media';
import { FakeProvider } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { synthesizeShots } from '../../../packages/media/test/fixtures.ts';
import { startDaemon } from '../src/index.ts';
import { cliData } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-gen-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function waitIdle(root: string, timeoutMs = 180_000): Promise<Job[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ws = openWorkspace(root, { role: 'cli' });
    const jobs = listJobs(ws.db, { limit: 500 });
    ws.close();
    if (jobs.every((j) => TERMINAL_STATUSES.includes(j.status))) return jobs;
    if (Date.now() > deadline)
      throw new Error(`jobs still active: ${JSON.stringify(jobs.map((j) => [j.type, j.status]))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('board → take → render with the fake provider', () => {
  it('runs the whole generation pipeline and keeps every frame count exact', async () => {
    const root = path.join(tmp, 'ws');
    initWorkspace(root).close();
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...DEFAULT_CONFIG, provider: 'fake' },
      provider: new FakeProvider(),
      dispatch: false,
      log: () => {},
    });
    const t = { root, env: { ...process.env, ANIRECAST_CONFIG_DIR: path.join(tmp, 'cfg') } };
    try {
      const video = path.join(tmp, 'op.mp4');
      await synthesizeShots(video, [30, 45, 20, 60]);
      const ref = path.join(tmp, 'persona.png');
      await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x30a0a0:size=512x768', '-frames:v', '1', ref]);

      const { source } = await cliData<{ source: { id: string } }>(t, ['source', 'import', video, '--wait']);
      const project = await cliData<{ id: string; slug: string }>(t, [
        'project',
        'create',
        '--source',
        source.id,
        '--name',
        'Gen Test',
      ]);
      await cliData(t, ['clip', 'set', project.slug, '--in', 'f:0', '--out', 'f:155', '--wait']);
      await waitIdle(root);
      const persona = await cliData<{ id: string; slug: string }>(t, [
        'persona',
        'add',
        '--name',
        '銀髮人設',
        '--description',
        'silver bob, teal jacket',
        '--ref',
        ref,
      ]);

      // Stand-in for S10 identification: one character in shots 1 and 3, a staff credit in shot 2.
      const ws = openWorkspace(root, { role: 'cli' });
      const shots = listShots(ws.db, findActiveClip(ws.db, getProject(ws.db, project.slug).id)!.id);
      const girl = createCastMember(ws.db, { projectId: project.id, label: '黑長髮女生' }, 'daemon');
      createTracklet(ws.db, { shotId: shots[0]!.id, castMemberId: girl.id });
      createTracklet(ws.db, { shotId: shots[2]!.id, castMemberId: girl.id });
      replaceAutoOverlays(ws.db, shots[1]!.id, [
        { bbox: [0.05, 0.85, 0.5, 0.95], text: '作画監督 山田太郎', category: 'staff_credit' },
      ]);
      ws.close();

      await cliData(t, ['cast', 'map', girl.id, '--persona', persona.slug]);
      const status = await cliData<Array<{ mode: string; stage: string }>>(t, [
        'review',
        'status',
        project.slug,
      ]);
      expect(status.map((s) => s.mode)).toEqual(['replace', 'clean', 'replace', 'keep']);
      expect(status.map((s) => s.stage)).toEqual(['board_pending', 'take_pending', 'board_pending', 'keep']);

      // Takes for replace shots are refused until a board is approved.
      const early = await cliData<{ takes: unknown[] }>(t, [
        'take',
        'generate',
        project.slug,
        shots[1]!.id,
        '--wait',
      ]);
      expect(early.takes).toHaveLength(1);

      const boards = await cliData<{ boards: Array<{ id: string }> }>(t, [
        'board',
        'generate',
        project.slug,
        '--all',
        '--wait',
      ]);
      expect(boards.boards).toHaveLength(2);
      for (const b of boards.boards) await cliData(t, ['review', 'approve', b.id]);

      const takes = await cliData<{ takes: Array<{ id: string; shotId: string }> }>(t, [
        'take',
        'generate',
        project.slug,
        '--all',
        '--wait',
      ]);
      expect(takes.takes.map((x) => x.shotId).sort()).toEqual([shots[0]!.id, shots[2]!.id].sort());
      const allTakes = [...takes.takes, ...(early.takes as Array<{ id: string; shotId: string }>)];
      for (const take of allTakes) {
        const shown = await cliData<{ take: { path: string; framesOut: number; status: string } }>(t, [
          'take',
          'show',
          take.id,
        ]);
        const shot = shots.find((s) => s.id === take.shotId)!;
        expect(shown.take).toMatchObject({ status: 'ready', framesOut: shot.frameCount });
        expect(await probe(path.join(root, shown.take.path), { countFrames: true })).toMatchObject({
          frameCount: shot.frameCount,
          width: 640,
          height: 360,
          fpsNum: 24000,
          fpsDen: 1001,
          hasAudio: false,
        });
        await cliData(t, ['review', 'approve', take.id]);
      }

      const rendered = await cliData<{ render: { id: string } }>(t, [
        'render',
        'create',
        project.slug,
        '--wait',
      ]);
      const [render] = await cliData<
        Array<{
          path: string;
          comparePath: string;
          compareProxyPath: string;
          shots: Array<{ source: string }>;
        }>
      >(t, ['render', 'list', project.slug]);
      expect(rendered.render.id).toBeTruthy();
      expect(render!.shots.map((s) => s.source)).toEqual(['take', 'take', 'take', 'original']);
      expect(await probe(path.join(root, render!.path), { countFrames: true })).toMatchObject({
        frameCount: 155,
        width: 640,
        height: 360,
        hasAudio: true,
      });
      expect(existsSync(path.join(root, render!.comparePath))).toBe(true);
      expect(existsSync(path.join(root, render!.compareProxyPath))).toBe(true);

      const sheet = await cliData<{ absPath: string }>(t, ['take', 'sheet', takes.takes[0]!.id]);
      expect(await probe(sheet.absPath)).toMatchObject({ height: 540 });

      // Feedback becomes an agent task with everything Codex needs.
      const changed = await cliData<{ task: { id: string } }>(t, [
        'review',
        'request-changes',
        takes.takes[0]!.id,
        '--comment',
        '頭髮再亮一點',
      ]);
      const next = await cliData<{
        task: { id: string; status: string };
        target: { absPath: string };
        next: string;
      }>(t, ['tasks', 'next']);
      expect(next.task).toMatchObject({ id: changed.task.id, status: 'claimed' });
      expect(existsSync(next.target.absPath)).toBe(true);
      expect(next.next).toContain('take generate');

      // Promote an approved draft take to preview: same inputs, 720p output.
      const promoted = await cliData<{ take: { id: string; tier: string } }>(t, [
        'take',
        'promote',
        shots[2]!.id,
        '--wait',
      ]);
      expect(promoted.take.tier).toBe('preview');
      const shownPromoted = await cliData<{ take: { path: string } }>(t, ['take', 'show', promoted.take.id]);
      expect(await probe(path.join(root, shownPromoted.take.path), { countFrames: true })).toMatchObject({
        frameCount: shots[2]!.frameCount,
        height: 720,
      });

      const cost = await cliData<{ totalUsd: number }>(t, ['cost']);
      expect(cost.totalUsd).toBe(0);
    } finally {
      await daemon.stop();
    }
  }, 300_000);
});
