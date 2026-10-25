import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  applyHandoff,
  askUser,
  createAgentTask,
  createCastMember,
  createClip,
  createHandoff,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  designNote,
  getAgentTask,
  getBoard,
  getHandoff,
  handoffKickoff,
  handoffPrompt,
  initWorkspace,
  listJobs,
  mapCast,
  projectSummaries,
  queueBoard,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  submitHandoff,
  updateSource,
  type Workspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

function fixture(): { ws: Workspace; projectId: string; shotIds: string[]; personaId: string } {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(
    ws.db,
    src.id,
    {
      status: 'ready',
      fpsNum: 24,
      fpsDen: 1,
      durationMs: 2_000,
      width: 1920,
      height: 1080,
      filePath: 'sources/x/source.mp4',
    },
    'daemon',
  );
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
  const frame = 'projects/op/kf.jpg';
  mkdirSync(path.dirname(ws.abs(frame)), { recursive: true });
  writeFileSync(ws.abs(frame), 'frame');
  for (const s of shots) setKeyframes(ws.db, s.id, [{ frame: s.startFrame + 12, role: 'mid', path: frame }]);
  const ref = path.join(tempDir(), 'ref.png');
  writeFileSync(ref, 'ref');
  const persona = createPersona(ws, { name: 'DeepSeek' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const girl = createCastMember(ws.db, { projectId: project.id, label: 'white hair' }, 'daemon');
  for (const s of shots) createTracklet(ws.db, { shotId: s.id, castMemberId: girl.id });
  mapCast(ws.db, girl.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  return { ws, projectId: project.id, shotIds: shots.map((s) => s.id), personaId: persona.id };
}

describe('Codex discussions', () => {
  it('exports a brief with the question, the shot, its images and the result format', () => {
    const { ws, projectId, shotIds } = fixture();
    const h = createHandoff(ws, {
      projectRef: projectId,
      targetType: 'shot',
      targetId: shotIds[1]!,
      topic: '這個分鏡一直被擋，要怎麼改？',
      actor: 'user',
    });
    expect(h).toMatchObject({ status: 'open', targetLabel: '分鏡 #2', dir: `projects/op/codex/${h.id}` });
    const brief = readFileSync(ws.abs(`${h.dir}/BRIEF.md`), 'utf8');
    expect(brief).toContain('> 這個分鏡一直被擋，要怎麼改？');
    expect(brief).toContain('「white hair」→ 換成 DeepSeek');
    expect(brief).toContain(`anirecast codex submit ${h.id}`);
    expect(existsSync(ws.abs(`${h.dir}/context.json`))).toBe(true);
    const kickoff = handoffKickoff(ws, h);
    expect(kickoff.images).toContain(ws.abs('projects/op/kf.jpg'));
    expect(kickoff.threadName).toBe('AniRecast · OP · 討論 · 分鏡 #2');
    expect(handoffPrompt(ws, h)).toContain(path.join(ws.abs(h.dir), 'BRIEF.md'));
    ws.close();
  });

  it('rejects a result with unknown actions or ids, listing every problem', () => {
    const { ws, projectId } = fixture();
    const h = createHandoff(ws, {
      projectRef: projectId,
      targetType: 'project',
      topic: '整體方向',
      actor: 'user',
    });
    const bad = () =>
      submitHandoff(
        ws,
        h.id,
        {
          summary: 'x',
          actions: [
            { type: 'board.generate', shot: 'sht_nope' },
            { type: 'paint.wall' },
            { type: 'design.note', persona: 'nobody', note: 'n' },
          ],
        },
        'codex:thr_1',
      );
    expect(bad).toThrow(/3 problem/);
    expect(bad).toThrow(/sht_nope/);
    expect(getHandoff(ws.db, h.id).status).toBe('open');
    ws.close();
  });

  it('imports only what the human ticks, never twice, and never by Codex', () => {
    const { ws, projectId, shotIds, personaId } = fixture();
    const { board } = queueBoard(ws, shotIds[0]!, 'codex:thr_1');
    run(ws.db, `UPDATE boards SET status = 'ready', path = 'projects/op/b.png' WHERE id = :id`, {
      id: board.id,
    });
    const h = createHandoff(ws, {
      projectRef: projectId,
      targetType: 'persona',
      targetId: personaId,
      topic: '設計',
      actor: 'user',
    });
    const submitted = submitHandoff(
      ws,
      h.id,
      {
        summary: '肩膀遮住，再重畫一張分鏡圖',
        actions: [
          { type: 'design.note', persona: 'deepseek', note: 'covered shoulders', why: '過濾' },
          { type: 'board.generate', shot: shotIds[1], extra: 'Keep everything else the same.' },
          { type: 'approve', target: board.id },
        ],
        versions: [{ id: board.id, note: '討論中試做' }],
      },
      'codex:thr_1',
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.result?.items.map((i) => [i.label, i.paid])).toEqual([
      ['DeepSeek 的改編說明改成：covered shoulders', false],
      ['生成 分鏡 #2 的分鏡圖：Keep everything else the same.', true],
      ['通過 分鏡 #1 分鏡圖 v1', false],
    ]);
    expect(projectSummaries(ws)[0]?.discussions).toBe(1);
    expect(() => applyHandoff(ws, h.id, { actor: 'codex:thr_1' })).toThrow(/human/);

    const boardsBefore = listJobs(ws.db).filter((j) => j.type === 'board.generate').length;
    const once = applyHandoff(ws, h.id, { indices: [0, 1], actor: 'user' });
    expect(once.applied.map((a) => [a.index, a.ok])).toEqual([
      [0, true],
      [1, true],
    ]);
    expect(designNote(ws.db, projectId, personaId)).toBe('covered shoulders');
    expect(getBoard(ws.db, board.id).status).toBe('ready');
    const again = applyHandoff(ws, h.id, { actor: 'user' });
    expect(again.applied.map((a) => a.index)).toEqual([0, 1, 2]);
    expect(listJobs(ws.db).filter((j) => j.type === 'board.generate')).toHaveLength(boardsBefore + 1);
    expect(getBoard(ws.db, board.id).status).toBe('approved');
    expect(again.status).toBe('imported');
    ws.close();
  });

  it('answers the task a discussion came from', () => {
    const { ws, projectId, shotIds } = fixture();
    const task = createAgentTask(ws.db, {
      kind: 'review_feedback',
      projectId,
      shotId: shotIds[0]!,
      payload: { comment: '手不對' },
      createdBy: 'user',
    });
    askUser(ws.db, task.id, '要改手勢還是換角度？', 'codex:thr_1');
    const h = createHandoff(ws, {
      projectRef: projectId,
      targetType: 'task',
      targetId: task.id,
      topic: '一起想',
      actor: 'user',
    });
    expect(readFileSync(ws.abs(`${h.dir}/BRIEF.md`), 'utf8')).toContain('Codex 之前問：要改手勢還是換角度？');
    submitHandoff(
      ws,
      h.id,
      { summary: '換角度', actions: [{ type: 'task.answer', task: task.id, answer: '換成側面角度' }] },
      'codex:thr_2',
    );
    applyHandoff(ws, h.id, { actor: 'user' });
    expect(getAgentTask(ws.db, task.id)).toMatchObject({ status: 'open', answer: '換成側面角度' });
    ws.close();
  });
});
