import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  addReference,
  castAppearances,
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
  normalizeAnalysis,
  planBoard,
  projectSummaries,
  queueDesign,
  queueOriginalDesign,
  recomputeShotModes,
  replacementSignature,
  replaceShots,
  run,
  saveCastAnalysis,
  setAnalysisPicks,
  setDesignNote,
  setKeyframes,
  submitReview,
  updateDesign,
  updateReference,
  updateSource,
  type Workspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

function fixture(): { ws: Workspace; projectId: string; shotId: string; personaId: string; castId: string } {
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
  mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
  writeFileSync(ws.abs(frame), 'frame');
  setKeyframes(ws.db, shot!.id, [{ frame: 12, role: 'mid', path: frame }]);
  const ref = path.join(tempDir(), 'ref.png');
  writeFileSync(ref, 'ref');
  const persona = createPersona(ws, { name: 'Claude' }, 'user');
  addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
  const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
  const tracklet = createTracklet(ws.db, { shotId: shot!.id, castMemberId: girl.id });
  // Two appearances of the original with head and body crops, as identification leaves them.
  for (const [i, frame] of [4, 16].entries()) {
    for (const part of ['head', 'body']) {
      const rel = `projects/op/crops/t${i}_${part}.jpg`;
      writeFileSync(ws.abs(rel), `${part} ${i}`);
    }
    run(
      ws.db,
      `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json, head_crop_path, body_crop_path)
       VALUES (:id, :t, :frame, :head, :body, :hp, :bp)`,
      {
        id: `det_${i}`,
        t: tracklet.id,
        frame,
        head: JSON.stringify([0.4, 0.1, 0.5 + i * 0.05, 0.3]),
        body: JSON.stringify([0.3, 0.1, 0.6 + i * 0.05, 0.9]),
        hp: `projects/op/crops/t${i}_head.jpg`,
        bp: `projects/op/crops/t${i}_body.jpg`,
      },
    );
  }
  mapCast(ws.db, girl.id, persona.id, 'user');
  recomputeShotModes(ws.db, project.id);
  return { ws, projectId: project.id, shotId: shot!.id, personaId: persona.id, castId: girl.id };
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
    // The turnaround sees the original's largest body crop and a frame of the shot she is in.
    expect(turnaround!.design.inputs.map((i) => i.role)).toEqual([
      `persona:${personaId}`,
      expect.stringMatching(/^original:/),
      'style',
    ]);
    expect(turnaround!.design.prompt).toContain('draw her the way this opening draws girl');
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

  it('draws the expressions and poses the original has, from the analysis, as one reference grid', () => {
    const { ws, projectId, personaId, castId } = fixture();
    const appearances = castAppearances(ws, castId);
    expect(appearances.map((a) => a.head)).toEqual(['projects/op/crops/t1_head.jpg']);
    saveCastAnalysis(
      ws.db,
      castId,
      normalizeAnalysis(
        {
          style: 'thin dark lines, two-tone cel shading',
          body: 'about 7 heads tall',
          outfit: 'navy school uniform',
          expressions: [
            { label: 'determined glare', description: 'narrowed eyes', appearance: 1 },
            { label: 'soft smile', appearance: 1 },
            { label: 'made up', appearance: 9 },
          ],
          poses: [{ label: 'running, gun drawn', appearance: 1 }],
        },
        appearances,
      ),
      { model: 'm', costUsd: 0.01, actor: 'daemon' },
    );
    setAnalysisPicks(ws.db, castId, { expressions: [0, 1] }, 'user');
    const [expressions] = queueDesign(ws, projectId, castId, 'user', { kind: 'expressions' });
    expect(expressions!.design.inputs.map((i) => i.role)).toEqual([
      `persona:${personaId}`,
      'tile:1',
      'tile:2',
    ]);
    expect(expressions!.design.params).toMatchObject({ castMemberId: castId, tile: { columns: 2 } });
    expect(expressions!.design.prompt).toContain(
      'Image 2 is a grid of the original character "girl"\'s expressions',
    );
    expect(expressions!.design.prompt).toContain('1. determined glare (narrowed eyes); 2. soft smile');
    expect(expressions!.design.prompt).toContain('exactly 2 head-and-shoulders portraits');
    expect(expressions!.design.prompt).toContain('How this opening draws girl: thin dark lines');
    setAnalysisPicks(ws.db, castId, { expressions: [] }, 'user');
    const [generic] = queueDesign(ws, projectId, castId, 'user', { kind: 'expressions' });
    expect(generic!.design.prompt).toContain('nine head-and-shoulders portraits');
    ws.close();
  });

  it('keeps two originals bound to the same library character apart', () => {
    const { ws, projectId, shotId, personaId, castId } = fixture();
    const other = createCastMember(ws.db, { projectId, label: 'friend' }, 'daemon');
    createTracklet(ws.db, { shotId, castMemberId: other.id });
    mapCast(ws.db, other.id, personaId, 'user');
    const all = queueDesign(ws, projectId, personaId, 'user', { kind: 'turnaround' });
    expect(all.map((q) => q.design.castMemberId).sort()).toEqual([castId, other.id].sort());
    const mine = all.find((q) => q.design.castMemberId === castId)!;
    finish(ws, mine.design.id);
    submitReview(ws, { targetId: mine.design.id, verdict: 'approve', actor: 'user' });
    const overview = designOverview(ws.db, projectId);
    expect(overview.bindings.map((b) => [b.cast.label, Boolean(b.sheets[0]?.approved)])).toEqual([
      ['girl', true],
      ['friend', false],
    ]);
    expect(projectSummaries(ws)[0]).toMatchObject({ step: 'design', designed: 1, toDesign: 2 });
    ws.close();
  });

  it('draws the original from accepted official art, then her replacement on that sheet', () => {
    const { ws, projectId, castId } = fixture();
    const art = path.join(tempDir(), 'official.png');
    writeFileSync(art, 'official art');
    const ref = addReference(
      ws,
      castId,
      art,
      { sourceUrl: 'https://example.com/a.png', pageUrl: 'https://example.com/chara', label: 'turnaround' },
      'daemon',
    );
    expect(() => addReference(ws, castId, art, {}, 'user')).toThrow(/already a reference/);
    // A candidate is not used until a person accepts it.
    const [first] = queueOriginalDesign(ws, projectId, castId, 'user', { kind: 'turnaround' });
    expect(first!.design.inputs.some((i) => i.role.startsWith('official:'))).toBe(false);
    updateReference(ws.db, ref.id, { status: 'accepted' }, 'user');
    const [orig] = queueOriginalDesign(ws, projectId, castId, 'user', { kind: 'turnaround' });
    expect(orig!.design).toMatchObject({ subject: 'original', personaId: null, version: 2 });
    expect(orig!.design.inputs[0]?.role).toBe(`official:${ref.id}`);
    expect(orig!.design.prompt).toContain('official character design art of "girl"');
    finish(ws, orig!.design.id);
    submitReview(ws, { targetId: orig!.design.id, verdict: 'approve', actor: 'user' });
    // The replacement turnaround is the original's sheet redrawn with the library character.
    const [rep] = queueDesign(ws, projectId, castId, 'user', { kind: 'turnaround' });
    expect(rep!.design.inputs.map((i) => i.role.split(':')[0])).toEqual(['persona', 'template']);
    expect(rep!.design.prompt).toContain('Redraw Image 2 with Claude in place of girl');
    const binding = designOverview(ws.db, projectId).bindings[0]!;
    expect(binding.original.sheets[0]?.approved?.id).toBe(orig!.design.id);
    expect(binding.original.references.map((r) => r.status)).toEqual(['accepted']);
    expect(binding.sheets[0]?.versions.map((v) => v.id)).toEqual([rep!.design.id]);
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
    expect(() =>
      submitReview(ws, { targetId: turnaround!.design.id, verdict: 'approve', actor: 'claude' }),
    ).toThrow(/human decision/);
    submitReview(ws, { targetId: turnaround!.design.id, verdict: 'approve', actor: 'user' });
    submitReview(ws, { targetId: expressions!.design.id, verdict: 'approve', actor: 'user' });
    const roles = planBoard(ws, shotId).inputs.map((i) => i.path);
    expect(roles).toContain(getDesign(ws.db, turnaround!.design.id).path);
    expect(replacementSignature(ws.db, shotId)).not.toBe(before);
    const overview = designOverview(ws.db, projectId);
    expect(overview.bindings[0]?.sheets[0]?.approved?.id).toBe(turnaround!.design.id);
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
