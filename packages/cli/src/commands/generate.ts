import { readFileSync } from 'node:fs';
import {
  type AgentTaskStatus,
  actorFromEnv,
  answerAgentTask,
  approvedTake,
  askUser,
  assertQuota,
  cancelAgentTask,
  claimAgentTask,
  claimNextAgentTask,
  completeAgentTask,
  createRender,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getBoard,
  getProject,
  getRender,
  getTake,
  listAgentTasks,
  listBoards,
  listRenders,
  listReviews,
  listShots,
  listTakes,
  loadConfig,
  projectCacheDir,
  projectOfShot,
  queueBoard,
  queueTake,
  quotaOverview,
  safetyBlockCount,
  shotStage,
  spendBreakdown,
  submitReview,
  TIERS,
  taskContext,
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
    .option(
      '--retry-blocked',
      'send a shot the safety filter has already blocked limits.maxSafetyBlocks times',
    )
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
            retryBlocked?: boolean;
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const project = getProject(ws.db, projectRef);
            // Revising a take stays on that take's tier unless told otherwise.
            const tier = opts.tier ?? (opts.from ? getTake(ws.db, opts.from).tier : project.generationTier);
            if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
            const ids = opts.from
              ? [getTake(ws.db, opts.from).shotId]
              : targetShots(ws, projectRef, shotIds, Boolean(opts.all), ['replace', 'clean']);
            const config = loadConfig();
            const staged =
              opts.all && !opts.force
                ? ids.filter((id) => ['take_pending', 'stale', 'failed'].includes(shotStage(ws.db, id, tier)))
                : ids;
            // With --all, shots the safety filter keeps refusing are left out instead of failing the batch.
            const blockedOut =
              opts.all && !opts.retryBlocked
                ? staged.filter((id) => safetyBlockCount(ws.db, id) >= config.limits.maxSafetyBlocks)
                : [];
            const ready = staged.filter((id) => !blockedOut.includes(id));
            // Check the whole batch against today's quota before queueing any of it.
            if (config.provider !== 'fake' && process.env.ANIRECAST_PROVIDER !== 'fake')
              assertQuota(ws.db, config, config.models.video, ready.length, { includePending: true });
            const extra = extraText(opts);
            const queued = ready.map((id) =>
              queueTake(ws, id, tier, actorFromEnv(), {
                ...(extra ? { extra } : {}),
                ...(opts.from ? { fromTakeId: opts.from } : {}),
                force: Boolean(opts.force),
                retryBlocked: Boolean(opts.retryBlocked),
              }),
            );
            return {
              takes: queued.map((q) => q.take),
              skipped: ids.filter((id) => !staged.includes(id)),
              blockedOut,
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
    .option('--retry-blocked', 'send even if the safety filter keeps blocking this shot')
    .option('--wait')
    .action(
      command((shotId: string, opts: { retryBlocked?: boolean; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const approved = approvedTake(ws.db, shotId);
          if (!approved) throw new AniError('conflict', 'This shot has no approved take to promote');
          const next = TIERS[TIERS.indexOf(approved.tier) + 1];
          if (!next) throw new AniError('conflict', 'Already at the final tier');
          const q = queueTake(ws, shotId, next, actorFromEnv(), {
            fromTakeId: approved.id,
            retryBlocked: Boolean(opts.retryBlocked),
          });
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
  review
    .command('approve <version>')
    .option('--comment <text>')
    .action(
      command((id: string, opts: { comment?: string }) =>
        withWorkspace(globals(), (ws) =>
          submitReview(ws, {
            targetId: id,
            verdict: 'approve',
            comment: opts.comment ?? null,
            actor: actorFromEnv(),
          }),
        ),
      ),
    );
  review
    .command('request-changes <version>')
    .description('Reject with a comment; an agent task hands the comment to Codex')
    .requiredOption('--comment <text>', 'what to change')
    .action(
      command((id: string, opts: { comment: string }) =>
        withWorkspace(globals(), (ws) =>
          submitReview(ws, {
            targetId: id,
            verdict: 'changes',
            comment: opts.comment,
            actor: actorFromEnv(),
          }),
        ),
      ),
    );
  review
    .command('regenerate <version>')
    .description('Same inputs, new attempt')
    .option('--wait')
    .action(
      command((id: string, opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const result = submitReview(ws, { targetId: id, verdict: 'regenerate', actor: actorFromEnv() });
          return { ...result, ...(result.queued ? await waitAll(ws, [result.queued.jobId], opts.wait) : {}) };
        }),
      ),
    );
  review
    .command('keep-original <version>')
    .description('Use the original footage for this shot')
    .action(
      command((id: string) =>
        withWorkspace(globals(), (ws) =>
          submitReview(ws, { targetId: id, verdict: 'keep_original', actor: actorFromEnv() }),
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

  program
    .command('quota')
    .description("Today's provider requests per model against the daily quota (blocked requests count)")
    .action(
      command(() =>
        withWorkspace(globals(), (ws) => {
          const local = (at: number) => new Date(at).toLocaleString('sv-SE').slice(0, 16);
          return quotaOverview(ws.db, loadConfig()).map((q) => ({
            ...q,
            limit: Number.isFinite(q.limit) ? q.limit : null,
            remaining: Number.isFinite(q.remaining) ? q.remaining : null,
            dayStartLocal: local(q.dayStart),
            resetsAtLocal: local(q.resetsAt),
          }));
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
