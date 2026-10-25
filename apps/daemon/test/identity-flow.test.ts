import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type CastMember,
  initWorkspace,
  type Job,
  listJobs,
  openWorkspace,
  TERMINAL_STATUSES,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { cliData, TEST_CONFIG } from './helpers.ts';

const SPIKE = path.resolve(
  import.meta.dirname,
  '../../../.trellis/tasks/10-24-anirecast-prd/research/gemini-api-spike',
);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-identity-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function waitIdle(root: string, timeoutMs = 300_000): Promise<Job[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ws = openWorkspace(root, { role: 'cli' });
    const jobs = listJobs(ws.db, { limit: 500 });
    ws.close();
    if (jobs.every((j) => TERMINAL_STATUSES.includes(j.status))) return jobs;
    if (Date.now() > deadline)
      throw new Error(`jobs still active: ${JSON.stringify(jobs.map((j) => [j.type, j.status]))}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** One still per shot: original girl, the persona swapped into the same frame, the persona sheet (two heads). */
async function stillsVideo(out: string): Promise<void> {
  const stills = ['a-frame-0.jpg', 'c-board-0.jpg', 'b-persona-0.jpg'].map((f) => path.join(SPIKE, f));
  const inputs = stills.flatMap((s) => ['-loop', '1', '-framerate', '24', '-t', '1', '-i', s]);
  const chains = stills.map(
    (_, i) =>
      `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,trim=end_frame=24,format=yuv420p[v${i}]`,
  );
  await ffmpeg([
    ...inputs,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `${chains.join(';')};[v0][v1][v2]concat=n=3:v=1:a=0[v]`,
    '-map',
    '[v]',
    '-map',
    '3:a',
    '-t',
    '3',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-c:a',
    'aac',
    out,
  ]);
}

describe('same-person identification (real sidecar, fake provider)', () => {
  it('detects, clusters, hands doubtful cases to Codex and keeps user locks', async () => {
    const root = path.join(tmp, 'ws');
    initWorkspace(root).close();
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...TEST_CONFIG, provider: 'fake', pipeline: { autoAnalyze: true } },
      provider: new FakeProvider(),
      dispatch: false,
      log: () => {},
    });
    const t = { root, env: { ...process.env, ANIRECAST_CONFIG_DIR: path.join(tmp, 'cfg') } };
    try {
      const video = path.join(tmp, 'stills.mp4');
      await stillsVideo(video);
      const { source } = await cliData<{ source: { id: string } }>(t, ['source', 'import', video, '--wait']);
      const project = await cliData<{ slug: string }>(t, [
        'project',
        'create',
        '--source',
        source.id,
        '--name',
        'Identity',
      ]);
      await cliData(t, ['clip', 'set', project.slug, '--in', 'f:0', '--out', 'f:72', '--wait']);
      const jobs = await waitIdle(root);
      expect(jobs.filter((j) => j.status !== 'succeeded').map((j) => [j.type, j.error])).toEqual([]);
      expect(jobs.map((j) => j.type)).toEqual(
        expect.arrayContaining(['shots.detect', 'shots.analyze', 'cast.identify']),
      );

      const shots = await cliData<Array<{ id: string }>>(t, ['shots', 'list', project.slug]);
      expect(shots).toHaveLength(3);
      const cast = await cliData<CastMember[]>(t, ['cast', 'list', project.slug]);
      const castOf = (shotId: string) => cast.filter((c) => c.shotIds.includes(shotId)).map((c) => c.id);
      const [girl] = castOf(shots[0]!.id);
      const [board] = castOf(shots[1]!.id);
      // The original girl and the persona are different people; the persona in the board and in the sheet are one.
      expect(girl).toBeDefined();
      expect(board).toBeDefined();
      expect(girl).not.toBe(board);
      expect(castOf(shots[2]!.id)).toContain(board);
      // Two heads in one frame are never the same person, so the sheet's second head is its own member.
      expect(castOf(shots[2]!.id)).toHaveLength(2);

      const tasks = await cliData<
        Array<{
          id: string;
          kind: string;
          payload: { contactSheets: string[]; cases: Array<{ type: string }> };
        }>
      >(t, ['tasks', 'list', '--open']);
      const review = tasks.find((x) => x.kind === 'cast_review');
      expect(review?.payload.cases.length).toBeGreaterThan(0);
      for (const sheet of review!.payload.contactSheets)
        expect(existsSync(path.join(root, sheet))).toBe(true);

      // The user says both sheet heads are the persona; re-identification must keep that.
      const second = cast.find((c) => c.shotIds.includes(shots[2]!.id) && c.id !== board)!;
      await cliData(t, ['cast', 'assign', second.tracklets[0]!.id, '--to', board!]);
      await cliData(t, ['cast', 'analyze', project.slug, '--wait']);
      const after = await cliData<CastMember[]>(t, ['cast', 'list', project.slug]);
      const persona = after.find((c) => c.id === board)!;
      expect(persona.tracklets.map((x) => x.id)).toContain(second.tracklets[0]!.id);
      expect(persona.tracklets.find((x) => x.id === second.tracklets[0]!.id)?.assignedBy).toBe('user');
    } finally {
      await daemon.stop();
    }
  }, 600_000);
});
