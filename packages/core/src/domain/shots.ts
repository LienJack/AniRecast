import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { clipHasGeneration, getClip } from './clips.ts';
import { getProject, type Project, projectDir } from './projects.ts';

export type ShotMode = 'replace' | 'clean' | 'keep' | 'exclude';
export const SHOT_MODES: readonly ShotMode[] = ['replace', 'clean', 'keep', 'exclude'];

export interface Shot {
  id: string;
  clipId: string;
  orderIndex: number;
  /** Inclusive frame range within the clip. */
  startFrame: number;
  endFrame: number;
  frameCount: number;
  mode: ShotMode;
  modeSource: 'auto' | 'user';
  removeOtherOverlays: boolean;
  status: string;
  repFrame: number;
  description: string | null;
  camera: unknown;
  sourcePath: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ShotRow {
  id: string;
  clip_id: string;
  order_index: number;
  start_frame: number;
  end_frame: number;
  mode: ShotMode;
  mode_source: 'auto' | 'user';
  remove_other_overlays: number;
  status: string;
  rep_frame: number;
  description: string | null;
  camera_json: string | null;
  source_path: string | null;
  created_at: number;
  updated_at: number;
}

const toShot = (r: ShotRow): Shot => ({
  id: r.id,
  clipId: r.clip_id,
  orderIndex: r.order_index,
  startFrame: r.start_frame,
  endFrame: r.end_frame,
  frameCount: r.end_frame - r.start_frame + 1,
  mode: r.mode,
  modeSource: r.mode_source,
  removeOtherOverlays: r.remove_other_overlays === 1,
  status: r.status,
  repFrame: r.rep_frame,
  description: r.description,
  camera: fromJson(r.camera_json, null),
  sourcePath: r.source_path,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface Keyframe {
  id: string;
  shotId: string;
  frame: number;
  role: string;
  path: string;
}

export const shotDir = (p: Pick<Project, 'slug'>, shotId: string): string =>
  `${projectDir(p)}/shots/${shotId}`;
const midFrame = (start: number, end: number) => Math.floor((start + end) / 2);

export function getShot(db: Db, id: string): Shot {
  const row = one<ShotRow>(db, 'SELECT * FROM shots WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Shot not found: ${id}`);
  return toShot(row);
}

export function listShots(db: Db, clipId: string): Shot[] {
  return all<ShotRow>(db, 'SELECT * FROM shots WHERE clip_id = :clipId ORDER BY order_index', { clipId }).map(
    toShot,
  );
}

/** Project that owns a shot (through its clip). */
export function projectOfShot(db: Db, shotId: string): Project {
  const row = one<{ project_id: string }>(
    db,
    'SELECT c.project_id FROM shots s JOIN clips c ON c.id = s.clip_id WHERE s.id = :shotId',
    { shotId },
  );
  if (!row) throw new AniError('not_found', `Shot not found: ${shotId}`);
  return getProject(db, row.project_id);
}

export function shotHasGeneration(db: Db, shotId: string): boolean {
  const row = one<{ n: number }>(
    db,
    'SELECT (SELECT COUNT(*) FROM boards WHERE shot_id = :id) + (SELECT COUNT(*) FROM takes WHERE shot_id = :id) AS n',
    { id: shotId },
  );
  return (row?.n ?? 0) > 0;
}

/** Shots must tile the clip: start at 0, be contiguous, never overlap, and end at the last frame. */
export function assertCoverage(
  ranges: Array<{ startFrame: number; endFrame: number }>,
  frameCount: number,
): void {
  let expected = 0;
  for (const r of ranges) {
    if (r.startFrame !== expected || r.endFrame < r.startFrame) {
      throw new AniError('internal', `Shot ranges do not tile the clip at frame ${expected}`, {
        details: ranges,
      });
    }
    expected = r.endFrame + 1;
  }
  if (expected !== frameCount)
    throw new AniError('internal', `Shots cover ${expected} of ${frameCount} frames`);
}

function renumber(db: Db, clipId: string): void {
  const ids = all<{ id: string }>(db, 'SELECT id FROM shots WHERE clip_id = :clipId ORDER BY start_frame', {
    clipId,
  });
  for (const [i, { id }] of ids.entries())
    run(db, 'UPDATE shots SET order_index = :i WHERE id = :id', { id, i });
}

function insertShot(db: Db, clipId: string, start: number, end: number, order: number, now: number): string {
  const id = newId('shot', now);
  run(
    db,
    `INSERT INTO shots (id, clip_id, order_index, start_frame, end_frame, rep_frame, created_at, updated_at)
     VALUES (:id, :clipId, :order, :start, :end, :rep, :now, :now)`,
    { id, clipId, order, start, end, rep: midFrame(start, end), now },
  );
  return id;
}

/** Replaces a clip's shots with detected ranges. Refused once anything has been generated. */
export function replaceShots(
  db: Db,
  clipId: string,
  ranges: Array<{ start: number; end: number }>,
  actor: string,
  now: number = Date.now(),
): Shot[] {
  return tx(db, () => {
    const clip = getClip(db, clipId);
    if (clipHasGeneration(db, clipId)) {
      throw new AniError(
        'conflict',
        'Shots already have generated versions; re-detection would orphan them',
        {
          hint: 'Set a new clip with --force to start over; the current one stays as history.',
        },
      );
    }
    assertCoverage(
      ranges.map((r) => ({ startFrame: r.start, endFrame: r.end })),
      clip.frameCount,
    );
    run(db, 'DELETE FROM shots WHERE clip_id = :clipId', { clipId });
    for (const [i, r] of ranges.entries()) insertShot(db, clipId, r.start, r.end, i, now + i);
    const shots = listShots(db, clipId);
    appendEvent(db, {
      actor,
      kind: 'shots.replaced',
      entityType: 'clip',
      entityId: clipId,
      projectId: clip.projectId,
      payload: { count: shots.length },
    });
    return shots;
  });
}

export function splitShot(
  db: Db,
  shotId: string,
  atFrame: number,
  actor: string,
  now: number = Date.now(),
): [Shot, Shot] {
  return tx(db, () => {
    const shot = getShot(db, shotId);
    if (atFrame <= shot.startFrame || atFrame > shot.endFrame) {
      throw new AniError('usage', `Split frame must be in (${shot.startFrame}, ${shot.endFrame}]`);
    }
    if (shotHasGeneration(db, shotId))
      throw new AniError('conflict', 'Cannot split a shot that already has generated versions');
    run(db, 'UPDATE shots SET end_frame = :end, rep_frame = :rep, updated_at = :now WHERE id = :id', {
      id: shotId,
      end: atFrame - 1,
      rep: midFrame(shot.startFrame, atFrame - 1),
      now,
    });
    run(db, 'DELETE FROM keyframes WHERE shot_id = :id', { id: shotId });
    const newIdValue = insertShot(db, shot.clipId, atFrame, shot.endFrame, shot.orderIndex + 1, now);
    renumber(db, shot.clipId);
    const clip = getClip(db, shot.clipId);
    assertCoverage(listShots(db, shot.clipId), clip.frameCount);
    appendEvent(db, {
      actor,
      kind: 'shot.split',
      entityType: 'shot',
      entityId: shotId,
      projectId: clip.projectId,
      payload: { atFrame, newShotId: newIdValue },
    });
    return [getShot(db, shotId), getShot(db, newIdValue)];
  });
}

export function mergeShots(
  db: Db,
  firstId: string,
  secondId: string,
  actor: string,
  now: number = Date.now(),
): Shot {
  return tx(db, () => {
    const a = getShot(db, firstId);
    const b = getShot(db, secondId);
    const [first, second] = a.startFrame < b.startFrame ? [a, b] : [b, a];
    if (first.clipId !== second.clipId || first.endFrame + 1 !== second.startFrame) {
      throw new AniError('usage', 'Only adjacent shots of the same clip can be merged');
    }
    if (shotHasGeneration(db, first.id) || shotHasGeneration(db, second.id)) {
      throw new AniError('conflict', 'Cannot merge shots that already have generated versions');
    }
    run(db, 'DELETE FROM shots WHERE id = :id', { id: second.id });
    run(db, 'DELETE FROM keyframes WHERE shot_id = :id', { id: first.id });
    run(
      db,
      'UPDATE shots SET end_frame = :end, rep_frame = :rep, source_path = NULL, updated_at = :now WHERE id = :id',
      {
        id: first.id,
        end: second.endFrame,
        rep: midFrame(first.startFrame, second.endFrame),
        now,
      },
    );
    renumber(db, first.clipId);
    const clip = getClip(db, first.clipId);
    assertCoverage(listShots(db, first.clipId), clip.frameCount);
    appendEvent(db, {
      actor,
      kind: 'shot.merged',
      entityType: 'shot',
      entityId: first.id,
      projectId: clip.projectId,
      payload: { removed: second.id },
    });
    return getShot(db, first.id);
  });
}

export interface ShotPatch {
  mode?: ShotMode;
  repFrame?: number;
  removeOtherOverlays?: boolean;
  description?: string | null;
  camera?: unknown;
  sourcePath?: string | null;
  status?: string;
}

/** `mode` set here counts as a user decision unless `modeSource` says otherwise. */
export function updateShot(
  db: Db,
  shotId: string,
  patch: ShotPatch,
  actor: string,
  { modeSource = 'user' as 'auto' | 'user' } = {},
  now: number = Date.now(),
): Shot {
  return tx(db, () => {
    const shot = getShot(db, shotId);
    if (patch.mode && !SHOT_MODES.includes(patch.mode))
      throw new AniError('usage', `Mode must be one of ${SHOT_MODES.join(', ')}`);
    if (
      patch.repFrame !== undefined &&
      (patch.repFrame < shot.startFrame || patch.repFrame > shot.endFrame)
    ) {
      throw new AniError('usage', `Representative frame must be within ${shot.startFrame}..${shot.endFrame}`);
    }
    const sets = ['updated_at = :now'];
    const params: Record<string, string | number | null> = { id: shotId, now };
    if (patch.mode) {
      sets.push('mode = :mode', 'mode_source = :modeSource');
      params.mode = patch.mode;
      params.modeSource = modeSource;
    }
    if (patch.repFrame !== undefined) {
      sets.push('rep_frame = :repFrame');
      params.repFrame = patch.repFrame;
    }
    if (patch.removeOtherOverlays !== undefined) {
      sets.push('remove_other_overlays = :rmo');
      params.rmo = patch.removeOtherOverlays ? 1 : 0;
    }
    if (patch.description !== undefined) {
      sets.push('description = :description');
      params.description = patch.description;
    }
    if (patch.camera !== undefined) {
      sets.push('camera_json = :camera');
      params.camera = toJson(patch.camera);
    }
    if (patch.sourcePath !== undefined) {
      sets.push('source_path = :sourcePath');
      params.sourcePath = patch.sourcePath;
    }
    if (patch.status !== undefined) {
      sets.push('status = :status');
      params.status = patch.status;
    }
    run(db, `UPDATE shots SET ${sets.join(', ')} WHERE id = :id`, params);
    const clip = getClip(db, shot.clipId);
    appendEvent(db, {
      actor,
      kind: 'shot.updated',
      entityType: 'shot',
      entityId: shotId,
      projectId: clip.projectId,
      payload: { fields: Object.keys(patch) },
    });
    return getShot(db, shotId);
  });
}

export function setKeyframes(
  db: Db,
  shotId: string,
  frames: Array<Omit<Keyframe, 'id' | 'shotId'>>,
  now: number = Date.now(),
): Keyframe[] {
  return tx(db, () => {
    run(db, 'DELETE FROM keyframes WHERE shot_id = :shotId', { shotId });
    for (const [i, f] of frames.entries()) {
      run(
        db,
        'INSERT INTO keyframes (id, shot_id, frame, role, path) VALUES (:id, :shotId, :frame, :role, :path)',
        {
          id: newId('kf', now + i),
          shotId,
          frame: f.frame,
          role: f.role,
          path: f.path,
        },
      );
    }
    return listKeyframes(db, shotId);
  });
}

export function listKeyframes(db: Db, shotId: string): Keyframe[] {
  return all<{ id: string; shot_id: string; frame: number; role: string; path: string }>(
    db,
    'SELECT * FROM keyframes WHERE shot_id = :shotId ORDER BY frame',
    { shotId },
  ).map((r) => ({ id: r.id, shotId: r.shot_id, frame: r.frame, role: r.role, path: r.path }));
}

/** Frames to sample per shot: first, middle, last, plus one per extra second for long shots. */
export function sampleFrames(
  shot: Pick<Shot, 'startFrame' | 'endFrame' | 'repFrame'>,
  fps: number,
): Array<{ frame: number; role: string }> {
  const out = new Map<number, string>();
  out.set(shot.startFrame, 'first');
  out.set(shot.endFrame, 'last');
  out.set(midFrame(shot.startFrame, shot.endFrame), 'mid');
  const step = Math.max(1, Math.round(fps));
  if (shot.endFrame - shot.startFrame + 1 > 3 * step) {
    for (let f = shot.startFrame + step; f < shot.endFrame; f += step) if (!out.has(f)) out.set(f, 'sample');
  }
  if (!out.has(shot.repFrame)) out.set(shot.repFrame, 'rep');
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([frame, role]) => ({ frame, role }));
}
