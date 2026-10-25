import { readFileSync } from 'node:fs';
import {
  type AgentTaskStatus,
  actorFromEnv,
  addReview,
  answerAgentTask,
  approvedTake,
  askUser,
  cancelAgentTask,
  claimAgentTask,
  claimNextAgentTask,
  completeAgentTask,
  createAgentTask,
  createBoard,
  createRender,
  createTake,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getAgentTask,
  getBoard,
  getProject,
  getRender,
  getShot,
  getTake,
  listAgentTasks,
  listBoards,
  listRenders,
  listReviews,
  listShots,
  listTakes,
  loadConfig,
  planBoard,
  planTake,
  projectCacheDir,
  projectOfShot,
  shotStage,
  spendBreakdown,
  TIERS,
  totalSpend,
  type Workspace,
} from '@anirecast/core';
import { contactSheet } from '@anirecast/media';
import { AniError } from '@anirecast/shared';
import type { Command } from 'commander';
import { type GlobalOptions, withWorkspace } from '../context.ts';
import { command } from '../output.ts';
import { unwrapJob, waitForJob } from '../wait.ts';

const extraText = (opts: { extra?: string; promptFile?: string }) =>
  [opts.extra, opts.promptFile ? readFileSync(opts.promptFile, 'utf8') : undefined]
    .filter(Boolean)
    .join('\n') || undefined;

/** Shot ids given explicitly, or every shot of the project in the matching mode with --all. */
function targetShots(
  ws: Workspace,
  projectRef: string,
  ids: string[],
  all: boolean,
  modes: string[],
): string[] {
  const project = getProject(ws.db, projectRef);
  if (ids.length > 0) return ids;
  if (!all) throw new AniError('usage', 'Pass shot ids or --all');
  const clip = findActiveClip(ws.db, project.id);
  if (!clip) throw new AniError('conflict', 'Project has no clip');
  return listShots(ws.db, clip.id)
    .filter((s) => modes.includes(s.mode))
    .map((s) => s.id);
}

async function waitAll(ws: Workspace, jobIds: string[], wait?: boolean) {
  if (!wait) return { jobIds, queued: true };
  const jobs = [];
  for (const id of jobIds) jobs.push(unwrapJob(await waitForJob(ws, id)));
  return { jobs };
}

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
  opts: { extra?: string; fromTakeId?: string; force?: boolean } = {},
) {
  const plan = planTake(ws, shotId, tier, opts);
  const take = createTake(
    ws.db,
    {
      shotId,
      tier,
      boardId: plan.boardId,
      prompt: plan.prompt,
      model: loadConfig().models.video,
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

export function registerGenerate(program: Command): void {
  const globals = () => program.opts<GlobalOptions>();

  const board = program.command('board').description('Storyboard frames (分鏡圖) via Nano Banana 2.1');
  board
    .command('generate <project> [shots...]')
    .option('--all', 'every replace shot of the project')
    .option('--extra <text>', 'extra instructions appended to the prompt')
    .option('--prompt-file <file>', 'extra instructions from a file')
    .option('--from <boardId>', 'revise this board (adds --extra on top of its prompt inputs)')
    .option('--wait', 'wait for generation')
    .action(
      command(
        (
          projectRef: string,
          shotIds: string[],
          opts: { all?: boolean; extra?: string; promptFile?: string; from?: string; wait?: boolean },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const ids = opts.from
              ? [getBoard(ws.db, opts.from).shotId]
              : targetShots(ws, projectRef, shotIds, Boolean(opts.all), ['replace']);
            const extra = extraText(opts);
            const queued = ids.map((id) =>
              queueBoard(ws, id, actorFromEnv(), {
                ...(extra ? { extra } : {}),
                ...(opts.from ? { fromBoardId: opts.from } : {}),
              }),
            );
            return {
              boards: queued.map((q) => q.board),
              ...(await waitAll(
                ws,
                queued.map((q) => q.job.id),
                opts.wait,
              )),
            };
          }),
      ),
    );
  board
    .command('list <shot>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => listBoards(ws.db, id))));
  board
    .command('show <board>')
    .action(
      command((id: string) =>
        withWorkspace(globals(), (ws) => ({ board: getBoard(ws.db, id), reviews: listReviews(ws.db, id) })),
      ),
    );

  const take = program.command('take').description('Shot videos (分鏡視頻) via Gemini Omni');
  take
    .command('generate <project> [shots...]')
    .option('--all', 'every replace/clean shot that is ready for video')
    .option('--tier <tier>', 'draft (360p), preview (720p) or final (1080p); default: the project tier')
    .option('--extra <text>', 'extra instructions')
    .option('--prompt-file <file>', 'extra instructions from a file')
    .option('--from <takeId>', 'revise this take (same inputs, plus --extra)')
    .option('--force', 'generate a replace shot without an approved board')
    .option('--wait', 'wait for generation')
    .action(
      command(
        (
          projectRef: string,
          shotIds: string[],
          opts: {
            all?: boolean;
            tier?: GenerationTier;
            extra?: string;
            promptFile?: string;
            from?: string;
            force?: boolean;
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const project = getProject(ws.db, projectRef);
            const tier = opts.tier ?? project.generationTier;
            if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
            const ids = opts.from
              ? [getTake(ws.db, opts.from).shotId]
              : targetShots(ws, projectRef, shotIds, Boolean(opts.all), ['replace', 'clean']);
            const ready =
              opts.all && !opts.force
                ? ids.filter((id) => ['take_pending', 'stale', 'failed'].includes(shotStage(ws.db, id, tier)))
                : ids;
            const extra = extraText(opts);
            const queued = ready.map((id) =>
              queueTake(ws, id, tier, actorFromEnv(), {
                ...(extra ? { extra } : {}),
                ...(opts.from ? { fromTakeId: opts.from } : {}),
                force: Boolean(opts.force),
              }),
            );
            return {
              takes: queued.map((q) => q.take),
              skipped: ids.filter((id) => !ready.includes(id)),
              ...(await waitAll(
                ws,
                queued.map((q) => q.job.id),
                opts.wait,
              )),
            };
          }),
      ),
    );
  take
    .command('promote <shot>')
    .description(
      'Regenerate the approved take at the next tier (draft → preview → final) with the same inputs',
    )
    .option('--wait')
    .action(
      command((shotId: string, opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const approved = approvedTake(ws.db, shotId);
          if (!approved) throw new AniError('conflict', 'This shot has no approved take to promote');
          const next = TIERS[TIERS.indexOf(approved.tier) + 1];
          if (!next) throw new AniError('conflict', 'Already at the final tier');
          const q = queueTake(ws, shotId, next, actorFromEnv(), { fromTakeId: approved.id });
          return { take: q.take, ...(await waitAll(ws, [q.job.id], opts.wait)) };
        }),
      ),
    );
  take
    .command('list <shot>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => listTakes(ws.db, id))));
  take
    .command('show <take>')
    .action(
      command((id: string) =>
        withWorkspace(globals(), (ws) => ({ take: getTake(ws.db, id), reviews: listReviews(ws.db, id) })),
      ),
    );
  take
    .command('sheet <take>')
    .description('Contact sheet image of a take: original frames on top, generated frames below')
    .option('--count <n>', 'frames across', '5')
    .action(
      command((id: string, opts: { count: string }) =>
        withWorkspace(globals(), async (ws) => {
          const t = getTake(ws.db, id);
          const compare = (t.remote as { comparePath?: string }).comparePath;
          if (!compare || t.framesOut === null)
            throw new AniError('conflict', 'This take has no review proxy yet');
          const rel = `${projectCacheDir(projectOfShot(ws.db, t.shotId))}/sheets/${t.id}.jpg`;
          await contactSheet(ws.abs(compare), ws.abs(rel), t.framesOut, Number(opts.count));
          return { path: rel, absPath: ws.abs(rel) };
        }),
      ),
    );

  const review = program.command('review').description('Human review of boards and takes');
  const target = (ws: Workspace, id: string): { type: 'board' | 'take'; shotId: string } =>
    id.startsWith('brd_')
      ? { type: 'board', shotId: getBoard(ws.db, id).shotId }
      : { type: 'take', shotId: getTake(ws.db, id).shotId };
  review
    .command('approve <version>')
    .option('--comment <text>')
    .action(
      command((id: string, opts: { comment?: string }) =>
        withWorkspace(globals(), (ws) =>
          addReview(ws.db, {
            targetType: target(ws, id).type,
            targetId: id,
            verdict: 'approve',
            comment: opts.comment ?? null,
            createdBy: actorFromEnv(),
          }),
        ),
      ),
    );
  review
    .command('request-changes <version>')
    .requiredOption('--comment <text>', 'what to change (handed to Codex)')
    .action(
      command((id: string, opts: { comment: string }) =>
        withWorkspace(globals(), (ws) => {
          const t = target(ws, id);
          const r = addReview(ws.db, {
            targetType: t.type,
            targetId: id,
            verdict: 'changes',
            comment: opts.comment,
            createdBy: actorFromEnv(),
          });
          const task = createAgentTask(ws.db, {
            kind: 'review_feedback',
            projectId: projectOfShot(ws.db, t.shotId).id,
            shotId: t.shotId,
            reviewId: r.id,
            payload: { targetType: t.type, targetId: id, comment: opts.comment },
            createdBy: actorFromEnv(),
          });
          return { review: r, task };
        }),
      ),
    );
  review
    .command('regenerate <version>')
    .description('Same inputs, new attempt')
    .option('--wait')
    .action(
      command((id: string, opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const t = target(ws, id);
          addReview(ws.db, {
            targetType: t.type,
            targetId: id,
            verdict: 'regenerate',
            createdBy: actorFromEnv(),
          });
          const q =
            t.type === 'board'
              ? queueBoard(ws, t.shotId, actorFromEnv(), { fromBoardId: id })
              : queueTake(ws, t.shotId, getTake(ws.db, id).tier, actorFromEnv(), { fromTakeId: id });
          return { queued: 'board' in q ? q.board : q.take, ...(await waitAll(ws, [q.job.id], opts.wait)) };
        }),
      ),
    );
  review
    .command('keep-original <version>')
    .description('Use the original footage for this shot')
    .action(
      command((id: string) =>
        withWorkspace(globals(), (ws) =>
          addReview(ws.db, {
            targetType: target(ws, id).type,
            targetId: id,
            verdict: 'keep_original',
            createdBy: actorFromEnv(),
          }),
        ),
      ),
    );
  review
    .command('status <project>')
    .description('Pipeline stage of every shot at the project tier')
    .option('--tier <tier>')
    .action(
      command((ref: string, opts: { tier?: GenerationTier }) =>
        withWorkspace(globals(), (ws) => {
          const project = getProject(ws.db, ref);
          const clip = findActiveClip(ws.db, project.id);
          if (!clip) return [];
          const tier = opts.tier ?? project.generationTier;
          return listShots(ws.db, clip.id).map((s) => ({
            shotId: s.id,
            index: s.orderIndex + 1,
            mode: s.mode,
            stage: shotStage(ws.db, s.id, tier),
          }));
        }),
      ),
    );

  const render = program.command('render').description('Compose the full video (合成)');
  render
    .command('create <project>')
    .option('--draft', 'use the best available takes and mark the frame as a draft')
    .option('--tier <tier>', 'default: the project tier')
    .option('--wait')
    .action(
      command((ref: string, opts: { draft?: boolean; tier?: GenerationTier; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const project = getProject(ws.db, ref);
          const r = createRender(ws.db, {
            projectId: project.id,
            kind: opts.draft ? 'draft' : 'final',
            tier: opts.tier ?? project.generationTier,
            createdBy: actorFromEnv(),
          });
          const job = enqueueJob(ws.db, {
            type: 'render.compose',
            lane: 'media',
            projectId: project.id,
            payload: { renderId: r.id },
            requestedBy: actorFromEnv(),
          });
          const waited = await waitAll(ws, [job.id], opts.wait);
          return { render: getRender(ws.db, r.id), ...waited };
        }),
      ),
    );
  render
    .command('list <project>')
    .action(
      command((ref: string) =>
        withWorkspace(globals(), (ws) => listRenders(ws.db, getProject(ws.db, ref).id)),
      ),
    );

  program
    .command('cost [project]')
    .description('Recorded provider spend (fake provider excluded)')
    .action(
      command((ref?: string) =>
        withWorkspace(globals(), (ws) => {
          const projectId = ref ? getProject(ws.db, ref).id : undefined;
          return {
            totalUsd: totalSpend(ws.db, projectId ? { projectId } : {}),
            capUsd: loadConfig().budget.capUsd,
            breakdown: spendBreakdown(ws.db, projectId),
          };
        }),
      ),
    );

  const tasks = program
    .command('tasks')
    .description('Agent tasks: review feedback and identity checks handed to Codex');
  tasks
    .command('list')
    .option('--status <status>', 'open|claimed|done|needs_user|cancelled')
    .option('--open', 'shortcut for --status open')
    .action(
      command((opts: { status?: AgentTaskStatus; open?: boolean }) =>
        withWorkspace(globals(), (ws) =>
          listAgentTasks(ws.db, opts.open ? { status: 'open' } : opts.status ? { status: opts.status } : {}),
        ),
      ),
    );
  tasks
    .command('show <task>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => taskContext(ws, id))));
  tasks
    .command('next')
    .description('Claim the oldest open task and print everything needed to act on it')
    .option('--peek', 'show without claiming')
    .action(
      command((opts: { peek?: boolean }) =>
        withWorkspace(globals(), (ws) => {
          const task = opts.peek
            ? listAgentTasks(ws.db, { status: 'open' })[0]
            : claimNextAgentTask(ws.db, actorFromEnv());
          return task ? taskContext(ws, task.id) : null;
        }),
      ),
    );
  tasks
    .command('claim <task>')
    .action(
      command((id: string) => withWorkspace(globals(), (ws) => claimAgentTask(ws.db, id, actorFromEnv()))),
    );
  tasks
    .command('done <task>')
    .requiredOption('--note <text>', 'one sentence for the review history, e.g. what changed in the prompt')
    .option('--result <versionId>', 'the new board/take this produced')
    .action(
      command((id: string, opts: { note: string; result?: string }) =>
        withWorkspace(globals(), (ws) =>
          completeAgentTask(
            ws.db,
            id,
            { note: opts.note, ...(opts.result ? { targetId: opts.result } : {}) },
            actorFromEnv(),
          ),
        ),
      ),
    );
  tasks
    .command('ask <task>')
    .requiredOption('--question <text>')
    .action(
      command((id: string, opts: { question: string }) =>
        withWorkspace(globals(), (ws) => askUser(ws.db, id, opts.question, actorFromEnv())),
      ),
    );
  tasks
    .command('answer <task>')
    .requiredOption('--answer <text>')
    .action(
      command((id: string, opts: { answer: string }) =>
        withWorkspace(globals(), (ws) => answerAgentTask(ws.db, id, opts.answer, actorFromEnv())),
      ),
    );
  tasks
    .command('cancel <task>')
    .action(
      command((id: string) => withWorkspace(globals(), (ws) => cancelAgentTask(ws.db, id, actorFromEnv()))),
    );
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
  return {
    task,
    shot,
    target: target && {
      ...target,
      absPath: abs(target.path),
      inputs: target.inputs.map((i) => ({ ...i, absPath: abs(i.path) })),
    },
    history: shot
      ? {
          boards: listBoards(ws.db, shot.id).map((b) => ({ id: b.id, version: b.version, status: b.status })),
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
        ? 'Revise with `anirecast board generate <project> --from <boardId> --extra "<instructions>" --wait`, look at the result, then `anirecast tasks done <task> --note "…" --result <newBoardId>`.'
        : payload.targetType === 'take'
          ? 'Revise with `anirecast take generate <project> --from <takeId> --extra "<instructions>" --wait`, look at the result, then `anirecast tasks done <task> --note "…" --result <newTakeId>`.'
          : 'Follow the task payload.',
  };
}
