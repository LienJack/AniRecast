import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPersonaImage,
  claimAgentTask,
  createAgentTask,
  createBoard,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  enqueueJob,
  getAgentTask,
  getTake,
  handOffToClaude,
  initWorkspace,
  latestShotJob,
  mapCast,
  openWorkspace,
  projectOfShot,
  queueFramesTake,
  queueTake,
  queueTakeMerge,
  queueTakePlan,
  recomputeShotModes,
  replaceShots,
  routeTask,
  run,
  setKeyframes,
  type TakePlanResult,
  updateShot,
  updateSource,
} from '@anirecast/core';
import { ffmpeg, probe, rangePsnr } from '@anirecast/media';
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

  it('sends Seedance a 23.976 fps shot at 24 fps and 1080p, and a retry after the paid request does not pay again', async () => {
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
      const { take, job } = queueTake(cli, shotId, 'final', 'user', {
        model: 'fal:bytedance/seedance-2.5/us/reference-to-video',
      });
      expect(await waitJob(root, job.id)).toBe('succeeded');
      // 24 frames held to Seedance's 4 s editing minimum, restamped to 24 fps without dropping one, at the take's
      // 1080p.
      expect(sent).toEqual([{ fps: '24/1', frames: 96, height: 1080, inputSeconds: 4 }]);
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

  it('redoes only some frames of a take and keeps the others exactly', async () => {
    const { root, shotId } = await setup('part');
    await withDaemon(
      root,
      () => ANSWER,
      async (asked) => {
        const cli = openWorkspace(root, { role: 'cli' });
        const first = queueTake(cli, shotId, 'final', 'user');
        expect(await waitJob(root, first.job.id)).toBe('succeeded');
        // The director learns who is on screen when, from the detections.
        expect(asked[0]!.prompt).toContain('When each person to replace is on screen');
        expect(asked[0]!.prompt).toContain('「千束」 → "Claude": 0.50–0.50 s (centre, medium)');
        const kept = getTake(cli.db, first.take.id);
        expect(() => queueTake(cli, shotId, 'final', 'user', { range: { start: 0, end: 11 } })).toThrow(
          /needs the take whose other frames are kept/,
        );
        expect(() =>
          queueTake(cli, shotId, 'final', 'user', { range: { start: 0, end: 23 }, keepFrom: kept.id }),
        ).toThrow(/whole shot/);
        asked.length = 0;
        const part = queueTake(cli, shotId, 'final', 'user', {
          range: { start: 0, end: 11 },
          keepFrom: kept.id,
        });
        expect(await waitJob(root, part.job.id)).toBe('succeeded');
        // The director watched only the part and saw the kept frame it must flow into.
        expect(asked[0]!.prompt).toContain('ONLY frames 0–11');
        expect(asked[0]!.prompt).toContain('already made: frame 12 of the finished shot');
        const done = getTake(cli.db, part.take.id);
        cli.close();
        expect(done.params).toMatchObject({ range: { start: 0, end: 11 }, keepFrom: kept.id });
        expect(await probe(path.join(root, done.path!), { countFrames: true })).toMatchObject({
          frameCount: 24,
        });
        // Frames 12–23 are the kept take's own; frames 0–11 are new.
        expect(
          await rangePsnr(path.join(root, kept.path!), path.join(root, done.path!), { from: 12, count: 12 }),
        ).toBeGreaterThan(40);
        expect(done.conform).toMatchObject({ range: { start: 0, end: 11 }, kept: { from: kept.id } });
        // Codex hands the feedback on it to Claude: a brief, and the task waits, open, for Claude.
        const db = openWorkspace(root, { role: 'cli' });
        const task = createAgentTask(db.db, {
          kind: 'review_feedback',
          projectId: projectOfShot(db.db, shotId).id,
          shotId,
          payload: { targetType: 'take', targetId: done.id, comment: '第 0 幀還沒換', agent: 'codex' },
          createdBy: 'user',
        });
        claimAgentTask(db.db, task.id, 'codex:thr_1');
        const handed = handOffToClaude(
          db,
          task.id,
          { reason: 'needs a CLI feature', tried: 'v2', plan: 'add it', repoRoot: '/repo' },
          'codex',
        );
        const brief = readFileSync(handed.brief, 'utf8');
        expect(brief).toContain(`# 接手 AniRecast 任務 ${task.id}`);
        expect(brief).toContain('第 0 幀還沒換');
        expect(brief).toMatch(/\| v2 \(.+\) \| ready \| .+ \| 0–11 \|/);
        expect(brief).toContain(`anirecast tasks done ${task.id}`);
        expect(handed.command).toBe(`cd ${root} && claude "處理 AniRecast 待辦任務"`);
        expect(getAgentTask(db.db, task.id)).toMatchObject({
          status: 'open',
          claimedBy: null,
          payload: { routedTo: 'claude', handoff: { to: 'claude', by: 'codex' } },
        });
        // Routing: everything goes to Claude by default; under `auto` a simple shot goes to Codex and cuts inside
        // it send it to Claude. The human's pick always wins.
        const feedback = (agent?: 'codex' | 'claude') =>
          createAgentTask(db.db, {
            kind: 'review_feedback',
            projectId: projectOfShot(db.db, shotId).id,
            shotId,
            payload: { targetType: 'take', targetId: done.id, ...(agent ? { agent } : {}) },
            createdBy: 'user',
          }).id;
        expect(routeTask(db, feedback(), { fallback: 'claude' })).toEqual({
          to: 'claude',
          reasons: ['預設交給 Claude'],
        });
        expect(routeTask(db, feedback())).toEqual({ to: 'codex', reasons: [] });
        expect(routeTask(db, feedback(), { cuts: 2 })).toEqual({
          to: 'claude',
          reasons: ['鏡頭裡有 2 個切鏡'],
        });
        expect(routeTask(db, feedback('claude')).to).toBe('claude');
        expect(routeTask(db, feedback('codex'), { cuts: 2, fallback: 'claude' }).to).toBe('codex');
        db.close();

        // Two more parts made from the same base side by side, then joined: no model call.
        const cli2 = openWorkspace(root, { role: 'cli' });
        const a = queueTake(cli2, shotId, 'final', 'user', {
          range: { start: 4, end: 7 },
          keepFrom: kept.id,
          seams: 'none',
        });
        const b = queueTake(cli2, shotId, 'final', 'user', {
          range: { start: 16, end: 19 },
          keepFrom: kept.id,
        });
        expect(a.take.params.seams).toBe('none');
        cli2.close();
        expect(await waitJob(root, a.job.id)).toBe('succeeded');
        expect(await waitJob(root, b.job.id)).toBe('succeeded');
        const cli3 = openWorkspace(root, { role: 'cli' });
        expect(() => queueTakeMerge(cli3, kept.id, [a.take.id, done.id], 'user')).toThrow(/overlap/);
        const sent = asked.length;
        const joined = queueTakeMerge(cli3, kept.id, [b.take.id, a.take.id], 'user');
        expect(await waitJob(root, joined.job.id)).toBe('succeeded');
        expect(asked.length).toBe(sent);
        const j = getTake(cli3.db, joined.take.id);
        cli3.close();
        const out = path.join(root, j.path!);
        expect(await probe(out, { countFrames: true })).toMatchObject({ frameCount: 24 });
        const partA = path.join(root, getTake(openWorkspace(root, { role: 'cli' }).db, a.take.id).path!);
        expect(await rangePsnr(partA, out, { from: 4, count: 4 })).toBeGreaterThan(40);
        expect(await rangePsnr(path.join(root, kept.path!), out, { from: 8, count: 8 })).toBeGreaterThan(40);
        expect(j).toMatchObject({ status: 'ready', costUsd: 0, conform: { base: kept.id } });
        expect((j.conform as { psnrDb: number[] }).psnrDb).toHaveLength(5);

        // 逐格重繪: frames 2–9 redrawn one drawing at a time, the rest kept.
        const cli4 = openWorkspace(root, { role: 'cli' });
        const fr = queueFramesTake(
          cli4,
          shotId,
          { range: { start: 2, end: 9 }, keepFrom: kept.id, extra: 'x' },
          'user',
        );
        cli4.close();
        expect(await waitJob(root, fr.job.id)).toBe('succeeded');
        const cli5 = openWorkspace(root, { role: 'cli' });
        const f = getTake(cli5.db, fr.take.id);
        cli5.close();
        expect(f.model).toMatch(/^frames:/);
        expect(await probe(path.join(root, f.path!), { countFrames: true })).toMatchObject({
          frameCount: 24,
        });
        expect(
          await rangePsnr(path.join(root, kept.path!), path.join(root, f.path!), { from: 10, count: 14 }),
        ).toBeGreaterThan(40);
        const conform = f.conform as {
          frames: { drawings: number; edited: number };
          kept: { psnrDb: number[] };
        };
        expect(conform.frames.edited).toBe(conform.frames.drawings);
        expect(conform.frames.drawings).toBeGreaterThan(0);
        expect(conform.kept.psnrDb).toHaveLength(2);
      },
    );
  }, 120_000);
});
