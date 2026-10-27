import { AniError, newId, videoModelSpec } from '@anirecast/shared';
import { loadConfig } from '../config.ts';
import { all, fromJson, one } from '../db.ts';
import { enqueueJob } from '../jobs.ts';
import { assertNotBlockedOut, assertQuota } from '../quota.ts';
import type { Workspace } from '../workspace.ts';
import { createAgentTask, getAgentTask, listAgentTasks, routeOf } from './agent-tasks.ts';
import { attachToPlan, checkAttachments } from './attachments.ts';
import { getCastMember, listCast, shotCast } from './cast.ts';
import { markCastAnalysisQueued } from './cast-analysis.ts';
import type { TaskAgent } from './claude.ts';
import { findActiveClip, getClip } from './clips.ts';
import { findCodexThread } from './codex.ts';
import {
  approvedDesign,
  type Binding,
  createDesign,
  DESIGN_KINDS,
  type DesignKind,
  getDesign,
  projectBindings,
  resolveBindings,
  reviewDesign,
} from './designs.ts';
import {
  addReview,
  approvedBoard,
  BOARD_ROLES,
  type BoardRole,
  createBoard,
  createRender,
  createTake,
  getBoard,
  getTake,
  listBoards,
  listRenders,
  listReviews,
  listTakes,
  shotStage,
  type Verdict,
} from './generation.ts';
import { assertSelectableModel, projectModels } from './models.ts';
import { markShotGenerationStale, recomputeShotModes } from './modes.ts';
import { listTextOverlays } from './overlays.ts';
import { getPersona } from './personas.ts';
import { type FrameRange, planBoard, planDesign, planOriginalDesign, planTake, sha256File } from './plan.ts';
import { type GenerationTier, getProject, listProjects } from './projects.ts';
import { getShot, listKeyframes, listShots, projectOfShot } from './shots.ts';
import { getSource } from './sources.ts';

/** Use cases shared by the CLI and the HTTP API, so both behave identically. */

export function queueBoard(
  ws: Workspace,
  shotId: string,
  actor: string,
  opts: {
    extra?: string;
    fromBoardId?: string;
    model?: string;
    role?: BoardRole;
    attachments?: string[];
    /** The key frame drawn in the same batch, which this first or last frame waits for and matches. */
    consistentWith?: string;
    /** Extra bookkeeping kept on the board (a 生成全部分鏡圖 batch and its follow-ups). */
    params?: Record<string, unknown>;
    /** Draw a first or last frame even where detection saw nobody to replace. */
    force?: boolean;
  } = {},
) {
  const { model: chosen, attachments, consistentWith, params: extraParams, ...planOpts } = opts;
  const projectId = projectOfShot(ws.db, shotId).id;
  // A revision keeps the images attached to the version it revises.
  const prior = opts.fromBoardId
    ? ((getBoard(ws.db, opts.fromBoardId).params.attachments as string[]) ?? [])
    : [];
  const plan = attachToPlan(
    planBoard(ws, shotId, planOpts),
    [...prior, ...checkAttachments(ws, projectId, attachments)],
    'image',
  );
  const board = createBoard(ws.db, {
    shotId,
    role: plan.role,
    frame: plan.frame,
    prompt: plan.prompt,
    model: chosen ?? projectModels(ws.db, projectOfShot(ws.db, shotId).id).image,
    params: { ...plan.params, ...(consistentWith ? { consistentWith } : {}), ...(extraParams ?? {}) },
    inputs: plan.inputs,
    parentId: opts.fromBoardId ?? null,
    createdBy: actor,
  });
  const job = enqueueJob(ws.db, {
    type: 'board.generate',
    lane: 'generate',
    projectId: projectOfShot(ws.db, shotId).id,
    payload: { boardId: board.id },
    requestedBy: actor,
    // Network hiccups to fal / Google are transient: a storyboard frame gets three tries.
    maxAttempts: 3,
  });
  return { board, job };
}

/**
 * 生成全部分鏡圖: the key frame of every replace shot that has none yet. When a key frame is drawn, JEV compares the
 * shot's first and last frames with it and only the ones that differ enough get their own storyboard frame (drawn
 * from the key frame for consistency); when the whole batch is done, Codex reviews it (boards_review).
 */
export function queueAllBoards(
  ws: Workspace,
  projectRef: string,
  actor: string,
  opts: { model?: string } = {},
) {
  const project = getProject(ws.db, projectRef);
  const clip = findActiveClip(ws.db, project.id);
  if (!clip) throw new AniError('conflict', 'Project has no clip');
  const batch = newId('bat');
  const queued: Array<ReturnType<typeof queueBoard>> = [];
  const skipped: Array<{ shotId: string; shotNo: number; reason: string }> = [];
  for (const shot of listShots(ws.db, clip.id).filter((s) => s.mode === 'replace')) {
    const live = listBoards(ws.db, shot.id).find(
      (b) => b.role === 'key' && ['queued', 'generating', 'ready', 'approved'].includes(b.status),
    );
    const no = shot.orderIndex + 1;
    if (live) {
      skipped.push({
        shotId: shot.id,
        shotNo: no,
        reason: live.status === 'approved' ? '關鍵幀已通過' : '已經有關鍵幀',
      });
      continue;
    }
    try {
      queued.push(
        queueBoard(ws, shot.id, actor, {
          role: 'key',
          ...(opts.model ? { model: opts.model } : {}),
          params: { batch, followUps: ['first', 'last'] },
        }),
      );
    } catch (error) {
      skipped.push({
        shotId: shot.id,
        shotNo: no,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { batch, queued, skipped };
}

/**
 * 生成分鏡圖: the shot's three storyboard frames — first, key and last. A first or last frame where nobody to
 * replace is seen is skipped (and said so); the key frame is required.
 */
export function queueBoards(
  ws: Workspace,
  shotId: string,
  actor: string,
  opts: { extra?: string; model?: string; roles?: readonly BoardRole[]; attachments?: string[] } = {},
) {
  const { roles = BOARD_ROLES, ...rest } = opts;
  const boards: Array<ReturnType<typeof queueBoard>> = [];
  const skipped: Array<{ role: BoardRole; reason: string }> = [];
  // The key frame first; the first and last frames wait for it and keep the new characters identical to it.
  const ordered = [...roles].sort((a, b) => Number(b === 'key') - Number(a === 'key'));
  let key: string | undefined;
  for (const role of ordered) {
    try {
      const q = queueBoard(ws, shotId, actor, { ...rest, role, ...(key ? { consistentWith: key } : {}) });
      if (role === 'key') key = q.board.id;
      boards.push(q);
    } catch (error) {
      if (role === 'key' || !(error instanceof AniError) || error.code !== 'conflict') throw error;
      skipped.push({ role, reason: error.message });
    }
  }
  return { boards, skipped };
}

export function queueTake(
  ws: Workspace,
  shotId: string,
  tier: GenerationTier,
  actor: string,
  opts: {
    extra?: string;
    fromTakeId?: string;
    force?: boolean;
    retryBlocked?: boolean;
    model?: string;
    attachments?: string[];
    /** Redo only these frames of the shot (0 = its first); the others are kept from `keepFrom`. */
    range?: FrameRange;
    keepFrom?: string;
    /** Which kept frames beside the part the director sees (`none` when the neighbours are being redone too). */
    seams?: PartSeams;
  } = {},
) {
  const config = loadConfig();
  const projectId = projectOfShot(ws.db, shotId).id;
  const model = opts.model ?? projectModels(ws.db, projectId).video;
  const part = opts.range
    ? {
        ...partialTake(ws, shotId, tier, opts.range, opts.keepFrom),
        ...(opts.seams && opts.seams !== 'both' ? { seams: opts.seams } : {}),
      }
    : undefined;
  const attached = checkAttachments(ws, projectId, opts.attachments);
  assertNotBlockedOut(ws.db, config, shotId, opts.retryBlocked);
  if (config.provider !== 'fake' && process.env.ANIRECAST_PROVIDER !== 'fake')
    assertQuota(ws.db, config, model, 1, { includePending: true });
  const prior = opts.fromTakeId
    ? ((getTake(ws.db, opts.fromTakeId).params.attachments as string[]) ?? [])
    : [];
  const plan = attachToPlan(
    planTake(ws, shotId, tier, { ...opts, model, ...(opts.range ? { range: opts.range } : {}) }),
    [...prior, ...attached],
    'video',
    videoModelSpec(model).maxRefs,
  );
  const take = createTake(
    ws.db,
    {
      shotId,
      tier,
      boardId: plan.boardId,
      prompt: plan.prompt,
      model,
      params: part ? { ...plan.params, ...part } : plan.params,
      inputs: plan.inputs,
      parentId: opts.fromTakeId ?? null,
      createdBy: actor,
    },
    { force: Boolean(opts.force) },
  );
  const job = enqueueJob(ws.db, {
    type: 'take.generate',
    lane: 'generate',
    projectId: projectOfShot(ws.db, shotId).id,
    payload: { takeId: take.id },
    requestedBy: actor,
    maxAttempts: 2,
  });
  return { take, job };
}

/**
 * 逐格重繪: redo frames start–end of a shot by redrawing each drawing with the image model (held frames share one),
 * then put them in place of those frames of `keepFrom`. For rapid cuts, flashes and graphic montages, where a video
 * model smooths the picture over; costs one image per drawing.
 */
export function queueFramesTake(
  ws: Workspace,
  shotId: string,
  opts: { range: FrameRange; keepFrom: string; extra?: string; model?: string },
  actor: string,
) {
  const keep = getTake(ws.db, opts.keepFrom);
  const part = partialTake(ws, shotId, keep.tier, opts.range, opts.keepFrom);
  const projectId = projectOfShot(ws.db, shotId).id;
  const imageModel = opts.model ?? projectModels(ws.db, projectId).image;
  assertSelectableModel('image', imageModel);
  const extra = opts.extra?.trim();
  const take = createTake(
    ws.db,
    {
      shotId,
      tier: keep.tier,
      boardId: keep.boardId,
      prompt: `Frame by frame with ${imageModel}: frames ${part.range.start}–${part.range.end} redrawn one drawing at a time; the rest kept from v${keep.version}.${extra ? `\nAdditional instructions: ${extra}` : ''}`,
      model: `frames:${imageModel}`,
      params: { tier: keep.tier, ...part, method: 'frames', imageModel, ...(extra ? { extra } : {}) },
      inputs: [],
      parentId: keep.id,
      createdBy: actor,
    },
    { force: true },
  );
  const job = enqueueJob(ws.db, {
    type: 'take.frames',
    lane: 'generate',
    projectId,
    payload: { takeId: take.id },
    requestedBy: actor,
    // Each image is paid once: a failed run is looked at, not repeated.
    maxAttempts: 1,
  });
  return { take, job };
}

/** Kept frames beside a part that the director is shown. */
export type PartSeams = 'both' | 'before' | 'after' | 'none';
export const PART_SEAMS: readonly PartSeams[] = ['both', 'before', 'after', 'none'];

/**
 * One take from a base and partial takes made from it side by side: each part's frames from its take, every other
 * frame from the base. No model, no cost — parts of a shot can be generated in parallel and joined here.
 */
export function queueTakeMerge(ws: Workspace, baseTakeId: string, partTakeIds: string[], actor: string) {
  const base = getTake(ws.db, baseTakeId);
  if (!base.path || !['ready', 'approved', 'rejected', 'stale'].includes(base.status))
    throw new AniError('conflict', `Take v${base.version} has no finished video to join onto`);
  if (!partTakeIds.length) throw new AniError('usage', 'Name the partial takes to join');
  const parts = partTakeIds
    .map((id) => getTake(ws.db, id))
    .map((t) => {
      const range = t.params.range as FrameRange | undefined;
      if (t.shotId !== base.shotId) throw new AniError('usage', `Take ${t.id} is not a take of this shot`);
      if (!range) throw new AniError('usage', `Take v${t.version} is not a partial take (no --range)`);
      if (!t.path || !['ready', 'approved', 'rejected'].includes(t.status))
        throw new AniError('conflict', `Take v${t.version} has no finished video`);
      if (t.tier !== base.tier)
        throw new AniError('usage', `Take v${t.version} is ${t.tier}, the base is ${base.tier}`);
      return { from: t.id, version: t.version, range };
    })
    .sort((a, b) => a.range.start - b.range.start);
  for (const [i, p] of parts.entries()) {
    const next = parts[i + 1];
    if (next && next.range.start <= p.range.end)
      throw new AniError(
        'usage',
        `Parts v${p.version} (${p.range.start}–${p.range.end}) and v${next.version} (${next.range.start}–${next.range.end}) overlap`,
      );
  }
  const take = createTake(
    ws.db,
    {
      shotId: base.shotId,
      tier: base.tier,
      boardId: base.boardId,
      prompt: `Joined: v${base.version} with ${parts.map((p) => `frames ${p.range.start}–${p.range.end} of v${p.version}`).join(', ')}.`,
      model: base.model,
      params: {
        tier: base.tier,
        keepFrom: base.id,
        merged: parts.map(({ from, range }) => ({ from, range })),
      },
      inputs: [],
      parentId: base.id,
      createdBy: actor,
    },
    { force: true },
  );
  const job = enqueueJob(ws.db, {
    type: 'take.merge',
    lane: 'media',
    projectId: projectOfShot(ws.db, base.shotId).id,
    payload: { takeId: take.id },
    requestedBy: actor,
  });
  return { take, job };
}

/**
 * A take that redoes only some frames of a shot and keeps the others from an earlier take (the human approved
 * most of it): the range must be a real part of the shot, and the kept take a finished video of the same size.
 */
function partialTake(
  ws: Workspace,
  shotId: string,
  tier: GenerationTier,
  range: FrameRange,
  keepFrom: string | undefined,
): { range: FrameRange; keepFrom: string } {
  const shot = getShot(ws.db, shotId);
  const { start, end } = range;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end >= shot.frameCount
  )
    throw new AniError(
      'usage',
      `Frames ${start}–${end} are not inside shot ${shot.orderIndex + 1} (0–${shot.frameCount - 1})`,
    );
  if (start === 0 && end === shot.frameCount - 1)
    throw new AniError('usage', 'That is the whole shot: generate it without a range');
  if (!keepFrom)
    throw new AniError('usage', 'A range needs the take whose other frames are kept', {
      hint: 'Pass --keep <take>.',
    });
  const keep = getTake(ws.db, keepFrom);
  if (keep.shotId !== shotId) throw new AniError('usage', `Take ${keepFrom} is not a take of this shot`);
  if (!keep.path || !['ready', 'approved', 'rejected', 'stale'].includes(keep.status))
    throw new AniError('conflict', `Take v${keep.version} has no finished video to keep frames from`);
  if (keep.tier !== tier)
    throw new AniError('usage', `Take v${keep.version} is ${keep.tier}; the new part must be the same tier`);
  return { range: { start, end }, keepFrom: keep.id };
}

/**
 * Queues design sheets (all three when `kind` is omitted) for the bindings `ref` names: an original character
 * (cast id or label), or a library character (every original bound to it). `fromDesignId` revises that sheet.
 */
export function queueDesign(
  ws: Workspace,
  projectRef: string,
  ref: string | null,
  actor: string,
  opts: {
    kind?: DesignKind;
    extra?: string;
    fromDesignId?: string;
    model?: string;
    attachments?: string[];
  } = {},
) {
  const project = getProject(ws.db, projectRef);
  const from = opts.fromDesignId ? getDesign(ws.db, opts.fromDesignId) : undefined;
  const attached = [
    ...((from?.params.attachments as string[] | undefined) ?? []),
    ...checkAttachments(ws, project.id, opts.attachments),
  ];
  // Revising an original character's own sheet stays on her sheets.
  if (from?.subject === 'original' && from.castMemberId)
    return queueOriginalDesign(ws, project.id, from.castMemberId, actor, { ...opts, kind: from.kind });
  const designModel = opts.model ?? projectModels(ws.db, project.id).design;
  const bindings: Binding[] = from
    ? from.castMemberId && from.personaId
      ? [{ castMemberId: from.castMemberId, personaId: from.personaId }]
      : resolveBindings(ws.db, project.id, from.personaId ?? '').slice(0, 1)
    : ref
      ? resolveBindings(ws.db, project.id, ref)
      : projectBindings(ws.db, project.id);
  if (!bindings.length)
    throw new AniError('conflict', 'No original character is bound to a library character yet');
  const kinds = from ? [from.kind] : opts.kind ? [opts.kind] : [...DESIGN_KINDS];
  return bindings.flatMap((binding) =>
    kinds.map((kind) => {
      const plan = attachToPlan(
        planDesign(ws, project.id, binding, kind, {
          ...(opts.extra ? { extra: opts.extra } : {}),
          ...(from ? { fromDesignId: from.id } : {}),
        }),
        attached,
        'image',
      );
      const design = createDesign(ws.db, {
        projectId: project.id,
        castMemberId: binding.castMemberId,
        personaId: binding.personaId,
        kind,
        prompt: plan.prompt,
        model: designModel,
        params: plan.params,
        inputs: plan.inputs,
        parentId: from?.id ?? null,
        createdBy: actor,
      });
      const job = enqueueJob(ws.db, {
        type: 'design.generate',
        lane: 'generate',
        projectId: project.id,
        payload: { designId: design.id },
        requestedBy: actor,
        maxAttempts: 2,
      });
      return { design, job };
    }),
  );
}

/**
 * Queues the original character's own sheets (官方設定集; all three when `kind` is omitted), drawn from the
 * official art the human accepted and from how the opening draws her. `fromDesignId` revises one.
 */
export function queueOriginalDesign(
  ws: Workspace,
  projectRef: string,
  castId: string,
  actor: string,
  opts: {
    kind?: DesignKind;
    extra?: string;
    fromDesignId?: string;
    model?: string;
    attachments?: string[];
  } = {},
) {
  const project = getProject(ws.db, projectRef);
  const cast = getCastMember(ws.db, castId);
  if (cast.projectId !== project.id) throw new AniError('usage', `${castId} belongs to another project`);
  const from = opts.fromDesignId ? getDesign(ws.db, opts.fromDesignId) : undefined;
  const attached = [
    ...((from?.params.attachments as string[] | undefined) ?? []),
    ...checkAttachments(ws, project.id, opts.attachments),
  ];
  const kinds = from ? [from.kind] : opts.kind ? [opts.kind] : [...DESIGN_KINDS];
  const designModel = opts.model ?? projectModels(ws.db, project.id).design;
  return kinds.map((kind) => {
    const plan = attachToPlan(
      planOriginalDesign(ws, project.id, cast.id, kind, {
        ...(opts.extra ? { extra: opts.extra } : {}),
        ...(from ? { fromDesignId: from.id } : {}),
      }),
      attached,
      'image',
    );
    const design = createDesign(ws.db, {
      projectId: project.id,
      castMemberId: cast.id,
      personaId: null,
      subject: 'original',
      kind,
      prompt: plan.prompt,
      model: designModel,
      params: plan.params,
      inputs: plan.inputs,
      parentId: from?.id ?? null,
      createdBy: actor,
    });
    const job = enqueueJob(ws.db, {
      type: 'design.generate',
      lane: 'generate',
      projectId: project.id,
      payload: { designId: design.id },
      requestedBy: actor,
      maxAttempts: 2,
    });
    return { design, job };
  });
}

/** 用 Agent 搜尋官方設定集 for one original character (web search, scrape, vision check; a person accepts). */
export function queueReferenceSearch(ws: Workspace, projectRef: string, castId: string, actor: string) {
  const project = getProject(ws.db, projectRef);
  const cast = getCastMember(ws.db, castId);
  if (cast.projectId !== project.id) throw new AniError('usage', `${castId} belongs to another project`);
  return enqueueJob(ws.db, {
    type: 'design.references',
    lane: 'generate',
    projectId: project.id,
    payload: { castMemberId: cast.id },
    requestedBy: actor,
    maxAttempts: 1,
  });
}

/**
 * 找出這一鏡的角色: detect the people of one shot (when it has none yet), let the vision model say which of the
 * project's characters each one is, and assign them unlocked for the human to confirm in 替換角色.
 */
export function queueShotCast(ws: Workspace, shotId: string, actor: string) {
  const shot = getShot(ws.db, shotId);
  return enqueueJob(ws.db, {
    type: 'shot.cast',
    lane: 'media',
    projectId: projectOfShot(ws.db, shot.id).id,
    payload: { shotId: shot.id },
    requestedBy: actor,
    maxAttempts: 1,
  });
}

/**
 * 預覽提示詞: the video director's decision for a shot (instruction, images to send) without making the video.
 */
export function queueTakePlan(
  ws: Workspace,
  shotId: string,
  actor: string,
  opts: {
    model?: string;
    extra?: string;
    attachments?: string[];
    range?: FrameRange;
    keepFrom?: string;
    seams?: PartSeams;
  } = {},
) {
  const shot = getShot(ws.db, shotId);
  if (shot.mode !== 'replace')
    throw new AniError('conflict', 'Only a replace shot has a video director plan');
  const attachments = checkAttachments(ws, projectOfShot(ws.db, shot.id).id, opts.attachments);
  const part = opts.range
    ? partialTake(
        ws,
        shot.id,
        opts.keepFrom ? getTake(ws.db, opts.keepFrom).tier : 'final',
        opts.range,
        opts.keepFrom,
      )
    : undefined;
  return enqueueJob(ws.db, {
    type: 'take.plan',
    lane: 'generate',
    projectId: projectOfShot(ws.db, shot.id).id,
    payload: {
      shotId: shot.id,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(part ?? {}),
      ...(part && opts.seams && opts.seams !== 'both' ? { seams: opts.seams } : {}),
    },
    requestedBy: actor,
    maxAttempts: 1,
  });
}

/** The latest job of one type for a shot, with its result. */
export function latestShotJob<T>(ws: Workspace, shotId: string, type: string): ShotJob<T> | null {
  const row = one<{
    id: string;
    status: string;
    result_json: string | null;
    error_json: string | null;
    created_at: number;
    finished_at: number | null;
  }>(
    ws.db,
    `SELECT id, status, result_json, error_json, created_at, finished_at FROM jobs
     WHERE type = :type AND json_extract(payload_json, '$.shotId') = :shotId
     ORDER BY created_at DESC LIMIT 1`,
    { shotId, type },
  );
  if (!row) return null;
  return {
    jobId: row.id,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    result: fromJson<T | null>(row.result_json, null),
    error: fromJson<{ message?: string } | null>(row.error_json, null)?.message ?? null,
  };
}

/** The latest 找出這一鏡的角色 run of a shot: what the vision model said about each person. */
export const latestShotCastCheck = (ws: Workspace, shotId: string): ShotCastCheck | null =>
  latestShotJob<ShotCastResult>(ws, shotId, 'shot.cast');

/** The latest 預覽提示詞 of a shot. */
export interface TakePlanResult {
  model: string;
  prompt: string;
  inputs: Array<{ role: string; path: string }>;
  director: {
    model: string;
    notes: string;
    analysis: Record<string, string>;
    references: Array<{ id: string; label: string; path: string }>;
    costUsd: number;
  };
}

/** One person of the shot as the vision model saw them. */
export interface ShotCastVerdict {
  trackletId: string;
  /** character: one of the project's characters (castId); new: a character not among them; none: not a character. */
  kind: 'character' | 'new' | 'none';
  castId: string | null;
  label: string | null;
  confidence: number;
  reason: string;
  /** Assigned as the model said (false when the human had already decided this person, or it changed nothing). */
  applied: boolean;
  locked: boolean;
}

export interface ShotCastResult {
  detected: number;
  people: ShotCastVerdict[];
  /** Characters the model sees in the frames that detection did not box (reported only). */
  missed: Array<{ castId: string | null; label: string; reason: string }>;
}

export interface ShotJob<T> {
  jobId: string;
  status: string;
  createdAt: number;
  finishedAt: number | null;
  result: T | null;
  error: string | null;
}

export type ShotCastCheck = ShotJob<ShotCastResult>;

/**
 * Queues 原片分析 for the bindings `ref` names (all when null): what the original character looks like and does
 * in the clip. With `thenKinds`, the design sheets are queued once the analysis is in.
 */
export function queueCastAnalysis(
  ws: Workspace,
  projectRef: string,
  ref: string | null,
  actor: string,
  opts: { thenKinds?: DesignKind[]; model?: string } = {},
) {
  const project = getProject(ws.db, projectRef);
  const bindings = ref ? resolveBindings(ws.db, project.id, ref) : projectBindings(ws.db, project.id);
  if (!bindings.length)
    throw new AniError('conflict', 'No original character is bound to a library character yet');
  return bindings.map((b) => {
    markCastAnalysisQueued(ws.db, b.castMemberId, actor);
    return enqueueJob(ws.db, {
      type: 'design.analyze',
      lane: 'generate',
      projectId: project.id,
      payload: {
        castMemberId: b.castMemberId,
        thenKinds: opts.thenKinds ?? [],
        actor,
        ...(opts.model ? { model: opts.model } : {}),
      },
      requestedBy: actor,
      maxAttempts: 2,
    });
  });
}

/** 畫風與光影分析: the anime's drawing style for every prompt, and each generated shot's lighting. */
export function queueStyleAnalysis(
  ws: Workspace,
  projectRef: string,
  actor: string,
  opts: { relight?: boolean } = {},
) {
  const project = getProject(ws.db, projectRef);
  return enqueueJob(ws.db, {
    type: 'project.style',
    lane: 'generate',
    projectId: project.id,
    payload: { projectId: project.id, relight: Boolean(opts.relight) },
    requestedBy: actor,
    maxAttempts: 2,
  });
}

/** `model` of takes made from a still board, so they are told apart from video-model takes. */
export const STILL_TAKE_MODEL = 'still';

/**
 * A take that holds the approved board for the length of the shot, for shots the video model will not do.
 * No model, no request, no cost; it renders like any other take. `boardId` holds that board instead — one the
 * human named, even if they sent it back with "make a still of it" (the take is still theirs to approve).
 */
export function queueStillTake(
  ws: Workspace,
  shotId: string,
  tier: GenerationTier,
  actor: string,
  opts: { boardId?: string } = {},
) {
  const named = opts.boardId ? getBoard(ws.db, opts.boardId) : undefined;
  if (named && named.shotId !== shotId)
    throw new AniError('usage', `Board ${named.id} belongs to another shot`);
  if (named && !['ready', 'approved', 'rejected', 'stale'].includes(named.status))
    throw new AniError('conflict', `Only a finished board can be held (this one is ${named.status})`);
  const board = named ?? approvedBoard(ws.db, shotId);
  if (!board?.path)
    throw new AniError('conflict', 'A still take needs an approved board', {
      hint: 'Approve the board first, or name the board to hold (--board).',
    });
  const take = createTake(ws.db, {
    shotId,
    tier,
    boardId: board.id,
    prompt: named
      ? `Still: board ${board.role} v${board.version} held for the length of the shot (no video model).`
      : 'Still: the approved board held for the length of the shot (no video model).',
    model: STILL_TAKE_MODEL,
    params: { tier, still: true },
    inputs: [{ role: 'board', path: board.path, sha256: sha256File(ws.abs(board.path)) }],
    createdBy: actor,
  });
  const job = enqueueJob(ws.db, {
    type: 'take.still',
    lane: 'media',
    projectId: projectOfShot(ws.db, shotId).id,
    payload: { takeId: take.id },
    requestedBy: actor,
  });
  return { take, job };
}

/**
 * Review of a design sheet: approve, request changes (Codex revises it) or regenerate with the same inputs — on its
 * own model unless another is asked for.
 */
function submitDesignReview(
  ws: Workspace,
  input: {
    targetId: string;
    verdict: Verdict;
    comment?: string | null;
    model?: string | null;
    annotations?: unknown[];
    agent?: TaskAgent;
    actor: string;
  },
) {
  const design = getDesign(ws.db, input.targetId);
  const review = reviewDesign(ws.db, {
    designId: design.id,
    verdict: input.verdict,
    comment: input.comment ?? null,
    createdBy: input.actor,
  });
  if (input.verdict === 'approve' && design.subject === 'replacement') {
    // A newly approved turnaround changes what boards and takes use: stale the shots that show this character.
    const shots = design.castMemberId
      ? getCastMember(ws.db, design.castMemberId).shotIds
      : listShotsOfPersona(ws.db, design.projectId, design.personaId ?? '');
    for (const id of shots) markShotGenerationStale(ws.db, id, 'character design approved', input.actor);
  }
  if (input.verdict === 'changes') {
    const task = createAgentTask(ws.db, {
      kind: 'review_feedback',
      projectId: design.projectId,
      reviewId: review.id,
      payload: {
        targetType: 'design',
        targetId: design.id,
        comment: input.comment,
        annotations: input.annotations ?? [],
        ...(input.agent && input.agent !== 'auto' ? { agent: input.agent } : {}),
      },
      createdBy: input.actor,
    });
    return { review, task };
  }
  if (input.verdict === 'regenerate') {
    const [queued] = queueDesign(ws, design.projectId, null, input.actor, {
      fromDesignId: design.id,
      model: input.model ?? design.model,
    });
    return { review, queued: { design: queued!.design, jobId: queued!.job.id } };
  }
  return { review };
}

/** Shots of the project's active clip where a cast member mapped to this persona appears. */
function listShotsOfPersona(db: Workspace['db'], projectId: string, personaId: string): string[] {
  return all<{ shot_id: string }>(
    db,
    `SELECT DISTINCT t.shot_id FROM tracklets t JOIN cast_members c ON c.id = t.cast_member_id
     WHERE c.project_id = :projectId AND c.persona_id = :personaId`,
    { projectId, personaId },
  ).map((r) => r.shot_id);
}

/** After any cast/overlay change: recompute automatic modes and stale affected versions. */
export function settleCast(
  ws: Workspace,
  projectId: string,
  staleShots: string[],
  reason: string,
  actor: string,
) {
  const stale = staleShots.reduce((n, id) => n + markShotGenerationStale(ws.db, id, reason, actor), 0);
  return { modeChanges: recomputeShotModes(ws.db, projectId, actor), staleVersions: stale };
}

/**
 * Records a verdict and performs its follow-up (agent task for changes, a new version for regenerate). Regenerate
 * uses `model` when it names one of the same kind; otherwise a storyboard frame keeps its own model and a video
 * goes to the project's video model (the default for every video).
 */
export function submitReview(
  ws: Workspace,
  input: {
    targetId: string;
    verdict: Verdict;
    comment?: string | null;
    annotations?: unknown[];
    model?: string | null;
    attachments?: string[];
    /** Who handles a change request (`auto`: the configured `agents.default`). */
    agent?: TaskAgent;
    actor: string;
  },
) {
  const isBoard = input.targetId.startsWith('brd_');
  if (input.model && input.verdict === 'regenerate')
    assertSelectableModel(isBoard || input.targetId.startsWith('dsg_') ? 'image' : 'video', input.model);
  // Images the human attached to the comment travel with it as image annotations (Codex sees them).
  if (input.attachments?.length) {
    const projectId = input.targetId.startsWith('dsg_')
      ? getDesign(ws.db, input.targetId).projectId
      : projectOfShot(
          ws.db,
          (input.targetId.startsWith('brd_')
            ? getBoard(ws.db, input.targetId)
            : getTake(ws.db, input.targetId)
          ).shotId,
        ).id;
    input = {
      ...input,
      annotations: [
        ...(input.annotations ?? []),
        ...checkAttachments(ws, projectId, input.attachments).map((path) => ({ type: 'image', path })),
      ],
    };
  }
  if (input.targetId.startsWith('dsg_')) return submitDesignReview(ws, input);
  const target = isBoard ? getBoard(ws.db, input.targetId) : getTake(ws.db, input.targetId);
  const review = addReview(ws.db, {
    targetType: isBoard ? 'board' : 'take',
    targetId: input.targetId,
    verdict: input.verdict,
    comment: input.comment ?? null,
    annotations: input.annotations ?? [],
    createdBy: input.actor,
  });
  const project = projectOfShot(ws.db, target.shotId);
  if (input.verdict === 'changes') {
    const task = createAgentTask(ws.db, {
      kind: 'review_feedback',
      projectId: project.id,
      shotId: target.shotId,
      reviewId: review.id,
      payload: {
        targetType: isBoard ? 'board' : 'take',
        targetId: input.targetId,
        comment: input.comment,
        annotations: input.annotations ?? [],
        ...(input.agent && input.agent !== 'auto' ? { agent: input.agent } : {}),
      },
      createdBy: input.actor,
    });
    return { review, task };
  }
  if (input.verdict === 'regenerate') {
    const queued = isBoard
      ? queueBoard(ws, target.shotId, input.actor, {
          fromBoardId: input.targetId,
          model: input.model ?? target.model,
        })
      : queueTake(ws, target.shotId, (target as ReturnType<typeof getTake>).tier, input.actor, {
          fromTakeId: input.targetId,
          model: input.model ?? projectModels(ws.db, project.id).video,
        });
    return {
      review,
      queued: {
        ...('board' in queued ? { board: queued.board } : { take: queued.take }),
        jobId: queued.job.id,
      },
    };
  }
  if (input.verdict === 'keep_original') settleCast(ws, project.id, [], 'shot kept as original', input.actor);
  // An approved video (or a shot kept as it is) changes the film: the draft render follows on its own.
  if (!isBoard && (input.verdict === 'approve' || input.verdict === 'keep_original'))
    return { review, render: queueAutoDraftRender(ws, project.id, input.actor) };
  return { review };
}

/**
 * The draft render that follows approvals: queued unless one is already waiting (it picks the approved versions when
 * it starts, so a run of approvals makes one render). When it is done, older drafts are removed; finals stay.
 */
export function queueAutoDraftRender(ws: Workspace, projectId: string, actor: string) {
  const waiting = all<{ id: string }>(
    ws.db,
    `SELECT id FROM jobs WHERE type = 'render.compose' AND status = 'queued' AND project_id = :projectId`,
    { projectId },
  )[0];
  if (waiting) return { jobId: waiting.id, queued: false };
  const project = getProject(ws.db, projectId);
  if (!findActiveClip(ws.db, project.id)) return null;
  const render = createRender(ws.db, {
    projectId: project.id,
    kind: 'draft',
    tier: project.generationTier,
    createdBy: actor,
  });
  const job = enqueueJob(ws.db, {
    type: 'render.compose',
    lane: 'media',
    projectId: project.id,
    payload: { renderId: render.id, auto: true },
    requestedBy: actor,
  });
  return { renderId: render.id, jobId: job.id, queued: true };
}

/** Everything about one shot that a reviewer (human or Codex) needs. */
export function shotDetail(ws: Workspace, shotId: string) {
  const shot = getShot(ws.db, shotId);
  const project = projectOfShot(ws.db, shotId);
  const clip = getClip(ws.db, shot.clipId);
  const withReviews = <T extends { id: string }>(v: T) => ({ ...v, reviews: listReviews(ws.db, v.id) });
  return {
    shot,
    project: { id: project.id, slug: project.slug, name: project.name, tier: project.generationTier },
    seconds: Number(((shot.frameCount * clip.fpsDen) / clip.fpsNum).toFixed(3)),
    fps: { num: clip.fpsNum, den: clip.fpsDen },
    stage: shotStage(ws.db, shotId, project.generationTier),
    keyframes: listKeyframes(ws.db, shotId),
    overlays: listTextOverlays(ws.db, shotId),
    cast: shotCast(ws.db, shotId).map((e) => ({
      ...e,
      persona: e.personaId ? getPersona(ws.db, e.personaId) : null,
    })),
    boards: listBoards(ws.db, shotId).map(withReviews),
    takes: listTakes(ws.db, shotId).map(withReviews),
    tasks: listAgentTasks(ws.db, { shotId }),
    castCheck: latestShotCastCheck(ws, shotId),
    takePlan: latestShotJob<TakePlanResult>(ws, shotId, 'take.plan'),
    codexThreadId: findCodexThread(ws.db, 'shot', shotId) ?? null,
  };
}

export function projectOverview(ws: Workspace, ref: string) {
  const project = getProject(ws.db, ref);
  const clip = findActiveClip(ws.db, project.id) ?? null;
  const shots = clip ? listShots(ws.db, clip.id) : [];
  return {
    project,
    source: getSource(ws.db, project.sourceId),
    clip,
    shots: shots.map((s) => ({
      ...s,
      seconds: clip ? Number(((s.frameCount * clip.fpsDen) / clip.fpsNum).toFixed(3)) : null,
      stage: shotStage(ws.db, s.id, project.generationTier),
      thumb: listKeyframes(ws.db, s.id).find((k) => k.role === 'mid')?.path ?? null,
      overlays: listTextOverlays(ws.db, s.id).length,
      castCount: shotCast(ws.db, s.id).filter((e) => e.cast).length,
      versions: listBoards(ws.db, s.id).length + listTakes(ws.db, s.id).length,
    })),
    cast: listCast(ws.db, project.id),
    renders: listRenders(ws.db, project.id),
    openTasks: listAgentTasks(ws.db, { projectId: project.id }).filter(
      (t) => t.status !== 'done' && t.status !== 'cancelled',
    ),
    models: projectModels(ws.db, project.id),
  };
}

/** Which step of the project flow comes next. */
export type ProjectStep = 'clip' | 'shots' | 'cast' | 'design' | 'generate' | 'render' | 'done';

/** One line per project for the project list: source, progress through the flow, open tasks. */
export function projectSummaries(ws: Workspace) {
  return listProjects(ws.db).map((project) => {
    const source = getSource(ws.db, project.sourceId);
    const clip = findActiveClip(ws.db, project.id) ?? null;
    const shots = clip ? listShots(ws.db, clip.id) : [];
    const working = shots.filter((s) => s.mode === 'replace' || s.mode === 'clean');
    const approved = working.filter(
      (s) => shotStage(ws.db, s.id, project.generationTier) === 'approved',
    ).length;
    const castMapped = listCast(ws.db, project.id).filter((c) => c.personaId).length;
    const bindings = projectBindings(ws.db, project.id);
    const designed = bindings.filter((b) => approvedDesign(ws.db, project.id, b, 'turnaround')).length;
    const renders = listRenders(ws.db, project.id);
    const tasks = listAgentTasks(ws.db, { projectId: project.id }).filter(
      (t) => t.status !== 'done' && t.status !== 'cancelled',
    );
    const step: ProjectStep = !clip
      ? 'clip'
      : shots.length === 0
        ? 'shots'
        : castMapped === 0
          ? 'cast'
          : designed < bindings.length
            ? 'design'
            : approved < working.length
              ? 'generate'
              : renders.length === 0
                ? 'render'
                : 'done';
    return {
      ...project,
      source: {
        id: source.id,
        title: source.title,
        thumbPath: source.thumbPath,
        durationMs: source.durationMs,
      },
      clipSeconds: clip ? Number(((clip.frameCount * clip.fpsDen) / clip.fpsNum).toFixed(1)) : null,
      shots: shots.length,
      toGenerate: working.length,
      approved,
      castMapped,
      designed,
      toDesign: bindings.length,
      renders: renders.length,
      openTasks: tasks.length,
      needsUser: tasks.filter((t) => t.status === 'needs_user').length,
      // Codex discussions whose conclusion is waiting to be imported.
      discussions:
        all<{ n: number }>(
          ws.db,
          `SELECT COUNT(*) AS n FROM handoffs WHERE project_id = :projectId AND status = 'submitted'`,
          { projectId: project.id },
        )[0]?.n ?? 0,
      step,
    };
  });
}

/** Everything Codex needs to act on a task, with absolute paths so it can look at the images. */
export function taskContext(ws: Workspace, taskId: string) {
  const task = getAgentTask(ws.db, taskId);
  const shot = task.shotId ? getShot(ws.db, task.shotId) : null;
  const payload = task.payload as {
    targetType?: 'board' | 'take' | 'design';
    targetId?: string;
    handoff?: { brief?: string };
  };
  const target = payload.targetId
    ? payload.targetType === 'board'
      ? getBoard(ws.db, payload.targetId)
      : payload.targetType === 'design'
        ? getDesign(ws.db, payload.targetId)
        : getTake(ws.db, payload.targetId)
    : null;
  const abs = (rel: string | null | undefined) => (rel ? ws.abs(rel) : null);
  const project = getProject(ws.db, task.projectId);
  return {
    task,
    // Handed over to Claude: the brief with what was asked, every version and what was tried. Read it first.
    ...(payload.handoff?.brief ? { brief: abs(payload.handoff.brief) } : {}),
    project: { id: project.id, slug: project.slug, tier: project.generationTier },
    shot,
    target: target && {
      ...target,
      absPath: abs(target.path),
      inputs: target.inputs.map((i) => ({ ...i, absPath: abs(i.path) })),
    },
    history: shot
      ? {
          boards: listBoards(ws.db, shot.id).map((b) => ({
            id: b.id,
            version: b.version,
            status: b.status,
            absPath: abs(b.path),
          })),
          takes: listTakes(ws.db, shot.id).map((t) => ({
            id: t.id,
            version: t.version,
            tier: t.tier,
            status: t.status,
            model: t.model,
            ...(t.params.range ? { range: t.params.range, keepFrom: t.params.keepFrom } : {}),
          })),
        }
      : null,
    reviews: payload.targetId ? listReviews(ws.db, payload.targetId) : [],
    next:
      payload.targetType === 'board'
        ? `Revise with \`anirecast board generate ${project.slug} --from ${payload.targetId} --extra "<instructions>" --wait\`, view the new board, then \`anirecast tasks done ${task.id} --note "…" --result <newBoardId>\`.`
        : payload.targetType === 'take'
          ? `Revise with \`anirecast take generate ${project.slug} --from ${payload.targetId} --extra "<instructions>" --wait\` — or, when the human approved part of it, redo only the rest: \`anirecast take generate ${project.slug} ${task.shotId ?? '<shot>'} --range a-b --keep ${payload.targetId}\` (cuts: \`anirecast shots cuts ${task.shotId ?? '<shot>'}\`). Check it with \`anirecast take sheet <newTakeId>\`, then \`anirecast tasks done ${task.id} --note "…" --result <newTakeId>\`.${routeOf(task) === 'claude' ? '' : ` Needs a code change? \`anirecast tasks handoff ${task.id} --to claude --reason "…"\`.`}`
          : payload.targetType === 'design'
            ? `Revise with \`anirecast design generate ${project.slug} --from ${payload.targetId} --extra "<instructions>" --wait\`, view the new sheet, then \`anirecast tasks done ${task.id} --note "…" --result <newDesignId>\`.`
            : 'Follow the task payload.',
  };
}
