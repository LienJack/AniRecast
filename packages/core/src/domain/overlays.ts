import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';

export type OverlayCategory = 'staff_credit' | 'title_or_other' | 'in_scene';
export type Bbox = [number, number, number, number];

export interface TextOverlay {
  id: string;
  shotId: string;
  keyframeId: string | null;
  /** Normalized [x0, y0, x1, y1] in 0..1 of the frame. */
  bbox: Bbox;
  text: string | null;
  category: OverlayCategory;
  remove: boolean;
  decidedBy: 'auto' | 'codex' | 'user';
}

interface OverlayRow {
  id: string;
  shot_id: string;
  keyframe_id: string | null;
  bbox_json: string;
  text: string | null;
  category: OverlayCategory;
  remove: number;
  decided_by: 'auto' | 'codex' | 'user';
}

const toOverlay = (r: OverlayRow): TextOverlay => ({
  id: r.id,
  shotId: r.shot_id,
  keyframeId: r.keyframe_id,
  bbox: fromJson(r.bbox_json, [0, 0, 0, 0] as Bbox),
  text: r.text,
  category: r.category,
  remove: r.remove === 1,
  decidedBy: r.decided_by,
});

/** PRD Q7: staff credits are removed by default, titles/other overlays kept, in-scene text never removed. */
export const defaultRemove = (category: OverlayCategory): boolean => category === 'staff_credit';

export function listTextOverlays(db: Db, shotId: string): TextOverlay[] {
  return all<OverlayRow>(db, 'SELECT * FROM text_overlays WHERE shot_id = :shotId', { shotId }).map(
    toOverlay,
  );
}

/** Replaces the automatic detections of a shot, keeping rows a person or Codex already decided. */
export function replaceAutoOverlays(
  db: Db,
  shotId: string,
  overlays: Array<{
    keyframeId?: string | null;
    bbox: Bbox;
    text?: string | null;
    category: OverlayCategory;
  }>,
  now: number = Date.now(),
): TextOverlay[] {
  return tx(db, () => {
    run(db, `DELETE FROM text_overlays WHERE shot_id = :shotId AND decided_by = 'auto'`, { shotId });
    for (const [i, o] of overlays.entries()) {
      run(
        db,
        `INSERT INTO text_overlays (id, shot_id, keyframe_id, bbox_json, text, category, remove, decided_by)
         VALUES (:id, :shotId, :keyframeId, :bbox, :text, :category, :remove, 'auto')`,
        {
          id: newId('ovl', now + i),
          shotId,
          keyframeId: o.keyframeId ?? null,
          bbox: toJson(o.bbox),
          text: o.text ?? null,
          category: o.category,
          remove: defaultRemove(o.category) ? 1 : 0,
        },
      );
    }
    return listTextOverlays(db, shotId);
  });
}

export function setOverlayRemoval(
  db: Db,
  overlayId: string,
  patch: { remove?: boolean; category?: OverlayCategory },
  actor: string,
): TextOverlay {
  return tx(db, () => {
    const row = one<OverlayRow>(db, 'SELECT * FROM text_overlays WHERE id = :overlayId', { overlayId });
    if (!row) throw new AniError('not_found', `Overlay not found: ${overlayId}`);
    const category = patch.category ?? row.category;
    const remove =
      category === 'in_scene'
        ? false
        : (patch.remove ?? (patch.category ? defaultRemove(category) : row.remove === 1));
    // Only the human's call is `user`; Claude, Codex and the daemon decide as AI (`decided_by` allows no other value).
    const decidedBy = actor === 'user' ? 'user' : 'codex';
    run(
      db,
      'UPDATE text_overlays SET category = :category, remove = :remove, decided_by = :decidedBy WHERE id = :overlayId',
      {
        overlayId,
        category,
        remove: remove ? 1 : 0,
        decidedBy,
      },
    );
    appendEvent(db, {
      actor,
      kind: 'overlay.updated',
      entityType: 'shot',
      entityId: row.shot_id,
      payload: { overlayId, category, remove },
    });
    return toOverlay({ ...row, category, remove: remove ? 1 : 0, decided_by: decidedBy });
  });
}

/** Overlays that will be removed in this shot, honouring the shot's "also remove titles" switch. */
export function overlaysToRemove(db: Db, shotId: string, removeOtherOverlays: boolean): TextOverlay[] {
  return listTextOverlays(db, shotId).filter(
    (o) =>
      o.category !== 'in_scene' && (o.remove || (removeOtherOverlays && o.category === 'title_or_other')),
  );
}
