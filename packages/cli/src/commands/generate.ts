import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentTaskStatus,
  actorFromEnv,
  addReference,
  answerAgentTask,
  approvedTake,
  askUser,
  assertNotBlockedOut,
  assertQuota,
  BOARD_ROLES,
  type BoardRole,
  cancelAgentTask,
  claimAgentTask,
  claimNextAgentTask,
  completeAgentTask,
  createRender,
  type DesignKind,
  designOverview,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getBoard,
  getDesign,
  getPersona,
  getProject,
  getRender,
  getTake,
  handOffToClaude,
  latestShotJob,
  listAgentTasks,
  listBoards,
  listReferences,
  listRenders,
  listReviews,
  listShots,
  listTakes,
  loadConfig,
  PART_SEAMS,
  type PartSeams,
  projectCacheDir,
  projectModels,
  projectOfShot,
  queueAllBoards,
  queueBoard,
  queueBoards,
  queueCastAnalysis,
  queueDesign,
  queueOriginalDesign,
  queueReferenceSearch,
  queueStillTake,
  queueTake,
  queueTakeMerge,
  queueTakePlan,
  quotaOverview,
  resolveBindings,
  safetyBlockCount,
  setAnalysisPicks,
  setDesignNote,
  shotStage,
  spendBreakdown,
  submitReview,
  TIERS,
  taskContext,
  totalSpend,
  updateReference,
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

/**
 * --attach: images to give with the instructions — an attached image's workspace path (from a task's
 * annotations) or any image file, which is copied into the project.
 */
const attachOpt = (files: string[] | undefined): { attachments?: string[] } =>
  files?.length
    ? {
        attachments: files.map((f) =>
          f.startsWith('projects/') || path.isAbsolute(f) ? f : path.resolve(f),
        ),
      }
    : {};

/** `--range 0-73` → frames 0 to 73 of the shot (0 = its first frame), with the take whose other frames stay. */
function rangeOpt(
  range: string | undefined,
  keep: string | undefined,
): { range?: { start: number; end: number }; keepFrom?: string } {
  if (!range) {
    if (keep) throw new AniError('usage', '--keep goes with --range');
    return {};
  }
  const m = /^(\d+)-(\d+)$/.exec(range.trim());
  if (!m) throw new AniError('usage', '--range is the first and last frame of the shot, e.g. 0-73');
  return { range: { start: Number(m[1]), end: Number(m[2]) }, ...(keep ? { keepFrom: keep } : {}) };
}

/** The AniRecast checkout this CLI runs from (Claude works on the code there). */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

const seamsOpt = (seams: string | undefined): { seams?: PartSeams } => {
  if (!seams) return {};
  if (!PART_SEAMS.includes(seams as PartSeams))
    throw new AniError('usage', `--seams is one of ${PART_SEAMS.join(', ')}`);
  return { seams: seams as PartSeams };
};

const boardRole = (role: string): BoardRole => {
  if (!BOARD_ROLES.includes(role as BoardRole))
    throw new AniError('usage', `--role must be one of ${BOARD_ROLES.join(', ')}`);
  return role as BoardRole;
};

export function registerGenerate(program: Command): void {
  const globals = () => program.opts<GlobalOptions>();

  const board = program
    .command('board')
    .description('Storyboard frames (分鏡圖) via the project image model (Nano Banana 2.1 or GPT Image 2.5)');
  board
    .command('all <project>')
    .description(
      '生成全部分鏡圖: the key frame of every replace shot without one; JEV then decides which first/last frames differ enough to draw; Codex reviews the batch',
    )
    .option('--model <id>', 'image model (default: the project choice)')
    .action(
      command((projectRef: string, opts: { model?: string }) =>
        withWorkspace(globals(), (ws) => {
          const r = queueAllBoards(ws, projectRef, actorFromEnv(), opts.model ? { model: opts.model } : {});
          return { batch: r.batch, boards: r.queued.map((q) => q.board), skipped: r.skipped };
        }),
      ),
    );
  board
    .command('generate <project> [shots...]')
    .option('--all', 'every replace shot of the project')
    .option('--extra <text>', 'extra instructions appended to the prompt')
    .option(
      '--attach <files...>',
      'images to give with the instructions (an attached image path or any image file)',
    )
    .option('--prompt-file <file>', 'extra instructions from a file')
    .option('--from <boardId>', 'revise this board (adds --extra on top of its prompt inputs)')
    .option('--role <role>', 'only one storyboard frame: first, key or last (default: all three)')
    .option(
      '--force',
      'with --role first|last: draw it even where detection saw nobody to replace (someone only partly in view)',
    )
    .option(
      '--model <id>',
      'image model for this request (default: the project choice; see `project models`)',
    )
    .option('--wait', 'wait for generation')
    .action(
      command(
        (
          projectRef: string,
          shotIds: string[],
          opts: {
            all?: boolean;
            extra?: string;
            promptFile?: string;
            from?: string;
            role?: string;
            force?: boolean;
            model?: string;
            attach?: string[];
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const ids = opts.from
              ? [getBoard(ws.db, opts.from).shotId]
              : targetShots(ws, projectRef, shotIds, Boolean(opts.all), ['replace']);
            const extra = extraText(opts);
            const base = {
              ...(extra ? { extra } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              ...attachOpt(opts.attach),
            };
            const skipped: Array<{ shotId: string; role: string; reason: string }> = [];
            const queued = ids.flatMap((id) => {
              if (opts.from || opts.role)
                return [
                  queueBoard(ws, id, actorFromEnv(), {
                    ...base,
                    ...(opts.from ? { fromBoardId: opts.from } : {}),
                    ...(opts.role ? { role: boardRole(opts.role) } : {}),
                    ...(opts.force ? { force: true } : {}),
                  }),
                ];
              const r = queueBoards(ws, id, actorFromEnv(), base);
              for (const s of r.skipped) skipped.push({ shotId: id, ...s });
              return r.boards;
            });
            return {
              boards: queued.map((q) => q.board),
              ...(skipped.length ? { skipped } : {}),
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

  const design = program
    .command('design')
    .description(
      'Character design (角色設計): an original character bound to a library character, analysed, then redesigned',
    );
  design
    .command('list <project>')
    .description(
      'Bindings with their analysis, note and the latest / approved version of each sheet; unbound characters',
    )
    .action(
      command((projectRef: string) =>
        withWorkspace(globals(), (ws) => designOverview(ws.db, getProject(ws.db, projectRef).id)),
      ),
    );
  design
    .command('analyze <project> [character]')
    .description(
      '原片分析: how the animation draws the original character, her build, outfit, expressions and poses (all bindings when no character)',
    )
    .option('--generate', 'queue the three sheets once the analysis is in')
    .option('--wait', 'wait for the analysis')
    .action(
      command(
        (projectRef: string, character: string | undefined, opts: { generate?: boolean; wait?: boolean }) =>
          withWorkspace(globals(), async (ws) => {
            const jobs = queueCastAnalysis(ws, projectRef, character ?? null, actorFromEnv(), {
              ...(opts.generate ? { thenKinds: ['turnaround', 'expressions', 'poses'] } : {}),
            });
            return waitAll(
              ws,
              jobs.map((j) => j.id),
              opts.wait,
            );
          }),
      ),
    );
  design
    .command('pick <project> <character>')
    .description(
      'Which analysed expressions and poses the sheets use (numbers from `design list`, starting at 1)',
    )
    .option('--expressions <numbers>', 'e.g. 1,2,5 (empty string = none)')
    .option('--poses <numbers>', 'e.g. 1,3')
    .action(
      command((projectRef: string, character: string, opts: { expressions?: string; poses?: string }) =>
        withWorkspace(globals(), (ws) => {
          const [binding] = resolveBindings(ws.db, getProject(ws.db, projectRef).id, character);
          const nums = (v: string | undefined) =>
            v === undefined
              ? undefined
              : v
                  .split(',')
                  .map((n) => n.trim())
                  .filter(Boolean)
                  .map((n) => Number(n) - 1);
          const expressions = nums(opts.expressions);
          const poses = nums(opts.poses);
          return setAnalysisPicks(
            ws.db,
            (binding as { castMemberId: string }).castMemberId,
            { ...(expressions ? { expressions } : {}), ...(poses ? { poses } : {}) },
            actorFromEnv(),
          );
        }),
      ),
    );
  design
    .command('generate <project> [character]')
    .description(
      'Draw design sheets for a binding (original character id or label, or a library character): turnaround, expressions, poses; all bindings when omitted',
    )
    .option('--kind <kind>', 'only one sheet: turnaround, expressions or poses')
    .option('--extra <text>', 'extra instructions')
    .option(
      '--attach <files...>',
      'images to give with the instructions (an attached image path or any image file)',
    )
    .option('--from <designId>', 'revise this sheet (same inputs, plus --extra)')
    .option('--model <id>', 'image model for these sheets (default: the project choice)')
    .option('--wait', 'wait for the sheets')
    .action(
      command(
        (
          projectRef: string,
          character: string | undefined,
          opts: {
            kind?: DesignKind;
            extra?: string;
            from?: string;
            model?: string;
            attach?: string[];
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const queued = queueDesign(
              ws,
              projectRef,
              opts.from ? null : (character ?? null),
              actorFromEnv(),
              {
                ...(opts.kind ? { kind: opts.kind } : {}),
                ...(opts.extra ? { extra: opts.extra } : {}),
                ...attachOpt(opts.attach),
                ...(opts.from ? { fromDesignId: opts.from } : {}),
                ...(opts.model ? { model: opts.model } : {}),
              },
            );
            return {
              designs: queued.map((q) => q.design),
              ...(await waitAll(
                ws,
                queued.map((q) => q.job.id),
                opts.wait,
              )),
            };
          }),
      ),
    );
  design
    .command('refs <project> <character>')
    .description(
      "官方設定集: an original character's reference images (official design art); --search finds candidates on the web",
    )
    .option(
      '--search',
      'search the web for official design art (Gemini + Google Search), keep likely candidates',
    )
    .option('--add-file <file>', 'add an image you have (accepted)')
    .option('--accept <ids>', 'accept candidates (comma-separated reference ids)')
    .option('--reject <ids>', 'reject candidates')
    .option('--wait', 'wait for the search')
    .action(
      command(
        (
          projectRef: string,
          character: string,
          opts: { search?: boolean; addFile?: string; accept?: string; reject?: string; wait?: boolean },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const [binding] = resolveBindings(ws.db, getProject(ws.db, projectRef).id, character);
            const castId = (binding as { castMemberId: string }).castMemberId;
            const ids = (v?: string) =>
              v
                ? v
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean)
                : [];
            for (const id of ids(opts.accept))
              updateReference(ws.db, id, { status: 'accepted' }, actorFromEnv());
            for (const id of ids(opts.reject))
              updateReference(ws.db, id, { status: 'rejected' }, actorFromEnv());
            if (opts.addFile)
              addReference(
                ws,
                castId,
                path.resolve(opts.addFile),
                { status: 'accepted', label: path.basename(opts.addFile) },
                actorFromEnv(),
              );
            if (opts.search) {
              const job = queueReferenceSearch(ws, projectRef, castId, actorFromEnv());
              if (!opts.wait) return { job };
              await waitForJob(ws, job.id);
            }
            return listReferences(ws.db, castId).map((r) => ({ ...r, absPath: ws.abs(r.path) }));
          }),
      ),
    );
  design
    .command('original <project> <character>')
    .description(
      "The original character's own sheets (turnaround, expressions, poses) from accepted official art and the clip; the template for her replacement",
    )
    .option('--kind <kind>', 'only one sheet: turnaround, expressions or poses')
    .option('--extra <text>', 'extra instructions')
    .option(
      '--attach <files...>',
      'images to give with the instructions (an attached image path or any image file)',
    )
    .option('--from <designId>', 'revise this sheet')
    .option('--model <id>', 'image model (default: the project choice)')
    .option('--wait', 'wait for the sheets')
    .action(
      command(
        (
          projectRef: string,
          character: string,
          opts: {
            kind?: DesignKind;
            extra?: string;
            from?: string;
            model?: string;
            attach?: string[];
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const [binding] = resolveBindings(ws.db, getProject(ws.db, projectRef).id, character);
            const queued = queueOriginalDesign(
              ws,
              projectRef,
              (binding as { castMemberId: string }).castMemberId,
              actorFromEnv(),
              {
                ...(opts.kind ? { kind: opts.kind } : {}),
                ...(opts.extra ? { extra: opts.extra } : {}),
                ...attachOpt(opts.attach),
                ...(opts.from ? { fromDesignId: opts.from } : {}),
                ...(opts.model ? { model: opts.model } : {}),
              },
            );
            return {
              designs: queued.map((q) => q.design),
              ...(await waitAll(
                ws,
                queued.map((q) => q.job.id),
                opts.wait,
              )),
            };
          }),
      ),
    );
  design.command('show <design>').action(
    command((id: string) =>
      withWorkspace(globals(), (ws) => {
        const d = getDesign(ws.db, id);
        return { design: { ...d, absPath: d.path ? ws.abs(d.path) : null }, reviews: listReviews(ws.db, id) };
      }),
    ),
  );
  design
    .command('note <project> <persona> <note>')
    .description(
      'How this project adapts the character (e.g. "covered shoulders, looser cut"); used by every sheet',
    )
    .action(
      command((projectRef: string, personaRef: string, note: string) =>
        withWorkspace(globals(), (ws) => {
          const project = getProject(ws.db, projectRef);
          const persona = getPersona(ws.db, personaRef);
          return {
            persona: persona.slug,
            note: setDesignNote(ws.db, project.id, persona.id, note, actorFromEnv()),
          };
        }),
      ),
    );

  const take = program
    .command('take')
    .description('Shot videos (分鏡視頻): video-to-video edits with the project video model');
  take
    .command('generate <project> [shots...]')
    .option('--all', 'every replace/clean shot that is ready for video')
    .option('--tier <tier>', 'draft (360p), preview (720p) or final (1080p); default: the project tier')
    .option('--extra <text>', 'extra instructions')
    .option(
      '--attach <files...>',
      'images to give with the instructions (an attached image path or any image file)',
    )
    .option('--prompt-file <file>', 'extra instructions from a file')
    .option('--from <takeId>', 'revise this take (same inputs, plus --extra)')
    .option('--force', 'generate a replace shot without an approved board')
    .option(
      '--retry-blocked',
      'send a shot the safety filter has already blocked limits.maxSafetyBlocks times',
    )
    .option(
      '--model <id>',
      'video model for this request (default: the project choice; see `project models`)',
    )
    .option(
      '--range <first-last>',
      "redo only these frames of the shot (0 = its first, e.g. 0-73); the others are kept from --keep's take",
    )
    .option('--keep <takeId>', 'with --range: the take whose other frames stay as they are')
    .option(
      '--seams <which>',
      'with --range: kept frames beside the part the director sees — both (default), before, after or none (when the neighbours are being redone too)',
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
            model?: string;
            attach?: string[];
            range?: string;
            keep?: string;
            seams?: string;
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const part = { ...rangeOpt(opts.range, opts.keep), ...seamsOpt(opts.seams) };
            if (part.range && (opts.all || shotIds.length !== 1))
              throw new AniError('usage', '--range is for one shot at a time');
            const project = getProject(ws.db, projectRef);
            const model = opts.model ?? projectModels(ws.db, project.id).video;
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
            // Named shots that keep getting blocked say so before any quota message.
            if (!opts.all) for (const id of ready) assertNotBlockedOut(ws.db, config, id, opts.retryBlocked);
            // Check the whole batch against today's quota before queueing any of it.
            if (config.provider !== 'fake' && process.env.ANIRECAST_PROVIDER !== 'fake')
              assertQuota(ws.db, config, model, ready.length, { includePending: true });
            const extra = extraText(opts);
            const queued = ready.map((id) =>
              queueTake(ws, id, tier, actorFromEnv(), {
                ...(extra ? { extra } : {}),
                ...(opts.from ? { fromTakeId: opts.from } : {}),
                force: Boolean(opts.force),
                retryBlocked: Boolean(opts.retryBlocked),
                model,
                ...attachOpt(opts.attach),
                ...part,
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
    .command('plan <shot>')
    .description(
      '預覽提示詞: let the video director watch the shot and write the instruction and the images to send, without making the video (one vision call)',
    )
    .option('--model <id>', 'video model to plan for (default: the project choice)')
    .option('--extra <text>', 'what the human wants (mandatory for the director)')
    .option(
      '--attach <files...>',
      'images to give with the instructions (an attached image path or any image file)',
    )
    .option('--range <first-last>', 'plan only these frames of the shot (with --keep, as `take generate`)')
    .option('--keep <takeId>', 'with --range: the take whose other frames stay as they are')
    .option('--seams <which>', 'with --range: both, before, after or none (as `take generate`)')
    .option('--wait')
    .action(
      command(
        (
          shotId: string,
          opts: {
            model?: string;
            extra?: string;
            attach?: string[];
            range?: string;
            keep?: string;
            seams?: string;
            wait?: boolean;
          },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const job = queueTakePlan(ws, shotId, actorFromEnv(), {
              ...attachOpt(opts.attach),
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.extra ? { extra: opts.extra } : {}),
              ...rangeOpt(opts.range, opts.keep),
              ...seamsOpt(opts.seams),
            });
            if (!opts.wait) return { job };
            await waitAll(ws, [job.id], true);
            return { plan: latestShotJob(ws, shotId, 'take.plan') };
          }),
      ),
    );
  take
    .command('merge <base> <parts...>')
    .description(
      "Join partial takes made from <base> side by side (e.g. each cut of a shot redone in parallel with --range --keep <base>): each part's frames from its take, the rest from the base. No model, no cost",
    )
    .option('--wait')
    .action(
      command((base: string, parts: string[], opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const { take, job } = queueTakeMerge(ws, base, parts, actorFromEnv());
          return { take, ...(await waitAll(ws, [job.id], opts.wait)) };
        }),
      ),
    );
  take
    .command('promote <shot>')
    .description(
      'Regenerate the approved take at final (1080p) with the same inputs (every shot video is 1080p now)',
    )
    .option('--retry-blocked', 'send even if the safety filter keeps blocking this shot')
    .option('--wait')
    .action(
      command((shotId: string, opts: { retryBlocked?: boolean; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const approved = approvedTake(ws.db, shotId);
          if (!approved) throw new AniError('conflict', 'This shot has no approved take to promote');
          if (approved.tier === 'final') throw new AniError('conflict', 'Already at the final tier');
          const next = 'final' as const;
          const q = queueTake(ws, shotId, next, actorFromEnv(), {
            fromTakeId: approved.id,
            retryBlocked: Boolean(opts.retryBlocked),
            // The approved look came from this take's model; the higher tier keeps it.
            model: approved.model,
          });
          return { take: q.take, ...(await waitAll(ws, [q.job.id], opts.wait)) };
        }),
      ),
    );
  take
    .command('still <project> <shots...>')
    .description('Hold the approved board for the length of each shot instead of a video (no model, no cost)')
    .option(
      '--tier <tier>',
      'output size: draft (360p), preview (720p) or final (1080p); default: the project tier',
    )
    .option('--wait', 'wait until the clips are made')
    .action(
      command((projectRef: string, shotIds: string[], opts: { tier?: GenerationTier; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const tier = opts.tier ?? getProject(ws.db, projectRef).generationTier;
          if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
          const queued = shotIds.map((id) => queueStillTake(ws, id, tier, actorFromEnv()));
          return {
            takes: queued.map((q) => q.take),
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
    .description("Same inputs, new attempt (on the version's own model unless --model names another)")
    .option('--model <id>', 'draw it with another model of the same kind (see `anirecast project models`)')
    .option('--wait')
    .action(
      command((id: string, opts: { wait?: boolean; model?: string }) =>
        withWorkspace(globals(), async (ws) => {
          const result = submitReview(ws, {
            targetId: id,
            verdict: 'regenerate',
            model: opts.model ?? null,
            actor: actorFromEnv(),
          });
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
    .option(
      '--replace-drafts',
      'with --draft: remove the earlier drafts when it is done (as the automatic draft does)',
    )
    .option('--tier <tier>', 'default: the project tier')
    .option('--wait')
    .action(
      command(
        (
          ref: string,
          opts: { draft?: boolean; replaceDrafts?: boolean; tier?: GenerationTier; wait?: boolean },
        ) =>
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
              payload: { renderId: r.id, ...(opts.draft && opts.replaceDrafts ? { auto: true } : {}) },
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
    .command('handoff <task>')
    .description(
      'Hand a task to Claude Code when it needs a code change (your sandbox writes only the workspace) or something the CLI cannot do: writes a brief and asks the human to start Claude on it',
    )
    .option('--to <agent>', 'who takes over (claude)', 'claude')
    .requiredOption('--reason <text>', 'why you cannot finish it yourself')
    .option('--tried <text>', 'what you tried, with version ids and what went wrong')
    .option('--plan <text>', 'how you would solve it')
    .action(
      command((id: string, opts: { to: string; reason: string; tried?: string; plan?: string }) =>
        withWorkspace(globals(), (ws) => {
          if (opts.to !== 'claude') throw new AniError('usage', 'Only --to claude is supported');
          return handOffToClaude(
            ws,
            id,
            {
              reason: opts.reason,
              ...(opts.tried ? { tried: opts.tried } : {}),
              ...(opts.plan ? { plan: opts.plan } : {}),
              repoRoot: REPO_ROOT,
            },
            actorFromEnv(),
          );
        }),
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
