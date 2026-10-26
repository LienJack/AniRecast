import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { GenerationTier } from './projects.ts';
import { getShot, projectOfShot, updateShot } from './shots.ts';

export type VersionStatus = 'queued' | 'generating' | 'ready' | 'approved' | 'rejected' | 'failed' | 'stale';

/** A file that fed a generation, hashed so the request can be replayed and audited. */
export interface InputRef {
  role: string;
  path: string;
  sha256?: string;
}

interface VersionCommon {
  id: string;
  shotId: string;
  version: number;
  status: VersionStatus;
  path: string | null;
  prompt: string;
  model: string;
  params: Record<string, unknown>;
  inputs: InputRef[];
  parentId: string | null;
  remote: Record<string, unknown>;
  error: string | null;
  costUsd: number;
  createdBy: string;
  createdAt: number;
}

/** Which moment of the shot a storyboard frame is drawn from. */
export type BoardRole = 'first' | 'key' | 'last';
export const BOARD_ROLES: readonly BoardRole[] = ['first', 'key', 'last'];

export interface Board extends VersionCommon {
  role: BoardRole;
  /** The source frame it redraws. */
  frame: number | null;
}

export interface Take extends VersionCommon {
  boardId: string | null;
  tier: GenerationTier;
  framesIn: number | null;
  framesOut: number | null;
  conform: Record<string, unknown>;
}

interface VersionRow {
  id: string;
  shot_id: string;
  version: number;
  status: VersionStatus;
  path: string | null;
  prompt: string;
  model: string;
  params_json: string;
  inputs_json: string;
  parent_id: string | null;
  remote_json: string;
  error: string | null;
  cost_usd: number;
  created_by: string;
  created_at: number;
}

interface BoardRow extends VersionRow {
  role: BoardRole;
  frame: number | null;
}

interface TakeRow extends VersionRow {
  board_id: string | null;
  tier: GenerationTier;
  frames_in: number | null;
  frames_out: number | null;
  conform_json: string;
}

const common = (r: VersionRow): VersionCommon => ({
  id: r.id,
  shotId: r.shot_id,
  version: r.version,
  status: r.status,
  path: r.path,
  prompt: r.prompt,
  model: r.model,
  params: fromJson(r.params_json, {}),
  inputs: fromJson(r.inputs_json, []),
  parentId: r.parent_id,
  remote: fromJson(r.remote_json, {}),
  error: r.error,
  costUsd: r.cost_usd,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const toBoard = (r: BoardRow): Board => ({ ...common(r), role: r.role, frame: r.frame });

const toTake = (r: TakeRow): Take => ({
  ...common(r),
  boardId: r.board_id,
  tier: r.tier,
  framesIn: r.frames_in,
  framesOut: r.frames_out,
  conform: fromJson(r.conform_json, {}),
});

const pad = (n: number) => String(n).padStart(3, '0');
export const boardFileStem = (version: number) => `b${pad(version)}`;
export const takeFileStem = (version: number) => `t${pad(version)}`;

export function getBoard(db: Db, id: string): Board {
  const row = one<BoardRow>(db, 'SELECT * FROM boards WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Board not found: ${id}`);
  return toBoard(row);
}

export function getTake(db: Db, id: string): Take {
  const row = one<TakeRow>(db, 'SELECT * FROM takes WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Take not found: ${id}`);
  return toTake(row);
}

export const listBoards = (db: Db, shotId: string): Board[] =>
  all<BoardRow>(db, 'SELECT * FROM boards WHERE shot_id = :shotId ORDER BY version', { shotId }).map(toBoard);
export const listTakes = (db: Db, shotId: string): Take[] =>
  all<TakeRow>(db, 'SELECT * FROM takes WHERE shot_id = :shotId ORDER BY version', { shotId }).map(toTake);

/** The approved storyboard frame of one moment of the shot (the key frame unless said). */
export const approvedBoard = (db: Db, shotId: string, role: BoardRole = 'key'): Board | undefined =>
  listBoards(db, shotId).find((b) => b.status === 'approved' && b.role === role);
/**
 * The key storyboard frame a first or last frame keeps its new characters consistent with: the one drawn in the
 * same batch, else the approved key frame, else the latest finished one.
 */
export function keyBoardFor(db: Db, board: Board): Board | undefined {
  if (board.role === 'key') return undefined;
  const keys = listBoards(db, board.shotId).filter((b) => b.role === 'key' && b.path);
  const linked = keys.find((b) => b.id === board.params.consistentWith && b.status !== 'failed');
  const done = keys.filter((b) => ['approved', 'ready'].includes(b.status));
  return linked ?? done.find((b) => b.status === 'approved') ?? done.at(-1);
}

/** The approved storyboard frames of a shot, by moment. */
export const approvedBoards = (db: Db, shotId: string): Partial<Record<BoardRole, Board>> =>
  Object.fromEntries(
    BOARD_ROLES.map((r) => [r, approvedBoard(db, shotId, r)] as const).filter(([, b]) => b),
  ) as Partial<Record<BoardRole, Board>>;
export const approvedTake = (db: Db, shotId: string): Take | undefined =>
  listTakes(db, shotId)
    .filter((t) => t.status === 'approved')
    .at(-1);

interface NewVersion {
  shotId: string;
  prompt: string;
  model: string;
  params?: Record<string, unknown>;
  inputs?: InputRef[];
  parentId?: string | null;
  createdBy: string;
}

function nextVersion(db: Db, table: 'boards' | 'takes', shotId: string): number {
  return (
    (one<{ v: number | null }>(db, `SELECT MAX(version) AS v FROM ${table} WHERE shot_id = :shotId`, {
      shotId,
    })?.v ?? 0) + 1
  );
}

export function createBoard(
  db: Db,
  input: NewVersion & { role?: BoardRole; frame?: number | null },
  now: number = Date.now(),
): Board {
  return tx(db, () => {
    const shot = getShot(db, input.shotId);
    if (shot.mode !== 'replace')
      throw new AniError('conflict', `Boards are only for replace shots (this shot is ${shot.mode})`);
    const id = newId('brd', now);
    const version = nextVersion(db, 'boards', input.shotId);
    run(
      db,
      `INSERT INTO boards (id, shot_id, version, role, frame, status, prompt, model, params_json, inputs_json, parent_id, created_by, created_at)
       VALUES (:id, :shotId, :version, :role, :frame, 'queued', :prompt, :model, :params, :inputs, :parentId, :createdBy, :now)`,
      {
        id,
        shotId: input.shotId,
        version,
        role: input.role ?? 'key',
        frame: input.frame ?? null,
        prompt: input.prompt,
        model: input.model,
        params: toJson(input.params ?? {}),
        inputs: toJson(input.inputs ?? []),
        parentId: input.parentId ?? null,
        createdBy: input.createdBy,
        now,
      },
    );
    const project = projectOfShot(db, input.shotId);
    appendEvent(db, {
      actor: input.createdBy,
      kind: 'board.created',
      entityType: 'board',
      entityId: id,
      projectId: project.id,
      payload: { shotId: input.shotId, version, role: input.role ?? 'key' },
    });
    return getBoard(db, id);
  });
}

export function createTake(
  db: Db,
  input: NewVersion & { boardId?: string | null; tier: GenerationTier },
  { force = false } = {},
  now: number = Date.now(),
): Take {
  return tx(db, () => {
    const shot = getShot(db, input.shotId);
    if (shot.mode !== 'replace' && shot.mode !== 'clean')
      throw new AniError('conflict', `Nothing to generate for a ${shot.mode} shot`);
    if (shot.mode === 'replace' && !input.boardId && !force) {
      throw new AniError('conflict', 'The board for this shot has not been approved yet', {
        hint: 'Approve a board first, or pass --force.',
      });
    }
    const id = newId('tak', now);
    const version = nextVersion(db, 'takes', input.shotId);
    run(
      db,
      `INSERT INTO takes (id, shot_id, version, board_id, tier, status, prompt, model, params_json, inputs_json, parent_id, created_by, created_at)
       VALUES (:id, :shotId, :version, :boardId, :tier, 'queued', :prompt, :model, :params, :inputs, :parentId, :createdBy, :now)`,
      {
        id,
        shotId: input.shotId,
        version,
        boardId: input.boardId ?? null,
        tier: input.tier,
        prompt: input.prompt,
        model: input.model,
        params: toJson(input.params ?? {}),
        inputs: toJson(input.inputs ?? []),
        parentId: input.parentId ?? null,
        createdBy: input.createdBy,
        now,
      },
    );
    const project = projectOfShot(db, input.shotId);
    appendEvent(db, {
      actor: input.createdBy,
      kind: 'take.created',
      entityType: 'take',
      entityId: id,
      projectId: project.id,
      payload: { shotId: input.shotId, version, tier: input.tier },
    });
    return getTake(db, id);
  });
}

export interface VersionPatch {
  status?: VersionStatus;
  /** The director's prompt, references and notes replace the planned ones before generation. */
  prompt?: string;
  params?: Record<string, unknown>;
  path?: string | null;
  inputs?: InputRef[];
  remote?: Record<string, unknown>;
  error?: string | null;
  costUsd?: number;
  framesIn?: number | null;
  framesOut?: number | null;
  conform?: Record<string, unknown>;
}

function patchVersion(
  db: Db,
  table: 'boards' | 'takes',
  id: string,
  patch: VersionPatch,
  actor: string,
): void {
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id };
  const set = (column: string, key: string, value: string | number | null) => {
    sets.push(`${column} = :${key}`);
    params[key] = value;
  };
  if (patch.status !== undefined) set('status', 'status', patch.status);
  if (patch.path !== undefined) set('path', 'path', patch.path);
  if (patch.inputs !== undefined) set('inputs_json', 'inputs', toJson(patch.inputs));
  if (patch.prompt !== undefined) set('prompt', 'prompt', patch.prompt);
  if (patch.params !== undefined) set('params_json', 'params', toJson(patch.params));
  if (patch.remote !== undefined) set('remote_json', 'remote', toJson(patch.remote));
  if (patch.error !== undefined) set('error', 'error', patch.error);
  if (patch.costUsd !== undefined) set('cost_usd', 'cost', patch.costUsd);
  if (table === 'takes') {
    if (patch.framesIn !== undefined) set('frames_in', 'framesIn', patch.framesIn);
    if (patch.framesOut !== undefined) set('frames_out', 'framesOut', patch.framesOut);
    if (patch.conform !== undefined) set('conform_json', 'conform', toJson(patch.conform));
  }
  if (sets.length === 0) return;
  run(db, `UPDATE ${table} SET ${sets.join(', ')} WHERE id = :id`, params);
  const row = one<{ shot_id: string }>(db, `SELECT shot_id FROM ${table} WHERE id = :id`, { id });
  const project = row ? projectOfShot(db, row.shot_id) : undefined;
  appendEvent(db, {
    actor,
    kind: `${table === 'boards' ? 'board' : 'take'}.updated`,
    entityType: table === 'boards' ? 'board' : 'take',
    entityId: id,
    projectId: project?.id ?? null,
    payload: { status: patch.status ?? null, shotId: row?.shot_id ?? null },
  });
}

export const updateBoard = (db: Db, id: string, patch: VersionPatch, actor: string): Board =>
  tx(db, () => {
    patchVersion(db, 'boards', id, patch, actor);
    return getBoard(db, id);
  });

export const updateTake = (db: Db, id: string, patch: VersionPatch, actor: string): Take =>
  tx(db, () => {
    patchVersion(db, 'takes', id, patch, actor);
    return getTake(db, id);
  });

export type Verdict = 'approve' | 'changes' | 'regenerate' | 'keep_original';

/**
 * 拒絕: a storyboard frame or video the human does not want, with nothing more to do about it — it leaves 待評審
 * (an approved one turns rejected too). Recorded in the version's events.
 */
export function rejectVersion(db: Db, id: string, actor: string): Board | Take {
  const isBoard = id.startsWith('brd_');
  const target = isBoard ? getBoard(db, id) : getTake(db, id);
  if (!['ready', 'stale', 'approved'].includes(target.status))
    throw new AniError('conflict', `Only a finished version can be rejected (this one is ${target.status})`);
  return tx(db, () => {
    patchVersion(db, isBoard ? 'boards' : 'takes', id, { status: 'rejected' }, actor);
    return isBoard ? getBoard(db, id) : getTake(db, id);
  });
}

export interface Review {
  id: string;
  targetType: 'board' | 'take' | 'render';
  targetId: string;
  verdict: Verdict;
  comment: string | null;
  annotations: unknown[];
  createdBy: string;
  createdAt: number;
}

/**
 * Records a human verdict and applies it: approve demotes any other approved version of the same shot (for a
 * storyboard frame, of the same moment: first, key or last),
 * changes rejects, keep_original switches the shot to keep. Regeneration is queued by the caller.
 */
export function addReview(
  db: Db,
  input: {
    targetType: 'board' | 'take';
    targetId: string;
    verdict: Verdict;
    comment?: string | null;
    annotations?: unknown[];
    createdBy: string;
  },
  now: number = Date.now(),
): Review {
  return tx(db, () => {
    const target = input.targetType === 'board' ? getBoard(db, input.targetId) : getTake(db, input.targetId);
    if (input.verdict === 'approve') {
      // A stale version can still be approved: the human decides whether the change actually matters.
      if (!['ready', 'approved', 'stale'].includes(target.status))
        throw new AniError(
          'conflict',
          `Only a finished version can be approved (this one is ${target.status})`,
        );
      if (input.createdBy.startsWith('codex:'))
        throw new AniError('conflict', 'Approval is a human decision; Codex can recommend but not approve');
      const table = input.targetType === 'board' ? 'boards' : 'takes';
      const sameKind = input.targetType === 'take' ? 'AND tier = :tier' : 'AND role = :role';
      run(
        db,
        `UPDATE ${table} SET status = 'ready' WHERE shot_id = :shotId AND status = 'approved' AND id != :id ${sameKind}`,
        {
          shotId: target.shotId,
          id: target.id,
          ...(input.targetType === 'take'
            ? { tier: (target as Take).tier }
            : { role: (target as Board).role }),
        },
      );
      patchVersion(db, table, target.id, { status: 'approved' }, input.createdBy);
    } else if (input.verdict === 'changes') {
      if (!input.comment?.trim()) throw new AniError('usage', 'Requesting changes needs a comment');
      patchVersion(
        db,
        input.targetType === 'board' ? 'boards' : 'takes',
        target.id,
        { status: 'rejected' },
        input.createdBy,
      );
    } else if (input.verdict === 'keep_original') {
      updateShot(db, target.shotId, { mode: 'keep' }, input.createdBy);
    }
    const id = newId('rev', now);
    run(
      db,
      `INSERT INTO reviews (id, target_type, target_id, verdict, comment, annotations_json, created_by, created_at)
       VALUES (:id, :targetType, :targetId, :verdict, :comment, :annotations, :createdBy, :now)`,
      {
        id,
        targetType: input.targetType,
        targetId: input.targetId,
        verdict: input.verdict,
        comment: input.comment ?? null,
        annotations: toJson(input.annotations ?? []),
        createdBy: input.createdBy,
        now,
      },
    );
    const project = projectOfShot(db, target.shotId);
    appendEvent(db, {
      actor: input.createdBy,
      kind: 'review.created',
      entityType: input.targetType,
      entityId: input.targetId,
      projectId: project.id,
      payload: { reviewId: id, verdict: input.verdict, shotId: target.shotId },
    });
    return getReview(db, id);
  });
}

export function getReview(db: Db, id: string): Review {
  const r = one<{
    id: string;
    target_type: Review['targetType'];
    target_id: string;
    verdict: Verdict;
    comment: string | null;
    annotations_json: string;
    created_by: string;
    created_at: number;
  }>(db, 'SELECT * FROM reviews WHERE id = :id', { id });
  if (!r) throw new AniError('not_found', `Review not found: ${id}`);
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    verdict: r.verdict,
    comment: r.comment,
    annotations: fromJson(r.annotations_json, []),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export function listReviews(db: Db, targetId: string): Review[] {
  return all<{ id: string }>(db, 'SELECT id FROM reviews WHERE target_id = :targetId ORDER BY created_at', {
    targetId,
  }).map((r) => getReview(db, r.id));
}

export type ShotStage =
  | 'keep'
  | 'excluded'
  | 'board_pending'
  | 'board_generating'
  | 'board_review'
  | 'take_pending'
  | 'take_generating'
  | 'take_review'
  | 'approved'
  | 'failed'
  | 'stale';

/** Where a shot is in the pipeline, derived from its mode and latest versions (design §6). */
export function shotStage(db: Db, shotId: string, tier: GenerationTier): ShotStage {
  const shot = getShot(db, shotId);
  if (shot.mode === 'keep') return 'keep';
  if (shot.mode === 'exclude') return 'excluded';
  const takes = listTakes(db, shotId);
  const tierTakes = takes.filter((t) => t.tier === tier);
  if (tierTakes.some((t) => t.status === 'approved')) return 'approved';
  const latestTake = tierTakes.at(-1);
  if (latestTake && ['queued', 'generating'].includes(latestTake.status)) return 'take_generating';
  if (latestTake?.status === 'ready') return 'take_review';
  if (latestTake?.status === 'failed') return 'failed';
  if (shot.mode === 'replace') {
    // The video waits for the key frame's storyboard; the first and last frames help when they are approved too.
    const boards = listBoards(db, shotId);
    if (!boards.some((b) => b.status === 'approved' && b.role === 'key')) {
      const latest = BOARD_ROLES.map((r) => boards.filter((b) => b.role === r).at(-1)).filter(
        (b): b is Board => Boolean(b),
      );
      if (!latest.length) return 'board_pending';
      if (latest.some((b) => ['queued', 'generating'].includes(b.status))) return 'board_generating';
      if (latest.some((b) => b.status === 'ready')) return 'board_review';
      const key = latest.find((b) => b.role === 'key');
      if (key?.status === 'failed') return 'failed';
      if (key?.status === 'stale') return 'stale';
      return 'board_pending';
    }
  }
  if (latestTake?.status === 'stale' || takes.at(-1)?.status === 'stale') return 'stale';
  return 'take_pending';
}

export interface Render {
  id: string;
  projectId: string;
  version: number;
  kind: 'draft' | 'final';
  tier: GenerationTier;
  status: 'queued' | 'rendering' | 'ready' | 'failed';
  path: string | null;
  comparePath: string | null;
  compareProxyPath: string | null;
  shots: Array<{ shotId: string; source: 'take' | 'original'; takeId?: string }>;
  error: string | null;
  createdAt: number;
}

interface RenderRow {
  id: string;
  project_id: string;
  version: number;
  kind: Render['kind'];
  tier: GenerationTier;
  status: Render['status'];
  path: string | null;
  compare_path: string | null;
  compare_proxy_path: string | null;
  shots_snapshot_json: string;
  error: string | null;
  created_at: number;
}

const toRender = (r: RenderRow): Render => ({
  id: r.id,
  projectId: r.project_id,
  version: r.version,
  kind: r.kind,
  tier: r.tier,
  status: r.status,
  path: r.path,
  comparePath: r.compare_path,
  compareProxyPath: r.compare_proxy_path,
  shots: fromJson(r.shots_snapshot_json, []),
  error: r.error,
  createdAt: r.created_at,
});

export function getRender(db: Db, id: string): Render {
  const row = one<RenderRow>(db, 'SELECT * FROM renders WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Render not found: ${id}`);
  return toRender(row);
}

export const listRenders = (db: Db, projectId: string): Render[] =>
  all<RenderRow>(db, 'SELECT * FROM renders WHERE project_id = :projectId ORDER BY version DESC', {
    projectId,
  }).map(toRender);

export function createRender(
  db: Db,
  input: { projectId: string; kind: Render['kind']; tier: GenerationTier; createdBy: string },
  now: number = Date.now(),
): Render {
  return tx(db, () => {
    const version =
      (one<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM renders WHERE project_id = :p', {
        p: input.projectId,
      })?.v ?? 0) + 1;
    const id = newId('rnd', now);
    run(
      db,
      `INSERT INTO renders (id, project_id, version, kind, tier, status, created_at) VALUES (:id, :projectId, :version, :kind, :tier, 'queued', :now)`,
      {
        id,
        projectId: input.projectId,
        version,
        kind: input.kind,
        tier: input.tier,
        now,
      },
    );
    appendEvent(db, {
      actor: input.createdBy,
      kind: 'render.created',
      entityType: 'render',
      entityId: id,
      projectId: input.projectId,
      payload: { version, kind: input.kind, tier: input.tier },
    });
    return getRender(db, id);
  });
}

/** Removes a render's row (its files are the caller's): superseded automatic drafts. */
export function deleteRender(db: Db, id: string, actor: string): void {
  tx(db, () => {
    const r = getRender(db, id);
    run(db, 'DELETE FROM renders WHERE id = :id', { id });
    appendEvent(db, {
      actor,
      kind: 'render.deleted',
      entityType: 'render',
      entityId: id,
      projectId: r.projectId,
      payload: { version: r.version, kind: r.kind },
    });
  });
}

export function updateRender(
  db: Db,
  id: string,
  patch: Partial<Pick<Render, 'status' | 'path' | 'comparePath' | 'compareProxyPath' | 'shots' | 'error'>>,
  actor: string,
): Render {
  return tx(db, () => {
    const cur = getRender(db, id);
    run(
      db,
      `UPDATE renders SET status = :status, path = :path, compare_path = :comparePath, compare_proxy_path = :compareProxyPath,
         shots_snapshot_json = :shots, error = :error WHERE id = :id`,
      {
        id,
        status: patch.status ?? cur.status,
        path: patch.path ?? cur.path,
        comparePath: patch.comparePath ?? cur.comparePath,
        compareProxyPath: patch.compareProxyPath ?? cur.compareProxyPath,
        shots: toJson(patch.shots ?? cur.shots),
        error: patch.error === undefined ? cur.error : patch.error,
      },
    );
    appendEvent(db, {
      actor,
      kind: 'render.updated',
      entityType: 'render',
      entityId: id,
      projectId: cur.projectId,
      payload: { status: patch.status ?? cur.status },
    });
    return getRender(db, id);
  });
}
