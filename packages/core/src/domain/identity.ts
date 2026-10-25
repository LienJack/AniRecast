import { newId } from '@anirecast/shared';
import { all, type Db, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import {
  createCastMember,
  createLook,
  decodeVector,
  encodeVector,
  getCastMember,
  listCast,
  listLooks,
} from './cast.ts';
import { findActiveClip } from './clips.ts';
import { listShots } from './shots.ts';

export interface DetectedTracklet {
  detections: Array<{
    frame: number;
    keyframeId?: string | null;
    headBbox: number[];
    bodyBbox: number[];
    score: number;
    headCrop: string;
    bodyCrop: string;
  }>;
  identityVec: number[];
  appearanceVec: number[];
}

/** Stores freshly detected appearances for a shot, replacing earlier automatic ones that nobody decided on. */
export function replaceAutoTracklets(
  db: Db,
  shotId: string,
  tracklets: DetectedTracklet[],
  toRel: (abs: string) => string,
  now: number = Date.now(),
): string[] {
  return tx(db, () => {
    const decided = new Set(
      all<{ id: string }>(
        db,
        `SELECT DISTINCT t.id FROM tracklets t JOIN cast_decisions d ON d.tracklet_a = t.id OR d.tracklet_b = t.id WHERE t.shot_id = :shotId`,
        { shotId },
      ).map((r) => r.id),
    );
    for (const { id } of all<{ id: string }>(
      db,
      `SELECT id FROM tracklets WHERE shot_id = :shotId AND assigned_by = 'auto'`,
      { shotId },
    )) {
      if (!decided.has(id)) run(db, 'DELETE FROM tracklets WHERE id = :id', { id });
    }
    const ids: string[] = [];
    for (const [i, t] of tracklets.entries()) {
      const id = newId('trk', now + i);
      run(
        db,
        `INSERT INTO tracklets (id, shot_id, identity_vec, appearance_vec, assigned_by) VALUES (:id, :shotId, :iv, :av, 'auto')`,
        { id, shotId, iv: encodeVector(t.identityVec), av: encodeVector(t.appearanceVec) },
      );
      for (const [k, d] of t.detections.entries()) {
        run(
          db,
          `INSERT INTO detections (id, tracklet_id, keyframe_id, frame, head_bbox_json, body_bbox_json, head_crop_path, body_crop_path)
           VALUES (:id, :trackletId, :keyframeId, :frame, :head, :body, :headCrop, :bodyCrop)`,
          {
            id: newId('det', now + i * 100 + k),
            trackletId: id,
            keyframeId: d.keyframeId ?? null,
            frame: d.frame,
            head: toJson(d.headBbox),
            body: toJson(d.bodyBbox),
            headCrop: toRel(d.headCrop),
            bodyCrop: toRel(d.bodyCrop),
          },
        );
      }
      ids.push(id);
    }
    return ids;
  });
}

export interface IdentityInput {
  tracklets: Array<{ id: string; shotId: string; identityVec: number[]; appearanceVec: number[] }>;
  mustLink: Array<[string, string]>;
  cannotLink: Array<[string, string]>;
  /** Tracklets dismissed as not a character; left out of clustering. */
  excluded: string[];
}

/**
 * Everything the clustering pass needs: vectors plus constraints. Decisions (Codex and user) become
 * must/cannot links; user assignments to the same member link, to different members block.
 */
export function identityInput(db: Db, projectId: string): IdentityInput {
  const clip = findActiveClip(db, projectId);
  const shotIds = clip ? listShots(db, clip.id).map((s) => s.id) : [];
  const rows = shotIds.length
    ? all<{
        id: string;
        shot_id: string;
        identity_vec: Uint8Array | null;
        appearance_vec: Uint8Array | null;
        cast_member_id: string | null;
        assigned_by: string;
      }>(
        db,
        `SELECT id, shot_id, identity_vec, appearance_vec, cast_member_id, assigned_by FROM tracklets WHERE shot_id IN (${shotIds.map((_, i) => `:s${i}`).join(',')})`,
        Object.fromEntries(shotIds.map((id, i) => [`s${i}`, id])),
      )
    : [];
  const decisions = all<{
    kind: string;
    tracklet_a: string | null;
    tracklet_b: string | null;
    cast_member_id: string | null;
    source: string;
  }>(
    db,
    'SELECT kind, tracklet_a, tracklet_b, cast_member_id, source FROM cast_decisions WHERE project_id = :projectId ORDER BY created_at',
    { projectId },
  );
  const excluded = new Set<string>();
  const latestAssign = new Map<string, string>();
  const mustLink: Array<[string, string]> = [];
  const cannotLink: Array<[string, string]> = [];
  for (const d of decisions) {
    if (d.kind === 'not_a_character' && d.tracklet_a) {
      excluded.add(d.tracklet_a);
      latestAssign.delete(d.tracklet_a);
    } else if (d.kind === 'assign' && d.tracklet_a && d.cast_member_id) {
      latestAssign.set(d.tracklet_a, d.cast_member_id);
      excluded.delete(d.tracklet_a);
    } else if (d.kind === 'must_link' && d.tracklet_a && d.tracklet_b) {
      mustLink.push([d.tracklet_a, d.tracklet_b]);
    } else if (d.kind === 'cannot_link' && d.tracklet_a && d.tracklet_b) {
      cannotLink.push([d.tracklet_a, d.tracklet_b]);
    }
  }
  const byCast = new Map<string, string[]>();
  for (const [t, c] of latestAssign) byCast.set(c, [...(byCast.get(c) ?? []), t]);
  const groups = [...byCast.values()];
  for (const g of groups) for (let i = 1; i < g.length; i++) mustLink.push([g[0]!, g[i]!]);
  for (let a = 0; a < groups.length; a++)
    for (let b = a + 1; b < groups.length; b++) cannotLink.push([groups[a]![0]!, groups[b]![0]!]);
  return {
    tracklets: rows
      .filter((r) => r.identity_vec && !excluded.has(r.id))
      .map((r) => ({
        id: r.id,
        shotId: r.shot_id,
        identityVec: decodeVector(r.identity_vec) ?? [],
        appearanceVec: decodeVector(r.appearance_vec) ?? [],
      })),
    mustLink,
    cannotLink,
    excluded: [...excluded],
  };
}

export interface ClusterResult {
  clusters: Array<{ members: string[]; looks: string[][] }>;
  confidence: Record<string, number>;
}

/**
 * Maps clusters onto cast members: a cluster keeps the member a user locked one of its appearances to,
 * otherwise the member most of it already belongs to, otherwise a new "角色 N". Locked and Codex
 * assignments are never rewritten here; looks keep their policy when they keep most of their appearances.
 */
export function applyClusters(
  db: Db,
  projectId: string,
  result: ClusterResult,
  now: number = Date.now(),
): { castIds: string[]; created: number } {
  return tx(db, () => {
    const current = new Map(
      all<{ id: string; cast_member_id: string | null; assigned_by: string; look_id: string | null }>(
        db,
        `SELECT t.id, t.cast_member_id, t.assigned_by, t.look_id FROM tracklets t JOIN shots s ON s.id = t.shot_id JOIN clips c ON c.id = s.clip_id WHERE c.project_id = :projectId`,
        { projectId },
      ).map((r) => [r.id, r]),
    );
    const used = new Set<string>();
    const castIds: string[] = [];
    let created = 0;
    let label = listCast(db, projectId, { includeInactive: true }).length;
    // Biggest clusters claim existing members first; castIds stays aligned with the input order.
    const ordered = result.clusters
      .map((cluster, index) => ({ cluster, index }))
      .sort((a, b) => b.cluster.members.length - a.cluster.members.length);
    for (const { cluster, index } of ordered) {
      const pinned = cluster.members
        .map((m) => current.get(m))
        .find((t) => t && t.assigned_by === 'user' && t.cast_member_id && !used.has(t.cast_member_id));
      const votes = new Map<string, number>();
      for (const m of cluster.members) {
        const c = current.get(m)?.cast_member_id;
        if (c && !used.has(c)) votes.set(c, (votes.get(c) ?? 0) + 1);
      }
      const majority = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      let castId = pinned?.cast_member_id ?? majority;
      if (!castId) {
        label++;
        castId = createCastMember(db, { projectId, label: `角色 ${label}` }, 'system', now + label).id;
        created++;
      }
      used.add(castId);
      castIds[index] = castId;
      for (const m of cluster.members) {
        const t = current.get(m);
        if (!t || t.assigned_by === 'user' || (t.assigned_by === 'codex' && t.cast_member_id === castId))
          continue;
        run(
          db,
          `UPDATE tracklets SET cast_member_id = :castId, confidence = :conf, assigned_by = 'auto' WHERE id = :id`,
          { id: m, castId, conf: result.confidence[m] ?? null },
        );
      }
      // Looks: reuse the old look most of each new group came from, so a user-set policy survives.
      const oldLooks = listLooks(db, castId);
      const reused = new Set<string>();
      for (const [i, group] of cluster.looks.entries()) {
        const votesLook = new Map<string, number>();
        for (const m of group) {
          const l = current.get(m)?.look_id;
          if (l && oldLooks.some((o) => o.id === l) && !reused.has(l))
            votesLook.set(l, (votesLook.get(l) ?? 0) + 1);
        }
        const keep = [...votesLook.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const lookId =
          keep ??
          createLook(
            db,
            {
              castMemberId: castId,
              label: `造型 ${String.fromCharCode(65 + i)}`,
              representativeTrackletId: group[0] ?? null,
            },
            now + i,
          ).id;
        reused.add(lookId);
        for (const m of group)
          run(db, 'UPDATE tracklets SET look_id = :lookId WHERE id = :id AND cast_member_id = :castId', {
            id: m,
            lookId,
            castId,
          });
      }
      for (const o of oldLooks) {
        if (reused.has(o.id)) continue;
        run(db, 'UPDATE tracklets SET look_id = NULL WHERE look_id = :id', { id: o.id });
        run(db, 'DELETE FROM looks WHERE id = :id', { id: o.id });
      }
      const thumb = all<{ head_crop_path: string | null }>(
        db,
        `SELECT d.head_crop_path FROM detections d JOIN tracklets t ON t.id = d.tracklet_id WHERE t.cast_member_id = :castId ORDER BY t.confidence DESC, d.frame LIMIT 1`,
        { castId },
      )[0]?.head_crop_path;
      if (thumb) run(db, 'UPDATE cast_members SET thumb_path = :thumb WHERE id = :castId', { castId, thumb });
    }
    // Automatic members left with nobody and no persona fade out; anything a person touched stays.
    for (const c of listCast(db, projectId)) {
      if (!used.has(c.id) && c.tracklets.length === 0 && !c.personaId) {
        run(db, `UPDATE cast_members SET status = 'merged' WHERE id = :id`, { id: c.id });
      }
    }
    appendEvent(db, {
      actor: 'system',
      kind: 'cast.identified',
      entityType: 'project',
      entityId: projectId,
      projectId,
      payload: { clusters: result.clusters.length, created },
    });
    return { castIds, created };
  });
}

export const castLabel = (db: Db, castId: string): string => getCastMember(db, castId).label;
