import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { uploadSeconds, videoModelSpec } from '@anirecast/shared';
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
  planTake,
  projectModels,
  queueBoard,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  setProjectModels,
  submitReview,
  updateShot,
  updateSource,
  type Workspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

const H3 = 'fal:minimax/h3-max/recast';
const WAN = 'fal:fal-ai/wan/v2.7/edit-video';

function fixture(): { ws: Workspace; projectId: string; shotId: string } {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000 }, 'daemon');
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
  const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
  mkdirSync(ws.abs('projects/op'), { recursive: true });
  for (const f of ['kf.jpg', 'shot.mp4', 'board.png']) writeFileSync(ws.abs(`projects/op/${f}`), f);
  setKeyframes(ws.db, shot!.id, [{ frame: 12, role: 'mid', path: 'projects/op/kf.jpg' }]);
  updateShot(ws.db, shot!.id, { sourcePath: 'projects/op/shot.mp4' }, 'daemon');
  const ref = path.join(tempDir(), 'ref.png');
  writeFileSync(ref, 'ref');
  const persona = createPersona(ws, { name: 'Claude' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
  createTracklet(ws.db, { shotId: shot!.id, castMemberId: girl.id });
  mapCast(ws.db, girl.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  const { board } = queueBoard(ws, shot!.id, 'user');
  run(ws.db, `UPDATE boards SET status = 'ready', path = 'projects/op/board.png' WHERE id = :id`, {
    id: board.id,
  });
  submitReview(ws, { targetId: board.id, verdict: 'approve', actor: 'user' });
  return { ws, projectId: project.id, shotId: shot!.id };
}

describe('selectable models', () => {
  it('lets a project choose its models from the catalogue only', () => {
    const { ws, projectId } = fixture();
    expect(projectModels(ws.db, projectId).video).toBe('gemini-omni-1.1-flash');
    expect(
      setProjectModels(
        ws.db,
        projectId,
        { video: H3, image: 'fal:openai/gpt-image-2.5/sunburst/edit' },
        'user',
      ),
    ).toMatchObject({ video: H3, image: 'fal:openai/gpt-image-2.5/sunburst/edit' });
    expect(() =>
      setProjectModels(ws.db, projectId, { video: 'fal:alibaba/wan-3.0/text-to-video' }, 'user'),
    ).toThrow(/not a selectable video model/);
    expect(setProjectModels(ws.db, projectId, { video: null }, 'user').video).toBe('gemini-omni-1.1-flash');
    ws.close();
  });

  it("pads uploads to each model's minimum and, for Wan 3.0, to whole seconds", () => {
    expect(uploadSeconds(videoModelSpec('gemini-omni-1.1-flash'), 1.25)).toBe(1.25);
    expect(uploadSeconds(videoModelSpec(H3), 1.25)).toBe(5);
    expect(uploadSeconds(videoModelSpec('fal:alibaba/wan-3.0/reference-to-video'), 1.25)).toBe(2);
    expect(uploadSeconds(videoModelSpec('fal:alibaba/wan-3.0/reference-to-video'), 5.3)).toBe(6);
  });

  it('gives each video model the references it takes', () => {
    const { ws, shotId } = fixture();
    const roles = (model: string) =>
      planTake(ws, shotId, 'draft', { model }).inputs.map((i) => i.role.split(':')[0]);
    // Omni: the storyboard frame and the character.
    expect(roles('gemini-omni-1.1-flash')).toEqual(['video', 'board', 'persona']);
    // H3 Recast: one picture per new character, no storyboard frame.
    expect(roles(H3)).toEqual(['video', 'persona']);
    expect(planTake(ws, shotId, 'draft', { model: H3 }).prompt).toContain('shown in <IMAGE_REF_0>.');
    // Wan edit: a single reference, the storyboard frame that already shows everyone replaced.
    expect(roles(WAN)).toEqual(['video', 'board']);
    // Wan 3.0 reference-to-video: the storyboard frame and the character, like Omni.
    expect(roles('fal:alibaba/wan-3.0/reference-to-video')).toEqual(['video', 'board', 'persona']);
    expect(planTake(ws, shotId, 'draft', { model: WAN }).prompt).toContain(
      'with the character shown in <IMAGE_REF_0>.',
    );
    ws.close();
  });
});
