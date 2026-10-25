import { all, type Db, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { shotCast } from './cast.ts';
import { findActiveClip } from './clips.ts';
import { overlaysToRemove } from './overlays.ts';
import { getShot, listShots, type Shot, type ShotMode, updateShot } from './shots.ts';

/** design §6: replace if a mapped persona appears; else clean if overlays must go; else keep. */
export function autoModeFor(db: Db, shot: Shot): ShotMode {
  if (shotCast(db, shot.id).some((e) => e.personaId !== null)) return 'replace';
  if (overlaysToRemove(db, shot.id, shot.removeOtherOverlays).length > 0) return 'clean';
  return 'keep';
}

/** Recomputes modes for shots still on automatic; user-set modes are left alone. */
export function recomputeShotModes(
  db: Db,
  projectId: string,
  actor = 'system',
): Array<{ shotId: string; from: ShotMode; to: ShotMode }> {
  const clip = findActiveClip(db, projectId);
  if (!clip) return [];
  const changes: Array<{ shotId: string; from: ShotMode; to: ShotMode }> = [];
  tx(db, () => {
    for (const shot of listShots(db, clip.id)) {
      if (shot.modeSource !== 'auto') continue;
      const to = autoModeFor(db, shot);
      if (to !== shot.mode) {
        updateShot(db, shot.id, { mode: to }, actor, { modeSource: 'auto' });
        changes.push({ shotId: shot.id, from: shot.mode, to });
      }
    }
  });
  return changes;
}

/** Marks a shot's usable boards/takes stale after an input it depended on changed. */
export function markShotGenerationStale(db: Db, shotId: string, reason: string, actor: string): number {
  return tx(db, () => {
    const boards = run(
      db,
      `UPDATE boards SET status = 'stale' WHERE shot_id = :shotId AND status IN ('ready', 'approved')`,
      { shotId },
    ).changes;
    const takes = run(
      db,
      `UPDATE takes SET status = 'stale' WHERE shot_id = :shotId AND status IN ('ready', 'approved')`,
      { shotId },
    ).changes;
    if (boards + takes > 0) {
      const shot = getShot(db, shotId);
      const projectId =
        all<{ project_id: string }>(db, 'SELECT project_id FROM clips WHERE id = :id', { id: shot.clipId })[0]
          ?.project_id ?? null;
      appendEvent(db, {
        actor,
        kind: 'shot.stale',
        entityType: 'shot',
        entityId: shotId,
        projectId,
        payload: { reason, boards, takes },
      });
    }
    return boards + takes;
  });
}
