import { all, type Db, fromJson } from '../db.ts';
import { shotCast } from './cast.ts';
import { overlaysToRemove } from './overlays.ts';
import { getShot } from './shots.ts';

/**
 * What a shot's generated versions depend on: which cast member becomes which persona, and which overlaid
 * text is removed. A version only goes stale when this changes (dismissing a background extra does not).
 */
export function replacementSignature(db: Db, shotId: string): string {
  const shot = getShot(db, shotId);
  const projectId = all<{ project_id: string }>(db, 'SELECT project_id FROM clips WHERE id = :id', {
    id: shot.clipId,
  })[0]?.project_id;
  // The approved design of each persona joins the signature only once one exists, so projects without the
  // design step keep the signatures their versions were made with.
  const design = (personaId: string) =>
    all<{ id: string }>(
      db,
      `SELECT id FROM designs WHERE project_id = :projectId AND persona_id = :personaId
         AND kind = 'turnaround' AND status = 'approved' ORDER BY version DESC LIMIT 1`,
      { projectId: projectId ?? '', personaId },
    )[0]?.id;
  const personas = [
    ...new Set(
      shotCast(db, shotId)
        .filter((e) => e.personaId && e.cast)
        .map((e) => {
          const d = design(e.personaId!);
          return `${e.cast!.id}:${e.personaId}:${e.look?.lookPolicy ?? 'persona'}${d ? `:${d}` : ''}`;
        }),
    ),
  ].sort();
  const overlays = overlaysToRemove(db, shotId, shot.removeOtherOverlays)
    .map((o) => `${o.text ?? ''}@${o.bbox.map((v) => v.toFixed(2)).join(',')}`)
    .sort();
  return JSON.stringify({ mode: shot.mode, personas, overlays });
}

export interface PlacedEntry {
  castLabel: string | null;
  position: 'left' | 'center' | 'right' | null;
  appearance: string | null;
}

/** Where a tracklet sits (from its head box nearest the representative frame) and how Flash described it. */
export function placeTracklet(
  db: Db,
  trackletId: string,
  nearFrame: number,
): Pick<PlacedEntry, 'position' | 'appearance'> {
  const dets = all<{ frame: number; head_bbox_json: string | null; attrs_json: string }>(
    db,
    'SELECT frame, head_bbox_json, attrs_json FROM detections WHERE tracklet_id = :trackletId',
    { trackletId },
  );
  if (dets.length === 0) return { position: null, appearance: null };
  const d = dets.reduce((b, x) => (Math.abs(x.frame - nearFrame) < Math.abs(b.frame - nearFrame) ? x : b));
  const head = fromJson<number[] | null>(d.head_bbox_json, null);
  const cx = head ? (head[0]! + head[2]!) / 2 : null;
  const position = cx === null ? null : cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
  const attrs = fromJson<Record<string, string>>(d.attrs_json, {});
  const parts = [attrs.hair, attrs.eyes ? `${attrs.eyes} eyes` : undefined, attrs.outfit].filter(
    (p) => p?.trim() && p.toLowerCase() !== 'null',
  );
  return { position, appearance: parts.length ? parts.join('; ') : null };
}
