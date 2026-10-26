import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  approvedBoard,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  initWorkspace,
  listBoards,
  mapCast,
  queueBoard,
  queueBoards,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  shotStage,
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
  for (const f of ['first.jpg', 'mid.jpg', 'last.jpg', 'board.png'])
    writeFileSync(ws.abs(`projects/op/${f}`), f);
  setKeyframes(ws.db, shot!.id, [
    { frame: 0, role: 'first', path: 'projects/op/first.jpg' },
    { frame: 12, role: 'mid', path: 'projects/op/mid.jpg' },
    { frame: 23, role: 'last', path: 'projects/op/last.jpg' },
  ]);
  const ref = path.join(tempDir(), 'ref.png');
  writeFileSync(ref, 'ref');
  const persona = createPersona(ws, { name: 'Claude' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
  const t = createTracklet(ws.db, { shotId: shot!.id, castMemberId: girl.id });
  // She is seen in the first and middle frames and has left by the last one.
  for (const frame of [0, 12])
    run(
      ws.db,
      `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json)
       VALUES (:id, :t, :frame, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]')`,
      { id: `det_${frame}`, t: t.id, frame },
    );
  mapCast(ws.db, girl.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  return { ws, shotId: shot!.id };
}

const finish = (ws: ReturnType<typeof fixture>['ws'], id: string) =>
  run(ws.db, `UPDATE boards SET status = 'ready', path = 'projects/op/board.png' WHERE id = :id`, { id });

describe('three storyboard frames', () => {
  it('draws the first, key and last frames, skipping a moment nobody to replace is seen in', () => {
    const { ws, shotId } = fixture();
    const { boards, skipped } = queueBoards(ws, shotId, 'user');
    expect(boards.map((q) => [q.board.role, q.board.frame])).toEqual([
      ['first', 0],
      ['key', 12],
    ]);
    expect(skipped).toEqual([
      { role: 'last', reason: 'Nobody to replace is seen in the last frame of this shot' },
    ]);
    // Each prompt starts from the frame of its own moment.
    expect(boards.map((q) => q.board.inputs[0]?.path)).toEqual([
      'projects/op/first.jpg',
      'projects/op/mid.jpg',
    ]);
    ws.close();
  });

  it('approves each moment on its own, and the video waits for the key frame', () => {
    const { ws, shotId } = fixture();
    const [first, key] = queueBoards(ws, shotId, 'user').boards.map((q) => q.board);
    for (const b of [first!, key!]) finish(ws, b.id);
    expect(shotStage(ws.db, shotId, 'final')).toBe('board_review');
    submitReview(ws, { targetId: first!.id, verdict: 'approve', actor: 'user' });
    expect(shotStage(ws.db, shotId, 'final')).toBe('board_review');
    submitReview(ws, { targetId: key!.id, verdict: 'approve', actor: 'user' });
    expect(shotStage(ws.db, shotId, 'final')).toBe('take_pending');
    // Regenerating keeps the moment; approving the new key frame leaves the first frame approved.
    const again = queueBoard(ws, shotId, 'user', { fromBoardId: key!.id }).board;
    expect(again.role).toBe('key');
    finish(ws, again.id);
    submitReview(ws, { targetId: again.id, verdict: 'approve', actor: 'user' });
    expect(approvedBoard(ws.db, shotId)?.id).toBe(again.id);
    expect(approvedBoard(ws.db, shotId, 'first')?.id).toBe(first!.id);
    expect(listBoards(ws.db, shotId).filter((b) => b.status === 'approved')).toHaveLength(2);
    ws.close();
  });
});
