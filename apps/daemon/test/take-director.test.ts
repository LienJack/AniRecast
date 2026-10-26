import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPersonaImage,
  createBoard,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  enqueueJob,
  getTake,
  initWorkspace,
  latestShotJob,
  mapCast,
  openWorkspace,
  queueTake,
  queueTakePlan,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  type TakePlanResult,
  updateShot,
  updateSource,
} from '@anirecast/core';
import { ffmpeg, probe } from '@anirecast/media';
import { FakeProvider, type VideoEditRequest, type VisionRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-take-director-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const picture = (file: string, size: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', file]);

async function setup(name: string, fps = { num: 24, den: 1 }) {
  const root = path.join(tmp, name);
  const ws = initWorkspace(root);
  const src = createSource(ws.db, { title: 'Lycoris Recoil OP' }, 'user');
  updateSource(
    ws.db,
    src.id,
    { status: 'ready', fpsNum: fps.num, fpsDen: fps.den, durationMs: 1_100 },
    'daemon',
  );
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
  const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
  mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x180:rate=${fps.num}/${fps.den}`,
    '-frames:v',
    '24',
    '-pix_fmt',
    'yuv420p',
    ws.abs('projects/op/shot.mp4'),
  ]);
  updateShot(ws.db, shot!.id, { sourcePath: 'projects/op/shot.mp4' }, 'daemon');
  for (const k of ['first', 'mid', 'last', 'board']) await picture(ws.abs(`projects/op/${k}.jpg`), '320x180');
  setKeyframes(ws.db, shot!.id, [
    { frame: 0, role: 'first', path: 'projects/op/first.jpg' },
    { frame: 12, role: 'mid', path: 'projects/op/mid.jpg' },
    { frame: 23, role: 'last', path: 'projects/op/last.jpg' },
  ]);
  const ref = path.join(tmp, `${name}-ref.png`);
  await picture(ref, '256x384');
  const persona = createPersona(ws, { name: 'Claude', description: 'silver bob, red ribbon' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const chisato = createCastMember(ws.db, { projectId: project.id, label: '千束' }, 'daemon');
  const t = createTracklet(ws.db, { shotId: shot!.id, castMemberId: chisato.id });
  run(
    ws.db,
    `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json)
     VALUES ('det_1', :t, 12, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]')`,
    { t: t.id },
  );
  mapCast(ws.db, chisato.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  // An approved key storyboard frame.
  const board = createBoard(ws.db, {
    shotId: shot!.id,
    role: 'key',
    frame: 12,
    prompt: 'p',
    model: 'm',
    createdBy: 'user',
  });
  run(ws.db, `UPDATE boards SET status = 'approved', path = 'projects/op/board.jpg' WHERE id = :id`, {
    id: board.id,
  });
  ws.close();
  return { root, shotId: shot!.id };
}

async function withDaemon<T>(
  root: string,
  vision: (req: VisionRequest) => unknown,
  fn: (asked: VisionRequest[]) => Promise<T>,
) {
  const asked: VisionRequest[] = [];
  const provider = new FakeProvider({
    vision: (req) => {
      asked.push(req);
      return vision(req);
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
    return await fn(asked);
  } finally {
    await daemon.stop();
  }
}

const waitJob = async (root: string, id: string) => {
  const cli = openWorkspace(root, { role: 'cli' });
  try {
    for (let i = 0; i < 400; i++) {
      const row = cli.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string };
      if (['succeeded', 'failed'].includes(row.status)) return row.status;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'timeout';
  } finally {
    cli.close();
  }
};

const ANSWER = {
  analysis: { motion: 'walks right', camera: 'slow push in', timing: 'even', lighting: 'warm', style: 'cel' },
  // R1 is the approved storyboard frame, R2 the library picture: composited into one image.
  send: [{ ids: ['R1', 'R2'], what: 'storyboard frame and her library picture' }],
  prompt:
    'Replace the girl in the middle (blonde bob, red uniform) with Claude, the character shown in <IMAGE_REF_0>: silver bob, red ribbon. She walks right exactly as the original does while the camera slowly pushes in; keep the background, timing and warm light, flat 2D cel style.',
  notes: '千束換成銀髮角色，照原片往右走',
};

describe('the video director', () => {
  it('watches the shot, composites the references and never names the library character', async () => {
    const { root, shotId } = await setup('take');
    const cli = openWorkspace(root, { role: 'cli' });
    const { take, job } = queueTake(cli, shotId, 'final', 'user');
    cli.close();
    await withDaemon(
      root,
      () => ANSWER,
      async (asked) => {
        expect(await waitJob(root, job.id)).toBe('succeeded');
        const d = asked[0]!;
        // The clip itself, the three frames (context), the storyboard frame and the library picture.
        expect(d.images[0]!.mimeType).toBe('video/mp4');
        expect(d.images).toHaveLength(6);
        expect(d.prompt).toContain('NEVER write the library characters');
        const db = openWorkspace(root, { role: 'cli' });
        const done = getTake(db.db, take.id);
        db.close();
        expect(done.prompt).not.toMatch(/Claude/);
        expect(done.prompt).toContain('the new character, the character shown in <IMAGE_REF_0>');
        expect(done.inputs.map((i) => i.role)).toEqual(['video', 'ref:R1+R2']);
        expect(done.inputs[1]!.path).toMatch(/takes\/t001-ref1\.jpg$/);
        expect(existsSync(path.join(root, done.inputs[1]!.path))).toBe(true);
        expect(done.params.director).toMatchObject({ notes: ANSWER.notes, critique: { changes: [] } });
        // The instruction was reviewed once more, against the clip and the exact image sent, before the request.
        expect(asked).toHaveLength(2);
        expect(asked[1]!.prompt).toContain('expensive request');
        expect(asked[1]!.images.map((i) => i.mimeType)).toEqual(['video/mp4', 'image/jpeg']);
      },
    );
  }, 90_000);

  it('sends Seedance a 23.976 fps shot at 24 fps and 720p, and a retry after the paid request does not pay again', async () => {
    const { root, shotId } = await setup('fps', { num: 24_000, den: 1001 });
    const sent: Array<{ fps: string; frames: number; height: number; inputSeconds: number }> = [];
    class Counting extends FakeProvider {
      override async editVideo(req: VideoEditRequest) {
        const p = await probe(req.video.path, { countFrames: true });
        sent.push({
          fps: `${p.fpsNum}/${p.fpsDen}`,
          frames: p.frameCount,
          height: p.height,
          inputSeconds: req.inputSeconds,
        });
        return super.editVideo(req);
      }
    }
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...TEST_CONFIG, provider: 'fake' },
      provider: new Counting({ vision: () => ANSWER }),
      dispatch: false,
      log: () => {},
    });
    try {
      const cli = openWorkspace(root, { role: 'cli' });
      const { take, job } = queueTake(cli, shotId, 'final', 'user');
      expect(take.model).toContain('seedance');
      expect(await waitJob(root, job.id)).toBe('succeeded');
      // 24 frames held to Seedance's 2 s minimum, restamped to 24 fps without dropping one, and sent at 720p
      // (its pixel cap for reference videos) although the take is 1080p.
      expect(sent).toEqual([{ fps: '24/1', frames: 48, height: 720, inputSeconds: 2 }]);
      const done = getTake(cli.db, take.id);
      // Conformed back onto the shot: its 24 frames at 23.976.
      expect(await probe(path.join(root, done.path!), { countFrames: true })).toMatchObject({
        fpsNum: 24_000,
        fpsDen: 1001,
        frameCount: 24,
      });
      // The job runs again after the video was made (as when the download or the conform failed).
      run(cli.db, `UPDATE takes SET status = 'queued' WHERE id = :id`, { id: take.id });
      const again = enqueueJob(cli.db, {
        type: 'take.generate',
        lane: 'generate',
        payload: { takeId: take.id },
        requestedBy: 'user',
      });
      expect(await waitJob(root, again.id)).toBe('succeeded');
      expect(sent).toHaveLength(1);
      expect(getTake(cli.db, take.id)).toMatchObject({
        status: 'ready',
        path: done.path,
        costUsd: done.costUsd,
      });
      cli.close();
    } finally {
      await daemon.stop();
    }
  }, 90_000);

  it('previews the plan without making a video, and falls back when the images do not add up', async () => {
    const { root, shotId } = await setup('plan');
    const cli = openWorkspace(root, { role: 'cli' });
    const plan = queueTakePlan(cli, shotId, 'user');
    cli.close();
    await withDaemon(
      root,
      () => ANSWER,
      async () => {
        expect(await waitJob(root, plan.id)).toBe('succeeded');
      },
    );
    const db = openWorkspace(root, { role: 'cli' });
    const preview = latestShotJob<TakePlanResult>(db, shotId, 'take.plan');
    expect(preview?.result?.director.references[0]?.id).toBe('R1+R2');
    expect(db.db.prepare('SELECT count(*) AS n FROM takes').get()).toEqual({ n: 0 });
    // An instruction that refers to an image it does not send is not used.
    const { take, job } = queueTake(db, shotId, 'final', 'user');
    db.close();
    await withDaemon(
      root,
      () => ({ ...ANSWER, prompt: `${ANSWER.prompt} Match the pose in <IMAGE_REF_3>.` }),
      async () => {
        expect(await waitJob(root, job.id)).toBe('succeeded');
      },
    );
    const after = openWorkspace(root, { role: 'cli' });
    expect(getTake(after.db, take.id).params.director).toMatchObject({ fallback: true });
    after.close();
  }, 120_000);
});
