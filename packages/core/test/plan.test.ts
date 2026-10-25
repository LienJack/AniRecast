import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  initWorkspace,
  mapCast,
  planBoard,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  updateSource,
  type Workspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

function fixture(): { ws: Workspace; projectId: string; shotId: string; personaId: string } {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(
    ws.db,
    src.id,
    {
      status: 'ready',
      fpsNum: 24,
      fpsDen: 1,
      durationMs: 1_000,
      width: 1920,
      height: 1080,
      filePath: 'sources/x/source.mp4',
    },
    'daemon',
  );
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
  const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
  const frame = 'projects/op/kf.jpg';
  mkdirSync(path.dirname(ws.abs(frame)), { recursive: true });
  writeFileSync(ws.abs(frame), 'frame');
  setKeyframes(ws.db, shot!.id, [{ frame: 12, role: 'mid', path: frame }]);
  const ref = path.join(tempDir(), 'ref.png');
  writeFileSync(ref, 'ref');
  const persona = createPersona(ws, { name: 'P' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  return { ws, projectId: project.id, shotId: shot!.id, personaId: persona.id };
}

function detect(ws: Workspace, trackletId: string, frame: number, box: number[]): void {
  run(
    ws.db,
    `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json) VALUES (:id, :trackletId, :frame, :box)`,
    { id: `det_${trackletId}_${frame}_${box[0]}`, trackletId, frame, box: JSON.stringify(box) },
  );
}

function boardFor(setup: (ws: Workspace, shotId: string, castId: string) => void): string {
  const { ws, projectId, shotId, personaId } = fixture();
  const girl = createCastMember(ws.db, { projectId, label: 'girl' }, 'daemon');
  setup(ws, shotId, girl.id);
  mapCast(ws.db, girl.id, personaId, 'user');
  recomputeShotModes(ws.db, projectId);
  const { prompt } = planBoard(ws, shotId);
  ws.close();
  return prompt;
}

describe('board prompt: who is on screen', () => {
  it('counts one person whose track split during the shot once', () => {
    const prompt = boardFor((ws, shotId, castId) => {
      detect(ws, createTracklet(ws.db, { shotId, castMemberId: castId }).id, 2, [0.1, 0.1, 0.2, 0.3]);
      detect(ws, createTracklet(ws.db, { shotId, castMemberId: castId }).id, 14, [0.7, 0.1, 0.8, 0.3]);
    });
    expect(prompt).toContain('Replace the person on the right');
    expect(prompt).not.toContain('people to replace');
  });

  it('counts the same head detected twice at two sizes once', () => {
    const prompt = boardFor((ws, shotId, castId) => {
      detect(ws, createTracklet(ws.db, { shotId, castMemberId: castId }).id, 12, [0.2, 0.1, 0.45, 0.6]);
      detect(ws, createTracklet(ws.db, { shotId, castMemberId: castId }).id, 12, [0.25, 0.15, 0.35, 0.4]);
    });
    expect(prompt).not.toContain('people to replace');
  });

  it('draws the board from the keyframe where the character is, not an empty representative frame', () => {
    const { ws, projectId, shotId, personaId } = fixture();
    const late = 'projects/op/kf-late.jpg';
    writeFileSync(ws.abs(late), 'late frame');
    setKeyframes(ws.db, shotId, [
      { frame: 12, role: 'mid', path: 'projects/op/kf.jpg' },
      { frame: 22, role: 'last', path: late },
    ]);
    const girl = createCastMember(ws.db, { projectId, label: 'girl' }, 'daemon');
    detect(ws, createTracklet(ws.db, { shotId, castMemberId: girl.id }).id, 22, [0.7, 0.1, 0.8, 0.3]);
    mapCast(ws.db, girl.id, personaId, 'user');
    recomputeShotModes(ws.db, projectId);
    const plan = planBoard(ws, shotId);
    expect(plan.inputs[0]?.path).toBe(late);
    expect(plan.prompt).toContain('Replace the person on the right');
    ws.close();
  });

  it('does not prefer a keyframe just because one head was detected twice there', () => {
    const { ws, projectId, shotId, personaId } = fixture();
    const early = 'projects/op/kf-early.jpg';
    writeFileSync(ws.abs(early), 'early frame');
    setKeyframes(ws.db, shotId, [
      { frame: 2, role: 'first', path: early },
      { frame: 12, role: 'mid', path: 'projects/op/kf.jpg' },
    ]);
    const girl = createCastMember(ws.db, { projectId, label: 'girl' }, 'daemon');
    const a = createTracklet(ws.db, { shotId, castMemberId: girl.id }).id;
    const b = createTracklet(ws.db, { shotId, castMemberId: girl.id }).id;
    detect(ws, a, 2, [0.2, 0.1, 0.45, 0.6]);
    detect(ws, b, 2, [0.25, 0.15, 0.35, 0.4]);
    detect(ws, a, 12, [0.2, 0.1, 0.45, 0.6]);
    mapCast(ws.db, girl.id, personaId, 'user');
    recomputeShotModes(ws.db, projectId);
    expect(planBoard(ws, shotId).inputs[0]?.path).toBe('projects/op/kf.jpg');
    ws.close();
  });

  it('keeps every view of a character in a collage frame', () => {
    const prompt = boardFor((ws, shotId, castId) => {
      for (const x of [0.05, 0.3, 0.55, 0.8])
        detect(ws, createTracklet(ws.db, { shotId, castMemberId: castId }).id, 12, [x, 0.1, x + 0.1, 0.3]);
    });
    expect(prompt).toContain('There are 4 people to replace');
  });
});
