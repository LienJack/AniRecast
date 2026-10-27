import { all, type Db, one, run } from '../db.ts';

export type BoundaryVerdict = 'same_moment' | 'cut';

export interface ShotBoundary {
  clipId: string;
  /** First frame of the later shot, in clip numbering. */
  atFrame: number;
  verdict: BoundaryVerdict;
  confidence: number | null;
  reason: string | null;
  /** `jev:<model>`, `codex:<thread>`, `claude`, `user` or `daemon`. */
  decidedBy: string;
  /** A human decision; judges and Codex never override it. */
  locked: boolean;
  sheetPath: string | null;
  updatedAt: number;
}

interface Row {
  clip_id: string;
  at_frame: number;
  verdict: BoundaryVerdict;
  confidence: number | null;
  reason: string | null;
  decided_by: string;
  locked: number;
  sheet_path: string | null;
  updated_at: number;
}

const toBoundary = (r: Row): ShotBoundary => ({
  clipId: r.clip_id,
  atFrame: r.at_frame,
  verdict: r.verdict,
  confidence: r.confidence,
  reason: r.reason,
  decidedBy: r.decided_by,
  locked: r.locked === 1,
  sheetPath: r.sheet_path,
  updatedAt: r.updated_at,
});

export function getBoundary(db: Db, clipId: string, atFrame: number): ShotBoundary | undefined {
  const r = one<Row>(db, 'SELECT * FROM shot_boundaries WHERE clip_id = :clipId AND at_frame = :atFrame', {
    clipId,
    atFrame,
  });
  return r && toBoundary(r);
}

export function listBoundaries(db: Db, clipId: string): ShotBoundary[] {
  return all<Row>(db, 'SELECT * FROM shot_boundaries WHERE clip_id = :clipId ORDER BY at_frame', {
    clipId,
  }).map(toBoundary);
}

/**
 * Records a decision about one cut. A locked (human) decision is never replaced by an unlocked one; returns
 * false when that is what kept it. The sheet path is kept unless a new one is given.
 */
export function recordBoundary(
  db: Db,
  input: {
    clipId: string;
    atFrame: number;
    verdict: BoundaryVerdict;
    decidedBy: string;
    confidence?: number | null;
    reason?: string | null;
    locked?: boolean;
    sheetPath?: string | null;
  },
  now: number = Date.now(),
): boolean {
  const existing = getBoundary(db, input.clipId, input.atFrame);
  if (existing?.locked && !input.locked) return false;
  run(
    db,
    `INSERT INTO shot_boundaries (clip_id, at_frame, verdict, confidence, reason, decided_by, locked, sheet_path, updated_at)
     VALUES (:clipId, :atFrame, :verdict, :confidence, :reason, :decidedBy, :locked, :sheetPath, :now)
     ON CONFLICT (clip_id, at_frame) DO UPDATE SET verdict = excluded.verdict, confidence = excluded.confidence,
       reason = excluded.reason, decided_by = excluded.decided_by, locked = excluded.locked,
       sheet_path = COALESCE(excluded.sheet_path, shot_boundaries.sheet_path), updated_at = excluded.updated_at`,
    {
      clipId: input.clipId,
      atFrame: input.atFrame,
      verdict: input.verdict,
      confidence: input.confidence ?? null,
      reason: input.reason ?? null,
      decidedBy: input.decidedBy,
      locked: input.locked ? 1 : 0,
      sheetPath: input.sheetPath ?? null,
      now,
    },
  );
  return true;
}

/** A human split or merge is a locked decision; one by Codex, Claude Code or the daemon can still be revisited. */
export const isHumanActor = (actor: string): boolean => actor === 'user';
