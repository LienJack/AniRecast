import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPersonaImage,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  enqueueJob,
  initWorkspace,
  listAgentTasks,
  listBoards,
  mapCast,
  openWorkspace,
  queueAllBoards,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  updateSource,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider, type VisionRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import type { JobHandler } from '../src/runner.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-board-batch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const picture = (file: string, size: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', file]);

describe('job concurrency', () => {
  it('runs shot videos one at a time while images share the lane', async () => {
    const root = path.join(tmp, 'limits');
    const ws = initWorkspace(root);
    ws.close();
    const running = { 'take.generate': 0, 'board.generate': 0 };
    const peak = { 'take.generate': 0, 'board.generate': 0 };
    const slow =
      (type: 'take.generate' | 'board.generate'): JobHandler =>
      async () => {
        running[type]++;
        peak[type] = Math.max(peak[type], running[type]);
        await new Promise((r) => setTimeout(r, 300));
        running[type]--;
        return { result: {} };
      };
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...TEST_CONFIG, provider: 'fake', concurrency: { generate: 3, media: 1, io: 1, video: 1 } },
      handlers: new Map([
        ['take.generate', slow('take.generate')],
        ['board.generate', slow('board.generate')],
      ]),
      dispatch: false,
      log: () => {},
    });
    try {
      const cli = openWorkspace(root, { role: 'cli' });
      for (let i = 0; i < 3; i++)
        enqueueJob(cli.db, { type: 'take.generate', lane: 'generate', payload: {}, requestedBy: 'user' });
      for (let i = 0; i < 4; i++)
        enqueueJob(cli.db, { type: 'board.generate', lane: 'generate', payload: {}, requestedBy: 'user' });
      for (let i = 0; i < 100; i++) {
        const left = cli.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status != 'succeeded'").get() as {
          n: number;
        };
        if (left.n === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      cli.close();
      expect(peak['take.generate']).toBe(1);
      expect(peak['board.generate']).toBeGreaterThanOrEqual(2);
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});

describe('生成全部分鏡圖', () => {
  it('draws every key frame, lets JEV skip a first or last frame like it, then hands the batch to Codex', async () => {
    const root = path.join(tmp, 'batch');
    const ws = initWorkspace(root);
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 2_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 48 }, 'user');
    const shots = replaceShots(
      ws.db,
      clip.id,
      [
        { start: 0, end: 23 },
        { start: 24, end: 47 },
      ],
      'daemon',
    );
    mkdirSync(ws.abs('projects/op'), { recursive: true });
    const ref = path.join(tmp, 'ref.png');
    await picture(ref, '256x384');
    const persona = createPersona(ws, { name: 'Claude' }, 'user');
    addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
    const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
    for (const [n, s] of shots.entries()) {
      const frames = [
        { frame: s.startFrame, role: 'first' },
        { frame: s.startFrame + 12, role: 'mid' },
        { frame: s.endFrame, role: 'last' },
      ];
      for (const f of frames) await picture(ws.abs(`projects/op/s${n}-${f.role}.jpg`), '320x180');
      setKeyframes(
        ws.db,
        s.id,
        frames.map((f) => ({ ...f, path: `projects/op/s${n}-${f.role}.jpg` })),
      );
      const t = createTracklet(ws.db, { shotId: s.id, castMemberId: girl.id });
      for (const f of frames)
        run(
          ws.db,
          `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json)
           VALUES (:id, :t, :frame, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]')`,
          { id: `det_${n}_${f.role}`, t: t.id, frame: f.frame },
        );
    }
    mapCast(ws.db, girl.id, persona.id, 'user');
    recomputeShotModes(ws.db, project.id);
    ws.close();

    const judged: VisionRequest[] = [];
    const provider = new FakeProvider({
      vision: (req) => {
        if (!req.prompt.includes('differs meaningfully from the key frame')) return {};
        judged.push(req);
        // The first frame looks like the key frame; the last one does not.
        return {
          first: { needed: false, similarity: 0.95, reason: '同一姿勢，只差一點點' },
          last: { needed: true, similarity: 0.4, reason: '轉身了' },
        };
      },
    });
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...TEST_CONFIG, provider: 'fake' },
      provider,
      dispatch: false,
      log: () => {},
    });
    try {
      const cli = openWorkspace(root, { role: 'cli' });
      const { queued, batch } = queueAllBoards(cli, project.id, 'user');
      expect(queued.map((q) => q.board.role)).toEqual(['key', 'key']);
      let review: ReturnType<typeof listAgentTasks>[number] | undefined;
      for (let i = 0; i < 300 && !review; i++) {
        review = listAgentTasks(cli.db, { projectId: project.id }).find((t) => t.kind === 'boards_review');
        if (!review) await new Promise((r) => setTimeout(r, 100));
      }
      expect(review).toBeDefined();
      expect(judged).toHaveLength(2);
      for (const s of shots) {
        const boards = listBoards(cli.db, s.id);
        expect(boards.map((b) => [b.role, b.status])).toEqual([
          ['key', 'ready'],
          ['last', 'ready'],
        ]);
        const key = boards[0]!;
        expect(key.params.followUpDecision).toMatchObject({
          first: { needed: false, reason: '同一姿勢，只差一點點' },
          last: { needed: true, boardId: boards[1]!.id },
        });
        expect(boards[1]!.params.consistentWith).toBe(key.id);
      }
      const payload = review!.payload as { batch: string; contactSheets: string[]; boards: unknown[] };
      expect(payload.batch).toBe(batch);
      expect(payload.boards).toHaveLength(4);
      expect(existsSync(path.join(root, payload.contactSheets[0]!))).toBe(true);
      // Once per batch.
      expect(
        listAgentTasks(cli.db, { projectId: project.id }).filter((t) => t.kind === 'boards_review'),
      ).toHaveLength(1);
      // A second run skips shots that already have a key frame.
      expect(queueAllBoards(cli, project.id, 'user').queued).toHaveLength(0);
      cli.close();
    } finally {
      await daemon.stop();
    }
  }, 120_000);
});
