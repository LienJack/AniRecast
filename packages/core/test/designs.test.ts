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
  designOverview,
  getDesign,
  getPersona,
  initWorkspace,
  listAgentTasks,
  listJobs,
  mapCast,
  planBoard,
  projectSummaries,
  queueDesign,
  recomputeShotModes,
  replacementSignature,
  replaceShots,
  setDesignNote,
  setKeyframes,
  submitReview,
  updateDesign,
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
  const persona = createPersona(ws, { name: 'Claude' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
  createTracklet(ws.db, { shotId: shot!.id, castMemberId: girl.id });
  mapCast(ws.db, girl.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  return { ws, projectId: project.id, shotId: shot!.id, personaId: persona.id };
}

/** What the design handler does once the model answers. */
function finish(ws: Workspace, designId: string): void {
  const d = getDesign(ws.db, designId);
  const rel = `projects/op/designs/claude/${d.kind}-v${String(d.version).padStart(3, '0')}.png`;
  mkdirSync(path.dirname(ws.abs(rel)), { recursive: true });
  writeFileSync(ws.abs(rel), `${d.kind} ${d.version}`);
  updateDesign(ws.db, designId, { status: 'ready', path: rel }, 'daemon');
}

describe('character design', () => {
  it('queues three sheets per character with the style frame and the project note', () => {
    const { ws, projectId, personaId } = fixture();
    setDesignNote(ws.db, projectId, personaId, 'covered shoulders, looser cut', 'user');
    const queued = queueDesign(ws, projectId, personaId, 'user');
    expect(queued.map((q) => q.design.kind)).toEqual(['turnaround', 'expressions', 'poses']);
    expect(listJobs(ws.db).filter((j) => j.type === 'design.generate')).toHaveLength(3);
    const [turnaround] = queued;
    expect(turnaround!.design.prompt).toContain('Adaptation for this project: covered shoulders, looser cut');
    expect(turnaround!.design.inputs.map((i) => i.role)).toEqual([`persona:${personaId}`, 'style']);
    ws.close();
  });

  it('takes any number of library images and picks references by their captions', () => {
    const { ws, projectId, personaId } = fixture();
    const pages = [
      'P01 主設定三視圖',
      'P02 頭部角度',
      'P03 表情範圍',
      'P05 手與鞋',
      'P08 表演動作',
      'P09 配色與光影',
    ];
    for (const label of pages) {
      const file = path.join(tempDir(), `${label}.png`);
      writeFileSync(file, label);
      addPersonaImage(ws, personaId, file, { label }, 'user');
    }
    const [turnaround, expressions, poses] = queueDesign(ws, projectId, personaId, 'user');
    const labelOf = (p: string) => getPersona(ws.db, personaId).images.find((i) => i.path === p)?.label;
    const refs = (d: typeof turnaround) =>
      d!.design.inputs.filter((i) => i.role.startsWith('persona:')).map((i) => labelOf(i.path));
    expect(getPersona(ws.db, personaId).images).toHaveLength(7);
    expect(refs(turnaround)).toEqual(['', 'P01 主設定三視圖']);
    expect(refs(expressions)).toEqual(['P02 頭部角度', 'P03 表情範圍']);
    expect(refs(poses)).toEqual(['', 'P08 表演動作']);
    ws.close();
  });

  it('keeps earlier instructions when a sheet is revised', () => {
    const { ws, projectId, personaId } = fixture();
    const [v1] = queueDesign(ws, projectId, personaId, 'user', { kind: 'turnaround', extra: 'longer skirt' });
    finish(ws, v1!.design.id);
    const [v2] = queueDesign(ws, projectId, personaId, 'user', {
      fromDesignId: v1!.design.id,
      extra: 'lighter hair',
    });
    expect(v2!.design.version).toBe(2);
    expect(v2!.design.parentId).toBe(v1!.design.id);
    expect(v2!.design.prompt).toContain('Additional instructions: longer skirt');
    expect(v2!.design.prompt).toContain('Additional instructions: lighter hair');
    ws.close();
  });

  it('only a person approves; approval switches boards to the design and changes the signature', () => {
    const { ws, projectId, shotId, personaId } = fixture();
    const before = replacementSignature(ws.db, shotId);
    const [turnaround, expressions] = queueDesign(ws, projectId, personaId, 'user');
    finish(ws, turnaround!.design.id);
    finish(ws, expressions!.design.id);
    expect(() =>
      submitReview(ws, { targetId: turnaround!.design.id, verdict: 'approve', actor: 'codex:thr_1' }),
    ).toThrow(/human decision/);
    submitReview(ws, { targetId: turnaround!.design.id, verdict: 'approve', actor: 'user' });
    submitReview(ws, { targetId: expressions!.design.id, verdict: 'approve', actor: 'user' });
    const roles = planBoard(ws, shotId).inputs.map((i) => i.path);
    expect(roles).toContain(getDesign(ws.db, turnaround!.design.id).path);
    expect(replacementSignature(ws.db, shotId)).not.toBe(before);
    const overview = designOverview(ws.db, projectId);
    expect(overview[0]?.sheets[0]?.approved?.id).toBe(turnaround!.design.id);
    ws.close();
  });

  it('requesting changes hands the sheet to Codex; the flow waits on design until turnarounds pass', () => {
    const { ws, projectId, personaId } = fixture();
    expect(projectSummaries(ws)[0]?.step).toBe('design');
    const [turnaround] = queueDesign(ws, projectId, personaId, 'user', { kind: 'turnaround' });
    finish(ws, turnaround!.design.id);
    const r = submitReview(ws, {
      targetId: turnaround!.design.id,
      verdict: 'changes',
      comment: 'cover the shoulders',
      actor: 'user',
    });
    expect('task' in r && r.task?.payload).toMatchObject({
      targetType: 'design',
      targetId: turnaround!.design.id,
    });
    expect(getDesign(ws.db, turnaround!.design.id).status).toBe('rejected');
    expect(listAgentTasks(ws.db, { status: 'open' })).toHaveLength(1);
    const [v2] = queueDesign(ws, projectId, personaId, 'user', { fromDesignId: turnaround!.design.id });
    finish(ws, v2!.design.id);
    submitReview(ws, { targetId: v2!.design.id, verdict: 'approve', actor: 'user' });
    expect(projectSummaries(ws)[0]?.step).toBe('generate');
    ws.close();
  });
});
