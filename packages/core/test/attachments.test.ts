import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  answerAgentTask,
  attachToPlan,
  checkAttachments,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  getAgentTask,
  initWorkspace,
  listAgentTasks,
  mapCast,
  queueBoard,
  recomputeShotModes,
  replaceShots,
  run,
  saveAttachment,
  setKeyframes,
  submitReview,
  updateSource,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

function fixture() {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000 }, 'daemon');
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
  const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
  mkdirSync(ws.abs('projects/op'), { recursive: true });
  for (const f of ['kf.jpg', 'board.png']) writeFileSync(ws.abs(`projects/op/${f}`), f);
  setKeyframes(ws.db, shot!.id, [{ frame: 12, role: 'mid', path: 'projects/op/kf.jpg' }]);
  const ref = path.join(tempDir(), 'ref.png');
  writeFileSync(ref, 'ref');
  const persona = createPersona(ws, { name: 'Claude' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
  createTracklet(ws.db, { shotId: shot!.id, castMemberId: girl.id });
  mapCast(ws.db, girl.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  return { ws, projectId: project.id, shotId: shot!.id };
}

describe('attached images', () => {
  it('labels them after the other images, in the generator’s syntax', () => {
    const base = { prompt: 'p', params: {}, inputs: [{ role: 'frame', path: 'a.jpg' }] };
    expect(attachToPlan(base, ['x.png'], 'image').prompt).toContain('Image 2 is an image the human attached');
    // Tiled crops reach a design model as one image.
    const tiled = {
      ...base,
      inputs: [...base.inputs, { role: 'tile:1', path: 't1.jpg' }, { role: 'tile:2', path: 't2.jpg' }],
    };
    expect(attachToPlan(tiled, ['x.png'], 'image').prompt).toContain('Image 3 is');
    // A video model numbers its references from 0 and takes only so many.
    const video = {
      prompt: 'p',
      params: {},
      inputs: [
        { role: 'video', path: 'v.mp4' },
        { role: 'board', path: 'b.png' },
      ],
    };
    const sent = attachToPlan(video, ['x.png', 'y.png'], 'video', 2);
    expect(sent.prompt).toContain('<IMAGE_REF_1> is an image the human attached');
    expect(sent.inputs.map((i) => i.role)).toEqual(['video', 'board', 'attachment']);
    expect(sent.params.attachments).toEqual(['x.png', 'y.png']);
  });

  it('keeps them through revisions and refuses images from elsewhere', () => {
    const { ws, projectId, shotId } = fixture();
    const { path: pic } = saveAttachment(ws, projectId, new Uint8Array([1, 2, 3]), 'image/png');
    expect(pic).toMatch(/^projects\/op\/attachments\/att_.*\.png$/);
    expect(() => checkAttachments(ws, projectId, ['projects/op/kf.jpg'])).toThrow(/Not an attached image/);
    const { board } = queueBoard(ws, shotId, 'user', { role: 'key', attachments: [pic] });
    expect(board.inputs.at(-1)).toMatchObject({ role: 'attachment', path: pic });
    expect(board.prompt).toMatch(/Image \d+ is an image the human attached/);
    const again = queueBoard(ws, shotId, 'user', { fromBoardId: board.id }).board;
    expect(again.inputs.filter((i) => i.path === pic)).toHaveLength(1);
    ws.close();
  });

  it('hands them to Codex with a review comment and with an answer', () => {
    const { ws, projectId, shotId } = fixture();
    const { path: pic } = saveAttachment(ws, projectId, new Uint8Array([1, 2, 3]), 'image/png');
    const { board } = queueBoard(ws, shotId, 'user', { role: 'key' });
    run(ws.db, `UPDATE boards SET status = 'ready', path = 'projects/op/board.png' WHERE id = :id`, {
      id: board.id,
    });
    submitReview(ws, {
      targetId: board.id,
      verdict: 'changes',
      comment: 'Hair like this',
      attachments: [pic],
      actor: 'user',
    });
    const task = listAgentTasks(ws.db, { shotId })[0]!;
    expect((task.payload as { annotations: unknown[] }).annotations).toEqual([{ type: 'image', path: pic }]);
    run(ws.db, `UPDATE agent_tasks SET status = 'needs_user' WHERE id = :id`, { id: task.id });
    answerAgentTask(ws.db, task.id, 'This one', 'user', Date.now(), [pic]);
    expect(getAgentTask(ws.db, task.id).payload).toMatchObject({
      answerImages: [pic],
      comment: 'Hair like this',
    });
    ws.close();
  });
});
