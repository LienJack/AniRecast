import { AniError, newId } from '@anirecast/shared';
import { all, type Db, one, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { getProject } from './projects.ts';

export type LookPolicy = 'persona' | 'follow_source';
export type DecisionSource = 'codex' | 'user';
export type AssignedBy = 'auto' | DecisionSource;

export interface Look {
  id: string;
  castMemberId: string;
  label: string;
  description: string;
  representativeTrackletId: string | null;
  lookPolicy: LookPolicy;
}

export interface Tracklet {
  id: string;
  shotId: string;
  castMemberId: string | null;
  lookId: string | null;
  confidence: number | null;
  assignedBy: AssignedBy;
}

export interface CastMember {
  id: string;
  projectId: string;
  label: string;
  description: string;
  thumbPath: string | null;
  personaId: string | null;
  status: 'active' | 'not_a_character' | 'merged';
  looks: Look[];
  tracklets: Tracklet[];
  shotIds: string[];
}

interface CastRow {
  id: string;
  project_id: string;
  label: string;
  description: string;
  thumb_path: string | null;
  persona_id: string | null;
  status: CastMember['status'];
}

interface TrackletRow {
  id: string;
  shot_id: string;
  cast_member_id: string | null;
  look_id: string | null;
  confidence: number | null;
  assigned_by: AssignedBy;
}

const toTracklet = (r: TrackletRow): Tracklet => ({
  id: r.id,
  shotId: r.shot_id,
  castMemberId: r.cast_member_id,
  lookId: r.look_id,
  confidence: r.confidence,
  assignedBy: r.assigned_by,
});

/** `codex:<thread>` actors are Codex decisions; everyone else is the human user. */
export const sourceOfActor = (actor: string): DecisionSource =>
  actor.startsWith('codex:') ? 'codex' : 'user';

export function listLooks(db: Db, castMemberId: string): Look[] {
  return all<{
    id: string;
    cast_member_id: string;
    label: string;
    description: string;
    representative_tracklet_id: string | null;
    look_policy: LookPolicy;
  }>(db, 'SELECT * FROM looks WHERE cast_member_id = :castMemberId ORDER BY label', { castMemberId }).map(
    (r) => ({
      id: r.id,
      castMemberId: r.cast_member_id,
      label: r.label,
      description: r.description,
      representativeTrackletId: r.representative_tracklet_id,
      lookPolicy: r.look_policy,
    }),
  );
}

function toCast(db: Db, r: CastRow): CastMember {
  const tracklets = all<TrackletRow>(db, 'SELECT * FROM tracklets WHERE cast_member_id = :id', {
    id: r.id,
  }).map(toTracklet);
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    description: r.description,
    thumbPath: r.thumb_path,
    personaId: r.persona_id,
    status: r.status,
    looks: listLooks(db, r.id),
    tracklets,
    shotIds: [...new Set(tracklets.map((t) => t.shotId))],
  };
}

export function getCastMember(db: Db, id: string): CastMember {
  const row = one<CastRow>(db, 'SELECT * FROM cast_members WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Cast member not found: ${id}`);
  return toCast(db, row);
}

export function listCast(db: Db, projectId: string, { includeInactive = false } = {}): CastMember[] {
  return all<CastRow>(
    db,
    `SELECT * FROM cast_members WHERE project_id = :projectId ${includeInactive ? '' : `AND status = 'active'`} ORDER BY created_at`,
    { projectId },
  ).map((r) => toCast(db, r));
}

export function getTracklet(db: Db, id: string): Tracklet {
  const row = one<TrackletRow>(db, 'SELECT * FROM tracklets WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Tracklet not found: ${id}`);
  return toTracklet(row);
}

export function listShotTracklets(db: Db, shotId: string): Tracklet[] {
  return all<TrackletRow>(db, 'SELECT * FROM tracklets WHERE shot_id = :shotId', { shotId }).map(toTracklet);
}

export function createCastMember(
  db: Db,
  input: { projectId: string; label: string; description?: string; thumbPath?: string | null },
  actor: string,
  now: number = Date.now(),
): CastMember {
  return tx(db, () => {
    getProject(db, input.projectId);
    const id = newId('cast', now);
    run(
      db,
      `INSERT INTO cast_members (id, project_id, label, description, thumb_path, created_at, updated_at)
       VALUES (:id, :projectId, :label, :description, :thumb, :now, :now)`,
      {
        id,
        projectId: input.projectId,
        label: input.label,
        description: input.description ?? '',
        thumb: input.thumbPath ?? null,
        now,
      },
    );
    appendEvent(db, {
      actor,
      kind: 'cast.created',
      entityType: 'cast',
      entityId: id,
      projectId: input.projectId,
      payload: { label: input.label },
    });
    return getCastMember(db, id);
  });
}

export function createLook(
  db: Db,
  input: {
    castMemberId: string;
    label: string;
    description?: string;
    representativeTrackletId?: string | null;
    lookPolicy?: LookPolicy;
  },
  now: number = Date.now(),
): Look {
  const id = newId('look', now);
  run(
    db,
    `INSERT INTO looks (id, cast_member_id, label, description, representative_tracklet_id, look_policy)
     VALUES (:id, :castMemberId, :label, :description, :rep, :policy)`,
    {
      id,
      castMemberId: input.castMemberId,
      label: input.label,
      description: input.description ?? '',
      rep: input.representativeTrackletId ?? null,
      policy: input.lookPolicy ?? 'persona',
    },
  );
  const look = listLooks(db, input.castMemberId).find((l) => l.id === id);
  if (!look) throw new AniError('internal', 'Look not created');
  return look;
}

export function createTracklet(
  db: Db,
  input: {
    shotId: string;
    castMemberId?: string | null;
    lookId?: string | null;
    identityVec?: Uint8Array | null;
    appearanceVec?: Uint8Array | null;
    confidence?: number | null;
    assignedBy?: AssignedBy;
  },
  now: number = Date.now(),
): Tracklet {
  const id = newId('trk', now);
  run(
    db,
    `INSERT INTO tracklets (id, shot_id, cast_member_id, look_id, identity_vec, appearance_vec, confidence, assigned_by)
     VALUES (:id, :shotId, :castMemberId, :lookId, :identityVec, :appearanceVec, :confidence, :assignedBy)`,
    {
      id,
      shotId: input.shotId,
      castMemberId: input.castMemberId ?? null,
      lookId: input.lookId ?? null,
      identityVec: input.identityVec ?? null,
      appearanceVec: input.appearanceVec ?? null,
      confidence: input.confidence ?? null,
      assignedBy: input.assignedBy ?? 'auto',
    },
  );
  return getTracklet(db, id);
}

function projectOfCast(db: Db, castId: string): string {
  return getCastMember(db, castId).projectId;
}

function recordDecision(
  db: Db,
  input: {
    projectId: string;
    kind: 'must_link' | 'cannot_link' | 'assign' | 'not_a_character';
    trackletA?: string | null;
    trackletB?: string | null;
    castMemberId?: string | null;
    source: DecisionSource;
    reason?: string | null;
    confidence?: number | null;
  },
  now: number,
): void {
  run(
    db,
    `INSERT INTO cast_decisions (id, project_id, kind, tracklet_a, tracklet_b, cast_member_id, source, locked, reason, confidence, created_at)
     VALUES (:id, :projectId, :kind, :a, :b, :cast, :source, :locked, :reason, :confidence, :now)`,
    {
      id: newId('dec', now),
      projectId: input.projectId,
      kind: input.kind,
      a: input.trackletA ?? null,
      b: input.trackletB ?? null,
      cast: input.castMemberId ?? null,
      source: input.source,
      locked: input.source === 'user' ? 1 : 0,
      reason: input.reason ?? null,
      confidence: input.confidence ?? null,
      now,
    },
  );
}

/** True when the user has locked this tracklet's assignment; Codex and re-clustering must not change it. */
export function isTrackletLocked(db: Db, trackletId: string): boolean {
  return (
    (one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM cast_decisions WHERE locked = 1 AND kind IN ('assign', 'not_a_character') AND tracklet_a = :id`,
      { id: trackletId },
    )?.n ?? 0) > 0
  );
}

export interface DecisionOptions {
  reason?: string;
  confidence?: number;
}

/** Moves one appearance to another cast member. User decisions lock; Codex cannot override a lock. */
export function assignTracklet(
  db: Db,
  trackletId: string,
  castMemberId: string,
  actor: string,
  opts: DecisionOptions = {},
  now: number = Date.now(),
): Tracklet {
  return tx(db, () => {
    const source = sourceOfActor(actor);
    if (source === 'codex' && isTrackletLocked(db, trackletId)) {
      throw new AniError('conflict', 'This appearance was assigned by the user and is locked', {
        hint: 'Leave it as is; only the user can change it.',
      });
    }
    const target = getCastMember(db, castMemberId);
    run(
      db,
      'UPDATE tracklets SET cast_member_id = :castMemberId, look_id = NULL, assigned_by = :source WHERE id = :id',
      { id: trackletId, castMemberId, source },
    );
    recordDecision(
      db,
      {
        projectId: target.projectId,
        kind: 'assign',
        trackletA: trackletId,
        castMemberId,
        source,
        reason: opts.reason ?? null,
        confidence: opts.confidence ?? null,
      },
      now,
    );
    appendEvent(db, {
      actor,
      kind: 'cast.assigned',
      entityType: 'tracklet',
      entityId: trackletId,
      projectId: target.projectId,
      payload: { castMemberId, source, reason: opts.reason ?? null },
    });
    return getTracklet(db, trackletId);
  });
}

export function markNotCharacter(
  db: Db,
  trackletId: string,
  actor: string,
  opts: DecisionOptions = {},
  now: number = Date.now(),
): Tracklet {
  return tx(db, () => {
    const source = sourceOfActor(actor);
    if (source === 'codex' && isTrackletLocked(db, trackletId))
      throw new AniError('conflict', 'This appearance is locked by the user');
    const t = getTracklet(db, trackletId);
    const projectId = t.castMemberId
      ? projectOfCast(db, t.castMemberId)
      : (one<{ project_id: string }>(
          db,
          'SELECT c.project_id FROM shots s JOIN clips c ON c.id = s.clip_id WHERE s.id = :id',
          { id: t.shotId },
        )?.project_id ?? '');
    run(
      db,
      `UPDATE tracklets SET cast_member_id = NULL, look_id = NULL, assigned_by = :source WHERE id = :id`,
      { id: trackletId, source },
    );
    recordDecision(
      db,
      {
        projectId,
        kind: 'not_a_character',
        trackletA: trackletId,
        source,
        reason: opts.reason ?? null,
        confidence: opts.confidence ?? null,
      },
      now,
    );
    appendEvent(db, {
      actor,
      kind: 'cast.not_a_character',
      entityType: 'tracklet',
      entityId: trackletId,
      projectId,
      payload: { source },
    });
    return getTracklet(db, trackletId);
  });
}

/** Folds `dropId` into `keepId`. Locked tracklets of the dropped member stay locked (now under keep). */
export function mergeCast(
  db: Db,
  keepId: string,
  dropId: string,
  actor: string,
  opts: DecisionOptions = {},
  now: number = Date.now(),
): CastMember {
  return tx(db, () => {
    if (keepId === dropId) throw new AniError('usage', 'Cannot merge a cast member into itself');
    const keep = getCastMember(db, keepId);
    const drop = getCastMember(db, dropId);
    if (keep.projectId !== drop.projectId)
      throw new AniError('usage', 'Cast members belong to different projects');
    const source = sourceOfActor(actor);
    for (const t of drop.tracklets) {
      if (source === 'codex' && isTrackletLocked(db, t.id)) {
        throw new AniError('conflict', `Appearance ${t.id} of "${drop.label}" is locked by the user`);
      }
    }
    run(db, 'UPDATE tracklets SET cast_member_id = :keepId WHERE cast_member_id = :dropId', {
      keepId,
      dropId,
    });
    run(db, 'UPDATE looks SET cast_member_id = :keepId WHERE cast_member_id = :dropId', { keepId, dropId });
    run(db, `UPDATE cast_members SET status = 'merged', updated_at = :now WHERE id = :dropId`, {
      dropId,
      now,
    });
    if (!keep.personaId && drop.personaId)
      run(db, 'UPDATE cast_members SET persona_id = :p WHERE id = :keepId', { p: drop.personaId, keepId });
    const [a, b] = [keep.tracklets[0]?.id, drop.tracklets[0]?.id];
    if (a && b)
      recordDecision(
        db,
        {
          projectId: keep.projectId,
          kind: 'must_link',
          trackletA: a,
          trackletB: b,
          source,
          reason: opts.reason ?? null,
          confidence: opts.confidence ?? null,
        },
        now,
      );
    appendEvent(db, {
      actor,
      kind: 'cast.merged',
      entityType: 'cast',
      entityId: keepId,
      projectId: keep.projectId,
      payload: { dropped: dropId, source, reason: opts.reason ?? null },
    });
    return getCastMember(db, keepId);
  });
}

/** Moves the given appearances out into a new cast member (for "these are two different people"). */
export function splitCast(
  db: Db,
  castId: string,
  trackletIds: string[],
  label: string,
  actor: string,
  opts: DecisionOptions = {},
  now: number = Date.now(),
): CastMember {
  return tx(db, () => {
    const from = getCastMember(db, castId);
    const owned = new Set(from.tracklets.map((t) => t.id));
    if (trackletIds.length === 0 || trackletIds.some((id) => !owned.has(id)))
      throw new AniError('usage', 'Every tracklet must belong to the cast member being split');
    if (trackletIds.length === owned.size)
      throw new AniError('usage', 'Leave at least one appearance in the original cast member');
    const created = createCastMember(db, { projectId: from.projectId, label }, actor, now);
    for (const id of trackletIds) assignTracklet(db, id, created.id, actor, opts, now);
    const remaining = from.tracklets.find((t) => !trackletIds.includes(t.id));
    if (remaining)
      recordDecision(
        db,
        {
          projectId: from.projectId,
          kind: 'cannot_link',
          trackletA: remaining.id,
          trackletB: trackletIds[0] ?? null,
          source: sourceOfActor(actor),
          reason: opts.reason ?? null,
        },
        now,
      );
    return getCastMember(db, created.id);
  });
}

export function renameCast(
  db: Db,
  castId: string,
  label: string,
  actor: string,
  now: number = Date.now(),
): CastMember {
  return tx(db, () => {
    const c = getCastMember(db, castId);
    run(db, 'UPDATE cast_members SET label = :label, updated_at = :now WHERE id = :id', {
      id: castId,
      label,
      now,
    });
    appendEvent(db, {
      actor,
      kind: 'cast.renamed',
      entityType: 'cast',
      entityId: castId,
      projectId: c.projectId,
      payload: { label },
    });
    return getCastMember(db, castId);
  });
}

/** Maps a cast member to a persona (or `null` = keep the original). Returns the shots affected. */
export function mapCast(
  db: Db,
  castId: string,
  personaId: string | null,
  actor: string,
  now: number = Date.now(),
): { cast: CastMember; affectedShotIds: string[] } {
  return tx(db, () => {
    const c = getCastMember(db, castId);
    if (personaId) {
      const p = one<{ id: string; archived: number }>(
        db,
        'SELECT id, archived FROM personas WHERE id = :id OR slug = :id COLLATE NOCASE',
        { id: personaId },
      );
      if (!p) throw new AniError('not_found', `Persona not found: ${personaId}`);
      personaId = p.id;
    }
    run(db, 'UPDATE cast_members SET persona_id = :personaId, updated_at = :now WHERE id = :id', {
      id: castId,
      personaId,
      now,
    });
    appendEvent(db, {
      actor,
      kind: 'cast.mapped',
      entityType: 'cast',
      entityId: castId,
      projectId: c.projectId,
      payload: { personaId },
    });
    return { cast: getCastMember(db, castId), affectedShotIds: c.shotIds };
  });
}

export function setLookPolicy(db: Db, lookId: string, policy: LookPolicy, actor: string): Look {
  return tx(db, () => {
    const row = one<{ cast_member_id: string }>(db, 'SELECT cast_member_id FROM looks WHERE id = :lookId', {
      lookId,
    });
    if (!row) throw new AniError('not_found', `Look not found: ${lookId}`);
    run(db, 'UPDATE looks SET look_policy = :policy WHERE id = :lookId', { lookId, policy });
    const projectId = projectOfCast(db, row.cast_member_id);
    appendEvent(db, {
      actor,
      kind: 'cast.look_policy',
      entityType: 'look',
      entityId: lookId,
      projectId,
      payload: { policy },
    });
    const look = listLooks(db, row.cast_member_id).find((l) => l.id === lookId);
    if (!look) throw new AniError('internal', 'Look vanished');
    return look;
  });
}

export function setShotCastOverride(
  db: Db,
  shotId: string,
  castMemberId: string,
  override: { personaId: string | null; keep: boolean } | null,
  actor: string,
): void {
  tx(db, () => {
    if (override === null) {
      run(db, 'DELETE FROM shot_cast_overrides WHERE shot_id = :shotId AND cast_member_id = :castMemberId', {
        shotId,
        castMemberId,
      });
    } else {
      run(
        db,
        `INSERT INTO shot_cast_overrides (shot_id, cast_member_id, persona_id, keep) VALUES (:shotId, :castMemberId, :personaId, :keep)
         ON CONFLICT (shot_id, cast_member_id) DO UPDATE SET persona_id = :personaId, keep = :keep`,
        { shotId, castMemberId, personaId: override.personaId, keep: override.keep ? 1 : 0 },
      );
    }
    appendEvent(db, {
      actor,
      kind: 'shot.cast_override',
      entityType: 'shot',
      entityId: shotId,
      payload: { castMemberId, override },
    });
  });
}

export interface ShotCastEntry {
  tracklet: Tracklet;
  cast: Pick<CastMember, 'id' | 'label' | 'personaId'> | null;
  look: Look | null;
  /** Persona to render in this shot after overrides; null = keep the original character. */
  personaId: string | null;
}

/** Who appears in a shot and which persona replaces them there. */
export function shotCast(db: Db, shotId: string): ShotCastEntry[] {
  return listShotTracklets(db, shotId).map((t) => {
    if (!t.castMemberId) return { tracklet: t, cast: null, look: null, personaId: null };
    const c = getCastMember(db, t.castMemberId);
    const override = one<{ persona_id: string | null; keep: number }>(
      db,
      'SELECT persona_id, keep FROM shot_cast_overrides WHERE shot_id = :shotId AND cast_member_id = :castId',
      { shotId, castId: c.id },
    );
    const personaId = override ? (override.keep ? null : (override.persona_id ?? c.personaId)) : c.personaId;
    const look = t.lookId ? (c.looks.find((l) => l.id === t.lookId) ?? null) : null;
    return {
      tracklet: t,
      cast: { id: c.id, label: c.label, personaId: c.personaId },
      look,
      personaId: c.status === 'active' ? personaId : null,
    };
  });
}

export function lockedDecisions(
  db: Db,
  projectId: string,
): Array<{ kind: string; trackletA: string | null; trackletB: string | null; castMemberId: string | null }> {
  return all<{
    kind: string;
    tracklet_a: string | null;
    tracklet_b: string | null;
    cast_member_id: string | null;
  }>(
    db,
    'SELECT kind, tracklet_a, tracklet_b, cast_member_id FROM cast_decisions WHERE project_id = :projectId AND locked = 1 ORDER BY created_at',
    { projectId },
  ).map((r) => ({
    kind: r.kind,
    trackletA: r.tracklet_a,
    trackletB: r.tracklet_b,
    castMemberId: r.cast_member_id,
  }));
}

export const encodeVector = (v: number[]): Uint8Array => new Uint8Array(new Float32Array(v).buffer);
export const decodeVector = (b: Uint8Array | null): number[] | null =>
  b ? Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)) : null;
