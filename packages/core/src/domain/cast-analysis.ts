import { existsSync } from 'node:fs';
import { AniError } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { Workspace } from '../workspace.ts';
import { getCastMember } from './cast.ts';

/**
 * 原片分析: what the original character a library character replaces looks like and does in this clip — how
 * the animation draws her, her build and outfit, and the distinct expressions and actions she has, each tied to
 * a crop from one shot. Character design redraws the library character from this, so the new design fits the
 * role: same drawing style and proportions, the expressions and poses the opening actually needs.
 */
export interface Appearance {
  shotId: string;
  /** 1-based shot number, for people. */
  shotNo: number;
  detectionId: string;
  frame: number;
  head: string | null;
  body: string | null;
}

export interface AnalysisItem {
  label: string;
  description: string;
  /** Index into `appearances`. */
  appearance: number;
  /** Whether the design sheet should include it (the human can untick). */
  use: boolean;
}

export interface CastAnalysisData {
  /** How this animation draws the character: eyes, face, line, shading, colour. */
  style: string;
  /** Build and proportions: head-to-body ratio, height, silhouette. */
  body: string;
  outfit: string;
  appearances: Appearance[];
  expressions: AnalysisItem[];
  poses: AnalysisItem[];
}

export type CastAnalysisStatus = 'queued' | 'analyzing' | 'ready' | 'failed';

export interface CastAnalysis {
  castMemberId: string;
  projectId: string;
  status: CastAnalysisStatus;
  data: CastAnalysisData | null;
  /** The appearances changed since (tracklets reassigned in the cast step): analyse again. */
  stale: boolean;
  model: string | null;
  costUsd: number;
  error: string | null;
  createdBy: string;
  updatedAt: number;
}

interface Row {
  cast_member_id: string;
  project_id: string;
  status: CastAnalysisStatus;
  analysis_json: string;
  tracklets_json: string;
  model: string | null;
  cost_usd: number;
  error: string | null;
  created_by: string;
  updated_at: number;
}

export const MAX_EXPRESSIONS = 9;
export const MAX_POSES = 6;

const trackletIdsOf = (db: Db, castId: string): string[] =>
  all<{ id: string }>(db, 'SELECT id FROM tracklets WHERE cast_member_id = :castId ORDER BY id', {
    castId,
  }).map((r) => r.id);

export function getCastAnalysis(db: Db, castId: string): CastAnalysis | null {
  const r = one<Row>(db, 'SELECT * FROM cast_analyses WHERE cast_member_id = :castId', { castId });
  if (!r) return null;
  const used = fromJson<string[]>(r.tracklets_json, []);
  const now = trackletIdsOf(db, castId);
  const data = r.status === 'ready' ? fromJson<CastAnalysisData | null>(r.analysis_json, null) : null;
  // Shots merged or split since: the shot numbers in it no longer match.
  const shotsGone = (data?.appearances ?? []).some(
    (a) => !one(db, 'SELECT 1 AS x FROM shots WHERE id = :id', { id: a.shotId }),
  );
  return {
    castMemberId: r.cast_member_id,
    projectId: r.project_id,
    status: r.status,
    data,
    stale:
      r.status === 'ready' &&
      (shotsGone || used.length !== now.length || used.some((id, i) => id !== now[i])),
    model: r.model,
    costUsd: r.cost_usd,
    error: r.error,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

function event(db: Db, castId: string, projectId: string, kind: string, actor: string, payload = {}): void {
  appendEvent(db, { actor, kind, entityType: 'cast', entityId: castId, projectId, payload });
}

/** Marks an analysis as queued (keeping the previous result until the new one is in). */
export function markCastAnalysisQueued(
  db: Db,
  castId: string,
  actor: string,
  now: number = Date.now(),
): void {
  const c = getCastMember(db, castId);
  run(
    db,
    `INSERT INTO cast_analyses (cast_member_id, project_id, status, created_by, updated_at)
     VALUES (:castId, :projectId, 'queued', :actor, :now)
     ON CONFLICT (cast_member_id) DO UPDATE SET status = 'queued', error = NULL, created_by = :actor, updated_at = :now`,
    { castId, projectId: c.projectId, actor, now },
  );
  event(db, castId, c.projectId, 'cast.analysis_queued', actor);
}

export function setCastAnalysisStatus(
  db: Db,
  castId: string,
  status: CastAnalysisStatus,
  actor: string,
  error: string | null = null,
  now: number = Date.now(),
): void {
  run(
    db,
    'UPDATE cast_analyses SET status = :status, error = :error, updated_at = :now WHERE cast_member_id = :castId',
    {
      castId,
      status,
      error,
      now,
    },
  );
  const c = getCastMember(db, castId);
  event(db, castId, c.projectId, `cast.analysis_${status}`, actor, error ? { error } : {});
}

export function saveCastAnalysis(
  db: Db,
  castId: string,
  data: CastAnalysisData,
  meta: { model: string; costUsd: number; actor: string },
  now: number = Date.now(),
): CastAnalysis {
  const c = getCastMember(db, castId);
  run(
    db,
    `INSERT INTO cast_analyses (cast_member_id, project_id, status, analysis_json, tracklets_json, model, cost_usd, error, created_by, updated_at)
     VALUES (:castId, :projectId, 'ready', :data, :tracklets, :model, :cost, NULL, :actor, :now)
     ON CONFLICT (cast_member_id) DO UPDATE SET status = 'ready', analysis_json = :data, tracklets_json = :tracklets,
       model = :model, cost_usd = :cost, error = NULL, updated_at = :now`,
    {
      castId,
      projectId: c.projectId,
      data: toJson(data),
      tracklets: toJson(trackletIdsOf(db, castId)),
      model: meta.model,
      cost: meta.costUsd,
      actor: meta.actor,
      now,
    },
  );
  event(db, castId, c.projectId, 'cast.analysis_ready', meta.actor, {
    expressions: data.expressions.length,
    poses: data.poses.length,
  });
  return getCastAnalysis(db, castId) as CastAnalysis;
}

/** Ticks or unticks which expressions and poses go into the design sheets (by index). */
export function setAnalysisPicks(
  db: Db,
  castId: string,
  picks: { expressions?: number[]; poses?: number[] },
  actor: string,
  now: number = Date.now(),
): CastAnalysis {
  const a = getCastAnalysis(db, castId);
  if (!a?.data) throw new AniError('conflict', 'Analyse the original character first');
  const data = a.data;
  const apply = (items: AnalysisItem[], keep: number[] | undefined) =>
    keep === undefined ? items : items.map((it, i) => ({ ...it, use: keep.includes(i) }));
  const next = {
    ...data,
    expressions: apply(data.expressions, picks.expressions),
    poses: apply(data.poses, picks.poses),
  };
  run(
    db,
    'UPDATE cast_analyses SET analysis_json = :data, updated_at = :now WHERE cast_member_id = :castId',
    {
      castId,
      data: toJson(next),
      now,
    },
  );
  event(db, castId, a.projectId, 'cast.analysis_picked', actor, picks);
  return getCastAnalysis(db, castId) as CastAnalysis;
}

/**
 * The clearest appearance per shot (largest head with both crops on disk), in shot order, spread over the
 * clip when there are more shots than `limit`.
 */
export function castAppearances(ws: Workspace, castId: string, limit = 16): Appearance[] {
  const rows = all<{
    shot_id: string;
    order_index: number;
    id: string;
    frame: number;
    head_crop_path: string | null;
    body_crop_path: string | null;
    head_bbox_json: string | null;
  }>(
    ws.db,
    `SELECT t.shot_id, s.order_index, d.id, d.frame, d.head_crop_path, d.body_crop_path, d.head_bbox_json
       FROM detections d JOIN tracklets t ON t.id = d.tracklet_id JOIN shots s ON s.id = t.shot_id
     WHERE t.cast_member_id = :castId AND d.head_crop_path IS NOT NULL
     ORDER BY s.order_index, d.frame`,
    { castId },
  );
  const area = (json: string | null) => {
    const b = fromJson<number[] | null>(json, null);
    return b ? (b[2]! - b[0]!) * (b[3]! - b[1]!) : 0;
  };
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!existsSync(ws.abs(r.head_crop_path as string))) continue;
    const cur = best.get(r.shot_id);
    if (!cur || area(r.head_bbox_json) > area(cur.head_bbox_json)) best.set(r.shot_id, r);
  }
  const list = [...best.values()].sort((a, b) => a.order_index - b.order_index);
  const picked =
    list.length <= limit
      ? list
      : Array.from({ length: limit }, (_, i) => list[Math.floor((i * list.length) / limit)]!);
  return picked.map((r) => ({
    shotId: r.shot_id,
    shotNo: r.order_index + 1,
    detectionId: r.id,
    frame: r.frame,
    head: r.head_crop_path,
    body: r.body_crop_path && existsSync(ws.abs(r.body_crop_path)) ? r.body_crop_path : null,
  }));
}

/** Cleans what the vision model returned: known appearances only, capped lists, everything ticked. */
export function normalizeAnalysis(
  raw: {
    style?: unknown;
    body?: unknown;
    outfit?: unknown;
    expressions?: unknown;
    poses?: unknown;
  },
  appearances: Appearance[],
): CastAnalysisData {
  const text = (v: unknown) => (typeof v === 'string' && v.trim().toLowerCase() !== 'null' ? v.trim() : '');
  const items = (v: unknown, max: number): AnalysisItem[] => {
    const seen = new Set<string>();
    const out: AnalysisItem[] = [];
    for (const it of Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []) {
      const label = text(it?.label);
      // The model numbers appearances from 1 as they are listed in the prompt.
      const appearance = Number(it?.appearance) - 1;
      if (!label || seen.has(label.toLowerCase()) || !appearances[appearance]) continue;
      seen.add(label.toLowerCase());
      out.push({ label, description: text(it.description), appearance, use: true });
      if (out.length >= max) break;
    }
    return out;
  };
  return {
    style: text(raw.style),
    body: text(raw.body),
    outfit: text(raw.outfit),
    appearances,
    expressions: items(raw.expressions, MAX_EXPRESSIONS),
    poses: items(raw.poses, MAX_POSES),
  };
}
