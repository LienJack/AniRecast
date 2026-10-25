import { AniError } from '@anirecast/shared';
import { loadConfig } from '../config.ts';
import { enqueueJob } from '../jobs.ts';
import { assertNotBlockedOut, assertQuota } from '../quota.ts';
import type { Workspace } from '../workspace.ts';
import { createAgentTask, getAgentTask, listAgentTasks } from './agent-tasks.ts';
import { listCast, shotCast } from './cast.ts';
import { findActiveClip, getClip } from './clips.ts';
import { findCodexThread } from './codex.ts';
import {
  addReview,
  approvedBoard,
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
import { markShotGenerationStale, recomputeShotModes } from './modes.ts';
import { listTextOverlays } from './overlays.ts';
import { getPersona } from './personas.ts';
import { planBoard, planTake, sha256File } from './plan.ts';
import { type GenerationTier, getProject } from './projects.ts';
import { getShot, listKeyframes, listShots, projectOfShot } from './shots.ts';
import { getSource } from './sources.ts';

/** Use cases shared by the CLI and the HTTP API, so both behave identically. */

export function queueBoard(
  ws: Workspace,
  shotId: string,
  actor: string,
  opts: { extra?: string; fromBoardId?: string } = {},
) {
  const plan = planBoard(ws, shotId, opts);
  const board = createBoard(ws.db, {
    shotId,
    prompt: plan.prompt,
    model: loadConfig().models.image,
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

export function queueTake(
  ws: Workspace,
  shotId: string,
  tier: GenerationTier,
  actor: string,
  opts: { extra?: string; fromTakeId?: string; force?: boolean; retryBlocked?: boolean } = {},
) {
  const config = loadConfig();
  assertNotBlockedOut(ws.db, config, shotId, opts.retryBlocked);
  if (config.provider !== 'fake' && process.env.ANIRECAST_PROVIDER !== 'fake')
    assertQuota(ws.db, config, config.models.video, 1, { includePending: true });
  const plan = planTake(ws, shotId, tier, opts);
  const take = createTake(
    ws.db,
    {
      shotId,
      tier,
      boardId: plan.boardId,
      prompt: plan.prompt,
      model: config.models.video,
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

/** Records a verdict and performs its follow-up (agent task for changes, a new version for regenerate). */
export function submitReview(
  ws: Workspace,
  input: {
    targetId: string;
    verdict: Verdict;
    comment?: string | null;
    annotations?: unknown[];
    actor: string;
  },
) {
  const isBoard = input.targetId.startsWith('brd_');
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
      ? queueBoard(ws, target.shotId, input.actor, { fromBoardId: input.targetId })
      : queueTake(ws, target.shotId, (target as ReturnType<typeof getTake>).tier, input.actor, {
          fromTakeId: input.targetId,
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
    })),
    cast: listCast(ws.db, project.id),
    renders: listRenders(ws.db, project.id),
    openTasks: listAgentTasks(ws.db, { projectId: project.id }).filter(
      (t) => t.status !== 'done' && t.status !== 'cancelled',
    ),
  };
}

/** Everything Codex needs to act on a task, with absolute paths so it can look at the images. */
export function taskContext(ws: Workspace, taskId: string) {
  const task = getAgentTask(ws.db, taskId);
  const shot = task.shotId ? getShot(ws.db, task.shotId) : null;
  const payload = task.payload as { targetType?: 'board' | 'take'; targetId?: string };
  const target = payload.targetId
    ? payload.targetType === 'board'
      ? getBoard(ws.db, payload.targetId)
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
          : 'Follow the task payload.',
  };
}
