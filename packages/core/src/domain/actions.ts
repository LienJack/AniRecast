import { AniError } from '@anirecast/shared';
import { loadConfig } from '../config.ts';
import { all, fromJson, one } from '../db.ts';
import { enqueueJob } from '../jobs.ts';
import { assertNotBlockedOut, assertQuota } from '../quota.ts';
import type { Workspace } from '../workspace.ts';
import { createAgentTask, getAgentTask, listAgentTasks } from './agent-tasks.ts';
import { getCastMember, listCast, shotCast } from './cast.ts';
import { markCastAnalysisQueued } from './cast-analysis.ts';
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
import { planBoard, planDesign, planOriginalDesign, planTake, sha256File } from './plan.ts';
import { type GenerationTier, getProject, listProjects } from './projects.ts';
import { getShot, listKeyframes, listShots, projectOfShot } from './shots.ts';
import { getSource } from './sources.ts';

/** Use cases shared by the CLI and the HTTP API, so both behave identically. */

export function queueBoard(
  ws: Workspace,
  shotId: string,
  actor: string,
  opts: { extra?: string; fromBoardId?: string; model?: string; role?: BoardRole } = {},
) {
  const { model: chosen, ...planOpts } = opts;
  const plan = planBoard(ws, shotId, planOpts);
  const board = createBoard(ws.db, {
    shotId,
    role: plan.role,
    frame: plan.frame,
    prompt: plan.prompt,
    model: chosen ?? projectModels(ws.db, projectOfShot(ws.db, shotId).id).image,
    params: plan.params,
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
    maxAttempts: 2,
  });
  return { board, job };
}

/**
 * 生成分鏡圖: the shot's three storyboard frames — first, key and last. A first or last frame where nobody to
 * replace is seen is skipped (and said so); the key frame is required.
 */
export function queueBoards(
  ws: Workspace,
  shotId: string,
  actor: string,
  opts: { extra?: string; model?: string; roles?: readonly BoardRole[] } = {},
) {
  const { roles = BOARD_ROLES, ...rest } = opts;
  const boards: Array<ReturnType<typeof queueBoard>> = [];
  const skipped: Array<{ role: BoardRole; reason: string }> = [];
  for (const role of roles) {
    try {
      boards.push(queueBoard(ws, shotId, actor, { ...rest, role }));
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
  opts: { extra?: string; fromTakeId?: string; force?: boolean; retryBlocked?: boolean; model?: string } = {},
) {
  const config = loadConfig();
  const model = opts.model ?? projectModels(ws.db, projectOfShot(ws.db, shotId).id).video;
  assertNotBlockedOut(ws.db, config, shotId, opts.retryBlocked);
  if (config.provider !== 'fake' && process.env.ANIRECAST_PROVIDER !== 'fake')
    assertQuota(ws.db, config, model, 1, { includePending: true });
  const plan = planTake(ws, shotId, tier, { ...opts, model });
  const take = createTake(
    ws.db,
    {
      shotId,
      tier,
      boardId: plan.boardId,
      prompt: plan.prompt,
      model,
      params: plan.params,
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
 * Queues design sheets (all three when `kind` is omitted) for the bindings `ref` names: an original character
 * (cast id or label), or a library character (every original bound to it). `fromDesignId` revises that sheet.
 */
export function queueDesign(
  ws: Workspace,
  projectRef: string,
  ref: string | null,
  actor: string,
  opts: { kind?: DesignKind; extra?: string; fromDesignId?: string; model?: string } = {},
) {
  const project = getProject(ws.db, projectRef);
  const from = opts.fromDesignId ? getDesign(ws.db, opts.fromDesignId) : undefined;
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
      const plan = planDesign(ws, project.id, binding, kind, {
        ...(opts.extra ? { extra: opts.extra } : {}),
        ...(from ? { fromDesignId: from.id } : {}),
      });
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
  opts: { kind?: DesignKind; extra?: string; fromDesignId?: string; model?: string } = {},
) {
  const project = getProject(ws.db, projectRef);
  const cast = getCastMember(ws.db, castId);
  if (cast.projectId !== project.id) throw new AniError('usage', `${castId} belongs to another project`);
  const from = opts.fromDesignId ? getDesign(ws.db, opts.fromDesignId) : undefined;
  const kinds = from ? [from.kind] : opts.kind ? [opts.kind] : [...DESIGN_KINDS];
  const designModel = opts.model ?? projectModels(ws.db, project.id).design;
  return kinds.map((kind) => {
    const plan = planOriginalDesign(ws, project.id, cast.id, kind, {
      ...(opts.extra ? { extra: opts.extra } : {}),
      ...(from ? { fromDesignId: from.id } : {}),
    });
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
  opts: { model?: string; extra?: string } = {},
) {
  const shot = getShot(ws.db, shotId);
  if (shot.mode !== 'replace')
    throw new AniError('conflict', 'Only a replace shot has a video director plan');
  return enqueueJob(ws.db, {
    type: 'take.plan',
    lane: 'generate',
    projectId: projectOfShot(ws.db, shot.id).id,
    payload: {
      shotId: shot.id,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
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
 * No model, no request, no cost; it renders like any other take.
 */
export function queueStillTake(ws: Workspace, shotId: string, tier: GenerationTier, actor: string) {
  const board = approvedBoard(ws.db, shotId);
  if (!board?.path)
    throw new AniError('conflict', 'A still take needs an approved board', {
      hint: 'Approve the board first.',
    });
  const take = createTake(ws.db, {
    shotId,
    tier,
    boardId: board.id,
    prompt: 'Still: the approved board held for the length of the shot (no video model).',
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
      payload: { targetType: 'design', targetId: design.id, comment: input.comment, annotations: [] },
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
 * keeps the version's model unless `model` names another one of the same kind.
 */
export function submitReview(
  ws: Workspace,
  input: {
    targetId: string;
    verdict: Verdict;
    comment?: string | null;
    annotations?: unknown[];
    model?: string | null;
    actor: string;
  },
) {
  const isBoard = input.targetId.startsWith('brd_');
  if (input.model && input.verdict === 'regenerate')
    assertSelectableModel(isBoard || input.targetId.startsWith('dsg_') ? 'image' : 'video', input.model);
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
          model: input.model ?? target.model,
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
  return { review };
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
  const payload = task.payload as { targetType?: 'board' | 'take' | 'design'; targetId?: string };
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
          })),
        }
      : null,
    reviews: payload.targetId ? listReviews(ws.db, payload.targetId) : [],
    next:
      payload.targetType === 'board'
        ? `Revise with \`anirecast board generate ${project.slug} --from ${payload.targetId} --extra "<instructions>" --wait\`, view the new board, then \`anirecast tasks done ${task.id} --note "…" --result <newBoardId>\`.`
        : payload.targetType === 'take'
          ? `Revise with \`anirecast take generate ${project.slug} --from ${payload.targetId} --extra "<instructions>" --wait\`, check it with \`anirecast take sheet <newTakeId>\`, then \`anirecast tasks done ${task.id} --note "…" --result <newTakeId>\`.`
          : payload.targetType === 'design'
            ? `Revise with \`anirecast design generate ${project.slug} --from ${payload.targetId} --extra "<instructions>" --wait\`, view the new sheet, then \`anirecast tasks done ${task.id} --note "…" --result <newDesignId>\`.`
            : 'Follow the task payload.',
  };
}
