import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPersonaImage,
  all,
  assignTracklet,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  enqueueJob,
  getBoard,
  getCastMember,
  getShot,
  initWorkspace,
  listPersonas,
  listShots,
  mapCast,
  markNotCharacter,
  markShotGenerationStale,
  mergeCast,
  mergeShots,
  recomputeShotModes,
  replaceAutoOverlays,
  replacementSignature,
  replaceShots,
  requestCancel,
  run,
  setOverlayRemoval,
  setShotCastOverride,
  shotCast,
  splitCast,
  splitShot,
  updateShot,
  updateSource,
  type Workspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

function fixture(): { ws: Workspace; projectId: string; shotIds: string[] } {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(
    ws.db,
    src.id,
    {
      status: 'ready',
      fpsNum: 24,
      fpsDen: 1,
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      filePath: 'sources/x/source.mp4',
    },
    'daemon',
  );
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 96 }, 'user');
  const shots = replaceShots(
    ws.db,
    clip.id,
    [
      { start: 0, end: 23 },
      { start: 24, end: 47 },
      { start: 48, end: 71 },
      { start: 72, end: 95 },
    ],
    'daemon',
  );
  return { ws, projectId: project.id, shotIds: shots.map((s) => s.id) };
}

describe('shot modes', () => {
  it('replace beats clean beats keep, and user-set modes are left alone', () => {
    const { ws, projectId, shotIds } = fixture();
    const [s0, s1, s2, s3] = shotIds as [string, string, string, string];
    const girl = createCastMember(ws.db, { projectId, label: '黑長髮女生' }, 'daemon');
    createTracklet(ws.db, { shotId: s0, castMemberId: girl.id });
    createTracklet(ws.db, { shotId: s2, castMemberId: girl.id });
    replaceAutoOverlays(ws.db, s1, [
      { bbox: [0.1, 0.8, 0.5, 0.9], text: '作画監督 山田', category: 'staff_credit' },
    ]);
    replaceAutoOverlays(ws.db, s2, [{ bbox: [0.1, 0.8, 0.5, 0.9], text: '原画', category: 'staff_credit' }]);
    replaceAutoOverlays(ws.db, s3, [{ bbox: [0.2, 0.2, 0.4, 0.3], text: 'CAFE', category: 'in_scene' }]);
    updateShot(ws.db, s3, { mode: 'exclude' }, 'user');

    expect(recomputeShotModes(ws.db, projectId)).toEqual([
      { shotId: s1, from: 'keep', to: 'clean' },
      { shotId: s2, from: 'keep', to: 'clean' },
    ]);

    const persona = createPersona(ws, { name: '銀髮人設' }, 'user');
    mapCast(ws.db, girl.id, persona.id, 'user');
    recomputeShotModes(ws.db, projectId);
    expect(listShots(ws.db, getShot(ws.db, s0).clipId).map((s) => s.mode)).toEqual([
      'replace',
      'clean',
      'replace',
      'exclude',
    ]);
    expect(shotCast(ws.db, s0)[0]?.personaId).toBe(persona.id);

    // In-scene text never turns into a removal, even when asked.
    const [scene] = replaceAutoOverlays(ws.db, s3, [
      { bbox: [0.2, 0.2, 0.4, 0.3], text: 'CAFE', category: 'in_scene' },
    ]);
    expect(setOverlayRemoval(ws.db, scene!.id, { remove: true }, 'user').remove).toBe(false);
    ws.close();
  });

  it('marks approved versions stale when the mapping changes', () => {
    const { ws, shotIds } = fixture();
    const shotId = shotIds[0]!;
    run(
      ws.db,
      `INSERT INTO boards (id, shot_id, version, status, prompt, model, created_by, created_at) VALUES ('b1', :shotId, 1, 'approved', 'p', 'm', 'user', 1)`,
      { shotId },
    );
    run(
      ws.db,
      `INSERT INTO takes (id, shot_id, version, tier, status, prompt, model, created_by, created_at) VALUES ('t1', :shotId, 1, 'draft', 'ready', 'p', 'm', 'user', 1)`,
      { shotId },
    );
    expect(markShotGenerationStale(ws.db, shotId, 'mapping changed', 'user')).toBe(2);
    expect(markShotGenerationStale(ws.db, shotId, 'again', 'user')).toBe(0);
    ws.close();
  });

  it('force-splits a generated shot: versions turn stale and appearances follow the cut', () => {
    const { ws, projectId, shotIds } = fixture();
    const shotId = shotIds[0]!;
    const girl = createCastMember(ws.db, { projectId, label: 'girl' }, 'daemon');
    const early = createTracklet(ws.db, { shotId, castMemberId: girl.id });
    const late = createTracklet(ws.db, { shotId, castMemberId: girl.id });
    const across = createTracklet(ws.db, { shotId, castMemberId: girl.id });
    for (const [id, frame] of [
      [early.id, 4],
      [late.id, 18],
      [across.id, 6],
      [across.id, 20],
    ] as const)
      run(ws.db, `INSERT INTO detections (id, tracklet_id, frame) VALUES (:d, :id, :frame)`, {
        d: `det_${id}_${frame}`,
        id,
        frame,
      });
    mapCast(ws.db, girl.id, createPersona(ws, { name: 'P' }, 'user').id, 'user');
    recomputeShotModes(ws.db, projectId);
    run(
      ws.db,
      `INSERT INTO boards (id, shot_id, version, status, prompt, model, created_by, created_at) VALUES ('b1', :shotId, 1, 'approved', 'p', 'm', 'user', 1)`,
      { shotId },
    );
    expect(() => splitShot(ws.db, shotId, 12, 'user')).toThrow(/already has generated versions/);
    const [a, b] = splitShot(ws.db, shotId, 12, 'user', Date.now(), { force: true });
    expect(getBoard(ws.db, 'b1').status).toBe('stale');
    expect(
      shotCast(ws.db, a.id)
        .map((e) => e.tracklet.id)
        .sort(),
    ).toEqual([early.id, across.id].sort());
    const second = shotCast(ws.db, b.id);
    expect(second).toHaveLength(2);
    expect(second.every((e) => e.cast?.id === girl.id)).toBe(true);
    const frames = (id: string) =>
      all<{ frame: number }>(ws.db, 'SELECT frame FROM detections WHERE tracklet_id = :id', { id }).map(
        (d) => d.frame,
      );
    expect(frames(across.id)).toEqual([6]);
    expect(second.flatMap((e) => frames(e.tracklet.id)).sort((x, y) => x - y)).toEqual([18, 20]);
    recomputeShotModes(ws.db, projectId);
    expect(getShot(ws.db, b.id).mode).toBe('replace');
    ws.close();
  });

  it('keeps characters, items and scenes apart in the library; only characters replace a character', () => {
    const { ws, projectId } = fixture();
    const hero = createPersona(ws, { name: 'Hero' }, 'user');
    const sword = createPersona(ws, { name: 'Sword', kind: 'item' }, 'user');
    createPersona(ws, { name: 'Cafe', kind: 'scene' }, 'user');
    expect(hero.kind).toBe('character');
    expect(listPersonas(ws.db, { kind: 'item' }).map((p) => p.name)).toEqual(['Sword']);
    expect(
      listPersonas(ws.db)
        .map((p) => p.kind)
        .sort(),
    ).toEqual(['character', 'item', 'scene']);
    const girl = createCastMember(ws.db, { projectId, label: 'girl' }, 'daemon');
    expect(() => mapCast(ws.db, girl.id, sword.id, 'user')).toThrow(/Only a character/);
    expect(mapCast(ws.db, girl.id, hero.id, 'user').cast.personaId).toBe(hero.id);
    ws.close();
  });

  it('replaces several characters in one shot, each its own way', () => {
    const { ws, projectId, shotIds } = fixture();
    const shot = shotIds[0]!;
    const [a, b] = [createPersona(ws, { name: 'A' }, 'user'), createPersona(ws, { name: 'B' }, 'user')];
    const sword = createPersona(ws, { name: 'Sword', kind: 'item' }, 'user');
    const chisato = createCastMember(ws.db, { projectId, label: '千束' }, 'daemon');
    const takina = createCastMember(ws.db, { projectId, label: '瀧奈' }, 'daemon');
    mapCast(ws.db, chisato.id, a.id, 'user');
    mapCast(ws.db, takina.id, a.id, 'user');
    // Someone the cast step dismissed is assigned again from the shot.
    const door = createTracklet(ws.db, { shotId: shot, castMemberId: null });
    markNotCharacter(ws.db, door.id, 'codex');
    assignTracklet(ws.db, door.id, chisato.id, 'user');
    createTracklet(ws.db, { shotId: shot, castMemberId: takina.id });
    // 千束 follows the project's mapping; 瀧奈 becomes B in this shot only.
    setShotCastOverride(ws.db, shot, takina.id, { personaId: b.slug, keep: false }, 'user');
    expect(
      shotCast(ws.db, shot).map((e) => [e.cast?.label, e.personaId, e.override?.personaId ?? null]),
    ).toEqual([
      ['千束', a.id, null],
      ['瀧奈', b.id, b.id],
    ]);
    expect(shotCast(ws.db, shotIds[1]!)).toEqual([]);
    // Keep the original here; only characters can stand in.
    setShotCastOverride(ws.db, shot, chisato.id, { personaId: null, keep: true }, 'user');
    expect(shotCast(ws.db, shot)[0]).toMatchObject({ personaId: null, override: { keep: true } });
    expect(() =>
      setShotCastOverride(ws.db, shot, chisato.id, { personaId: sword.id, keep: false }, 'user'),
    ).toThrow(/Only a character/);
    setShotCastOverride(ws.db, shot, chisato.id, null, 'user');
    expect(shotCast(ws.db, shot)[0]).toMatchObject({ personaId: a.id, override: null });
    ws.close();
  });

  it('merges two shots without losing what was attached to the second', () => {
    const { ws, projectId, shotIds } = fixture();
    const [s0, s1] = shotIds as [string, string];
    const girl = createCastMember(ws.db, { projectId, label: 'girl' }, 'daemon');
    const t = createTracklet(ws.db, { shotId: s1, castMemberId: girl.id });
    replaceAutoOverlays(ws.db, s1, [{ bbox: [0.1, 0.8, 0.5, 0.9], text: '原画', category: 'staff_credit' }]);
    run(
      ws.db,
      `INSERT INTO boards (id, shot_id, version, status, prompt, model, created_by, created_at)
       VALUES ('b0', :s0, 1, 'approved', 'p', 'm', 'user', 1), ('b1', :s1, 1, 'ready', 'p', 'm', 'user', 2)`,
      { s0, s1 },
    );
    expect(() => mergeShots(ws.db, s0, s1, 'user')).toThrow(/already have generated versions/);
    const merged = mergeShots(ws.db, s0, s1, 'user', Date.now(), { force: true, reason: 'same moment' });
    expect(merged).toMatchObject({ id: s0, startFrame: 0, endFrame: 47 });
    expect(shotCast(ws.db, s0).map((e) => e.tracklet.id)).toEqual([t.id]);
    expect(all(ws.db, 'SELECT shot_id FROM text_overlays')).toEqual([{ shot_id: s0 }]);
    expect(getBoard(ws.db, 'b0')).toMatchObject({ status: 'stale', version: 1 });
    expect(getBoard(ws.db, 'b1')).toMatchObject({ shotId: s0, status: 'stale', version: 2 });
    ws.close();
  });

  it('closes the board of a generation job cancelled before it ran', () => {
    const { ws, shotIds } = fixture();
    run(
      ws.db,
      `INSERT INTO boards (id, shot_id, version, status, prompt, model, created_by, created_at) VALUES ('b1', :shotId, 1, 'queued', 'p', 'm', 'user', 1)`,
      { shotId: shotIds[0]! },
    );
    const job = enqueueJob(ws.db, {
      type: 'board.generate',
      lane: 'generate',
      payload: { boardId: 'b1' },
      requestedBy: 'user',
    });
    requestCancel(ws.db, job.id, 'user');
    expect(getBoard(ws.db, 'b1')).toMatchObject({ status: 'failed', error: 'Cancelled' });
    ws.close();
  });
});

describe('replacement signature', () => {
  it('keeps versions whose signature still matches and stales them when the mapping changes', () => {
    const { ws, projectId, shotIds } = fixture();
    const shotId = shotIds[0]!;
    const hero = createCastMember(ws.db, { projectId, label: 'hero' }, 'daemon');
    const extra = createCastMember(ws.db, { projectId, label: 'extra' }, 'daemon');
    createTracklet(ws.db, { shotId, castMemberId: hero.id });
    const bystander = createTracklet(ws.db, { shotId, castMemberId: extra.id });
    const persona = createPersona(ws, { name: 'P' }, 'user');
    mapCast(ws.db, hero.id, persona.id, 'user');
    const sig = replacementSignature(ws.db, shotId);
    run(
      ws.db,
      `INSERT INTO boards (id, shot_id, version, status, prompt, model, params_json, created_by, created_at) VALUES ('b1', :shotId, 1, 'approved', 'p', 'm', :params, 'user', 1)`,
      { shotId, params: JSON.stringify({ signature: sig }) },
    );
    // Dismissing the unmapped bystander does not touch what was generated.
    markNotCharacter(ws.db, bystander.id, 'codex:t');
    expect(markShotGenerationStale(ws.db, shotId, 'extra dismissed', 'codex:t')).toBe(0);
    // Unmapping the hero does.
    mapCast(ws.db, hero.id, null, 'user');
    expect(markShotGenerationStale(ws.db, shotId, 'mapping changed', 'user')).toBe(1);
    ws.close();
  });
});

describe('same-person decisions', () => {
  it('locks user assignments against Codex and supports merge/split', () => {
    const { ws, projectId, shotIds } = fixture();
    const a = createCastMember(ws.db, { projectId, label: 'A 制服' }, 'daemon');
    const b = createCastMember(ws.db, { projectId, label: 'A 便服' }, 'daemon');
    const t1 = createTracklet(ws.db, { shotId: shotIds[0]!, castMemberId: a.id });
    const t2 = createTracklet(ws.db, { shotId: shotIds[1]!, castMemberId: b.id });
    const t3 = createTracklet(ws.db, { shotId: shotIds[2]!, castMemberId: b.id });

    // Codex merges the two outfits of the same girl.
    const merged = mergeCast(ws.db, a.id, b.id, 'codex:thread-1', {
      reason: 'same face, different outfit',
      confidence: 0.82,
    });
    expect(merged.tracklets.map((t) => t.id).sort()).toEqual([t1.id, t2.id, t3.id].sort());
    expect(getCastMember(ws.db, b.id).status).toBe('merged');

    // The user says shot 2 is actually someone else; that assignment is now locked.
    const other = splitCast(ws.db, a.id, [t3.id], '另一個女生', 'user');
    expect(other.tracklets.map((t) => t.id)).toEqual([t3.id]);
    expect(() => assignTracklet(ws.db, t3.id, a.id, 'codex:thread-1')).toThrow(/locked/);
    expect(() => assignTracklet(ws.db, t3.id, a.id, 'user')).not.toThrow();
    ws.close();
  });

  it('stores persona references in the library with a JSON mirror', () => {
    const { ws } = fixture();
    const img = path.join(ws.root, '..', 'ref.png');
    writeFileSync(
      img,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const p = createPersona(ws, { name: 'Silver Bob', description: '銀色短髮' }, 'user');
    const withImage = addPersonaImage(ws, p.slug, img, { view: 'full' }, 'user');
    expect(withImage.images).toHaveLength(1);
    expect(withImage.images[0]).toMatchObject({ isPrimary: true, view: 'full' });
    expect(withImage.images[0]!.path).toMatch(/^library\/personas\/silver-bob\/refs\/img_[0-9a-z]+\.png$/);
    expect(() => addPersonaImage(ws, p.slug, img, {}, 'user')).toThrow(/already/);
    ws.close();
  });
});
