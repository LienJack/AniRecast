import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  getBoard,
  initWorkspace,
  mapCast,
  openWorkspace,
  queueBoard,
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
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-director-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const picture = (file: string, size: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', file]);

async function setup(name: string) {
  const root = path.join(tmp, name);
  const ws = initWorkspace(root);
  const src = createSource(ws.db, { title: 'Lycoris Recoil OP' }, 'user');
  updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000 }, 'daemon');
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
  const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
  mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
  for (const k of ['first', 'mid', 'last']) await picture(ws.abs(`projects/op/${k}.jpg`), '320x180');
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
  await picture(ws.abs('projects/op/crops/b.jpg'), '200x400');
  run(
    ws.db,
    `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json, body_crop_path)
     VALUES ('det_1', :t, 12, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]', 'projects/op/crops/b.jpg')`,
    { t: t.id },
  );
  mapCast(ws.db, chisato.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  const { board } = queueBoard(ws, shot!.id, 'user', {
    role: 'key',
    extra: 'Keep her left hand on the rail.',
  });
  ws.close();
  return { root, boardId: board.id, planned: board.prompt };
}

async function runBoard(root: string, boardId: string, vision: (req: VisionRequest) => unknown) {
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
    const cli = openWorkspace(root, { role: 'cli' });
    for (let i = 0; i < 300; i++) {
      const b = getBoard(cli.db, boardId);
      if (b.status === 'ready' || b.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const board = getBoard(cli.db, boardId);
    cli.close();
    return { board, asked };
  } finally {
    await daemon.stop();
  }
}

const PROMPT =
  'Replace the girl in the middle of Image 1 (blonde bob, red uniform) with the character in Image 2: silver bob, red ribbon. She leans on the rail, left hand on it, looking right, smiling. Keep the framing, the café background and the warm evening light; draw her in the same flat cel style.';

describe('the storyboard director', () => {
  it('writes the instruction and picks the references from what it sees', async () => {
    const { root, boardId } = await setup('ok');
    const { board, asked } = await runBoard(root, boardId, () => ({
      analysis: { scene: 'café', action: 'leaning', composition: 'mid shot', lighting: 'warm', style: 'cel' },
      // F is the frame (always sent) and C1 context only: neither may be picked.
      references: ['R1', 'F', 'C1'],
      prompt: PROMPT,
      notes: '千束換成 Claude，靠在欄杆上微笑',
    }));
    expect(board.status).toBe('ready');
    // The frame, the other moments (context), the original person and the library picture.
    const director = asked[0]!;
    expect(director.prompt).toContain('storyboard director');
    expect(director.prompt).toContain('mandatory: Keep her left hand on the rail.');
    expect(director.images.length).toBe(5);
    expect(board.prompt).toBe(`${PROMPT}\nAdditional instructions: Keep her left hand on the rail.`);
    expect(board.inputs.map((i) => i.role)).toEqual(['frame', 'ref:R1']);
    expect(board.inputs[0]!.path).toBe('projects/op/mid.jpg');
    expect(board.params.director).toMatchObject({
      notes: '千束換成 Claude，靠在欄杆上微笑',
      references: [{ id: 'R1' }],
    });
  }, 60_000);

  it('keeps the planned instruction when the director gives nothing usable', async () => {
    const { root, boardId, planned } = await setup('fallback');
    const { board } = await runBoard(root, boardId, () => ({ references: [], prompt: 'ok' }));
    expect(board.status).toBe('ready');
    expect(board.prompt).toBe(planned);
    expect(board.params.director).toMatchObject({ fallback: true });
  }, 60_000);
});
