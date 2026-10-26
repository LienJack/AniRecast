import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  createAgentTask,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  discardShotVersions,
  getAgentTask,
  initWorkspace,
  listBoards,
  listReviews,
  mapCast,
  queueBoard,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  splitShot,
  submitReview,
  updateSource,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe("deleting a shot's versions", () => {
  it('moves them to the trash so the shot can be split, and only a person may do it', () => {
    const ws = initWorkspace(path.join(tempDir(), 'ws'));
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
    const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
    mkdirSync(ws.abs('projects/op/shots'), { recursive: true });
    writeFileSync(ws.abs('projects/op/kf.jpg'), 'kf');
    setKeyframes(ws.db, shot!.id, [{ frame: 12, role: 'mid', path: 'projects/op/kf.jpg' }]);
    const ref = path.join(tempDir(), 'ref.png');
    writeFileSync(ref, 'ref');
    const persona = createPersona(ws, { name: 'Claude' }, 'user');
    addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
    const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
    createTracklet(ws.db, { shotId: shot!.id, castMemberId: girl.id });
    mapCast(ws.db, girl.id, persona.id, 'user');
    recomputeShotModes(ws.db, project.id);
    const { board } = queueBoard(ws, shot!.id, 'user');
    writeFileSync(ws.abs('projects/op/shots/board-v001.png'), 'board');
    writeFileSync(ws.abs('projects/op/shots/board-v001.json'), '{}');
    run(
      ws.db,
      `UPDATE boards SET status = 'ready', path = 'projects/op/shots/board-v001.png' WHERE id = :id`,
      {
        id: board.id,
      },
    );
    const review = submitReview(ws, {
      targetId: board.id,
      verdict: 'changes',
      comment: 'hair',
      actor: 'user',
    }) as { task?: { id: string } };

    expect(() => splitShot(ws.db, shot!.id, 12, 'user')).toThrow(/already has generated versions/);
    expect(() => discardShotVersions(ws, shot!.id, 'codex:thr_1')).toThrow(/human/);

    const done = discardShotVersions(ws, shot!.id, 'user', 1_700_000_000_000);
    expect(done).toMatchObject({ boards: 1, takes: 0, trash: `trash/versions/op/${shot!.id}-1700000000000` });
    expect(listBoards(ws.db, shot!.id)).toEqual([]);
    expect(listReviews(ws.db, board.id)).toEqual([]);
    expect(getAgentTask(ws.db, review.task!.id).status).toBe('cancelled');
    expect(existsSync(ws.abs('projects/op/shots/board-v001.png'))).toBe(false);
    expect(existsSync(ws.abs(`${done.trash}/projects/op/shots/board-v001.png`))).toBe(true);
    const saved = JSON.parse(readFileSync(ws.abs(`${done.trash}/versions.json`), 'utf8'));
    expect(saved.boards[0].id).toBe(board.id);
    // Now the shot splits without --force.
    expect(splitShot(ws.db, shot!.id, 12, 'user')).toHaveLength(2);
    ws.close();
  });

  it('refuses while a version is still being generated', () => {
    const ws = initWorkspace(path.join(tempDir(), 'ws'));
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
    const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
    run(
      ws.db,
      `INSERT INTO boards (id, shot_id, version, status, prompt, model, created_by, created_at)
       VALUES ('brd_x', :shotId, 1, 'generating', 'p', 'm', 'user', 1)`,
      { shotId: shot!.id },
    );
    createAgentTask(ws.db, {
      kind: 'review_feedback',
      projectId: project.id,
      payload: {},
      createdBy: 'user',
    });
    expect(() => discardShotVersions(ws, shot!.id, 'user')).toThrow(/still being generated/);
    ws.close();
  });
});
