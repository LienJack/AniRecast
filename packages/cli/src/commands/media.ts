import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  actorFromEnv,
  createClip,
  createProject,
  createSource,
  discardShotVersions,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getActiveClip,
  getBoundary,
  getProject,
  getShot,
  getSource,
  isHumanActor,
  latestShotCastCheck,
  listBoundaries,
  listKeyframes,
  listProjects,
  listShots,
  listSources,
  mergeShots,
  projectModels,
  projectOfShot,
  queueShotCast,
  queueStyleAnalysis,
  recomputeShotModes,
  recordBoundary,
  type ShotMode,
  setGenerationTier,
  setProjectModels,
  splitShot,
  trashSource,
  updateProjectSettings,
  updateShot,
  type Workspace,
} from '@anirecast/core';
import { formatTimecode, parseTimecode } from '@anirecast/media';
import { AniError, IMAGE_MODELS, VIDEO_MODELS } from '@anirecast/shared';
import type { Command } from 'commander';
import { type GlobalOptions, withWorkspace } from '../context.ts';
import { command, note } from '../output.ts';
import { unwrapJob, waitForJob } from '../wait.ts';

/** Seconds of a shot at the clip's rate; Omni edits accept at most 10 s per upload. */
const OMNI_MAX_SECONDS = 10;

function shotView(ws: Workspace, shotId: string) {
  const shot = getShot(ws.db, shotId);
  const project = projectOfShot(ws.db, shotId);
  const clip = findActiveClip(ws.db, project.id);
  const fps = clip ? clip.fpsNum / clip.fpsDen : 24;
  const seconds = shot.frameCount / fps;
  return {
    ...shot,
    seconds: Number(seconds.toFixed(3)),
    timecode: clip
      ? {
          start: formatTimecode(shot.startFrame, clip.fpsNum, clip.fpsDen),
          end: formatTimecode(shot.endFrame + 1, clip.fpsNum, clip.fpsDen),
        }
      : null,
    needsSplitForOmni: seconds > OMNI_MAX_SECONDS,
    keyframes: listKeyframes(ws.db, shotId),
  };
}

async function maybeWait(ws: Workspace, jobId: string, wait: boolean | undefined) {
  return wait ? unwrapJob(await waitForJob(ws, jobId)) : { jobId, queued: true };
}

export function registerMedia(program: Command): void {
  const globals = () => program.opts<GlobalOptions>();

  const source = program.command('source').description('The download collection (下載合集)');
  source
    .command('add <url>')
    .description('Download a video with yt-dlp (YouTube, Bilibili, Niconico, X, …)')
    .option('--wait', 'wait for the download to finish')
    .action(
      command((url: string, opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          if (!/^https?:\/\//.test(url)) throw new AniError('usage', 'Expected an http(s) URL');
          const src = createSource(ws.db, { url, title: url, status: 'pending' }, actorFromEnv());
          const job = enqueueJob(ws.db, {
            type: 'source.download',
            lane: 'io',
            payload: { sourceId: src.id, url },
            requestedBy: actorFromEnv(),
            maxAttempts: 2,
          });
          note(`source ${src.id} queued for download`);
          const waited = await maybeWait(ws, job.id, opts.wait);
          return { source: getSource(ws.db, src.id), job: waited };
        }),
      ),
    );
  source
    .command('import <file>')
    .description('Copy a local video file into the collection')
    .option('--title <title>', 'display title (default: file name)')
    .option('--wait', 'wait for the import to finish')
    .action(
      command((file: string, opts: { title?: string; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const abs = path.resolve(file);
          if (!existsSync(abs)) throw new AniError('not_found', `File not found: ${abs}`);
          const src = createSource(
            ws.db,
            { title: opts.title ?? path.parse(abs).name, status: 'pending' },
            actorFromEnv(),
          );
          const job = enqueueJob(ws.db, {
            type: 'source.import',
            lane: 'io',
            payload: { sourceId: src.id, file: abs },
            requestedBy: actorFromEnv(),
          });
          const waited = await maybeWait(ws, job.id, opts.wait);
          return { source: getSource(ws.db, src.id), job: waited };
        }),
      ),
    );
  source.command('list').action(command(() => withWorkspace(globals(), (ws) => listSources(ws.db))));
  source
    .command('show <id>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => getSource(ws.db, id))));
  source
    .command('remove <id>')
    .description('Move a source to the workspace trash (refused while a project uses it)')
    .action(command((id: string) => withWorkspace(globals(), (ws) => trashSource(ws, id, actorFromEnv()))));

  const project = program.command('project').description('Projects (one recast of one source)');
  project
    .command('style <project>')
    .description(
      "Show the project's art-style notes (used in every design, board and take prompt); --analyze reads them and each shot's lighting from the clip",
    )
    .option(
      '--analyze',
      'read the style from the frames and the lighting of each generated shot (vision model)',
    )
    .option('--relight', 'with --analyze, also redo shots that already have lighting')
    .option('--set <text>', 'write the notes yourself')
    .option('--wait', 'wait for the analysis')
    .action(
      command(
        (projectRef: string, opts: { analyze?: boolean; relight?: boolean; set?: string; wait?: boolean }) =>
          withWorkspace(globals(), async (ws) => {
            if (opts.set !== undefined)
              updateProjectSettings(
                ws.db,
                projectRef,
                { styleNotes: opts.set.trim() || null },
                actorFromEnv(),
              );
            if (opts.analyze) {
              const job = queueStyleAnalysis(ws, projectRef, actorFromEnv(), {
                relight: Boolean(opts.relight),
              });
              if (opts.wait) await waitForJob(ws, job.id);
              else return { job };
            }
            const project = getProject(ws.db, projectRef);
            const clip = findActiveClip(ws.db, project.id);
            return {
              styleNotes: project.settings.styleNotes ?? '',
              lighting: clip
                ? listShots(ws.db, clip.id)
                    .filter((s) => s.lighting)
                    .map((s) => ({ shot: s.orderIndex + 1, lighting: s.lighting }))
                : [],
            };
          }),
      ),
    );
  project
    .command('models <project>')
    .description(
      'Show or choose the models a project generates with (image: storyboard frames, design: character sheets, video: shot videos)',
    )
    .option('--image <id>', 'storyboard frame model')
    .option('--design <id>', 'character design model')
    .option('--video <id>', 'shot video model (video-to-video)')
    .option('--reset', 'go back to the workspace defaults')
    .action(
      command(
        (projectRef: string, opts: { image?: string; design?: string; video?: string; reset?: boolean }) =>
          withWorkspace(globals(), (ws) => {
            const patch = opts.reset
              ? { image: null, design: null, video: null }
              : {
                  ...(opts.image ? { image: opts.image } : {}),
                  ...(opts.design ? { design: opts.design } : {}),
                  ...(opts.video ? { video: opts.video } : {}),
                };
            const models = Object.keys(patch).length
              ? setProjectModels(ws.db, projectRef, patch, actorFromEnv())
              : projectModels(ws.db, projectRef);
            return { models, choices: { image: IMAGE_MODELS, video: VIDEO_MODELS } };
          }),
      ),
    );
  project
    .command('create')
    .requiredOption('--source <id>', 'source id')
    .requiredOption('--name <name>', 'display name')
    .option('--slug <slug>', 'folder name (default: from the name)')
    .action(
      command((opts: { source: string; name: string; slug?: string }) =>
        withWorkspace(globals(), (ws) =>
          createProject(
            ws.db,
            { name: opts.name, sourceId: opts.source, ...(opts.slug ? { slug: opts.slug } : {}) },
            actorFromEnv(),
          ),
        ),
      ),
    );
  project.command('list').action(command(() => withWorkspace(globals(), (ws) => listProjects(ws.db))));
  project.command('show <project>').action(
    command((ref: string) =>
      withWorkspace(globals(), (ws) => {
        const p = getProject(ws.db, ref);
        const clip = findActiveClip(ws.db, p.id);
        return {
          project: p,
          source: getSource(ws.db, p.sourceId),
          clip: clip ?? null,
          shots: clip ? listShots(ws.db, clip.id).length : 0,
        };
      }),
    ),
  );
  project
    .command('tier <project> <tier>')
    .description('Generation tier for paid generation: draft (cheapest), preview (720p) or final (1080p)')
    .action(
      command((ref: string, tier: GenerationTier) =>
        withWorkspace(globals(), (ws) => setGenerationTier(ws.db, ref, tier, actorFromEnv())),
      ),
    );

  const clip = program.command('clip').description('The selected time range (節選)');
  clip
    .command('set <project>')
    .description('Confirm the clip range; cuts a frame-accurate master and starts shot detection')
    .requiredOption('--in <timecode>', 'start: 83.5, 1:23.5, 00:01:23.500 or f:<frame>')
    .requiredOption('--out <timecode>', 'end (exclusive), same formats')
    .option('--force', 'replace a clip that already has generated versions (kept as history)')
    .option('--wait', 'wait for the master cut (shot detection continues in the background)')
    .action(
      command((ref: string, opts: { in: string; out: string; force?: boolean; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const p = getProject(ws.db, ref);
          const src = getSource(ws.db, p.sourceId);
          if (!src.fpsNum || !src.fpsDen) throw new AniError('conflict', 'Source is not ready');
          const inFrame = parseTimecode(opts.in, src.fpsNum, src.fpsDen);
          const outFrame = parseTimecode(opts.out, src.fpsNum, src.fpsDen);
          const c = createClip(ws.db, { projectRef: p.id, inFrame, outFrame }, actorFromEnv(), {
            force: Boolean(opts.force),
          });
          const job = enqueueJob(ws.db, {
            type: 'clip.extract',
            lane: 'media',
            projectId: p.id,
            payload: { clipId: c.id },
            requestedBy: actorFromEnv(),
          });
          const waited = await maybeWait(ws, job.id, opts.wait);
          return { clip: getActiveClip(ws.db, p.id), job: waited };
        }),
      ),
    );
  clip
    .command('show <project>')
    .action(
      command((ref: string) =>
        withWorkspace(globals(), (ws) => getActiveClip(ws.db, getProject(ws.db, ref).id)),
      ),
    );

  const shots = program.command('shots').description('Shot list (分鏡)');
  shots
    .command('detect <project>')
    .description('Re-run cut detection on the active clip')
    .option('--detector <name>', 'adaptive (default) or content')
    .option('--threshold <n>', 'detector threshold')
    .option('--min-scene-len <frames>', 'minimum shot length in frames')
    .option('--wait', 'wait for detection and keyframes')
    .action(
      command(
        (
          ref: string,
          opts: { detector?: string; threshold?: string; minSceneLen?: string; wait?: boolean },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const p = getProject(ws.db, ref);
            const c = getActiveClip(ws.db, p.id);
            const job = enqueueJob(ws.db, {
              type: 'shots.detect',
              lane: 'media',
              projectId: p.id,
              payload: {
                clipId: c.id,
                ...(opts.detector ? { detector: opts.detector } : {}),
                ...(opts.threshold ? { threshold: Number(opts.threshold) } : {}),
                ...(opts.minSceneLen ? { minSceneLen: Number(opts.minSceneLen) } : {}),
              },
              requestedBy: actorFromEnv(),
            });
            return maybeWait(ws, job.id, opts.wait);
          }),
      ),
    );
  shots.command('list <project>').action(
    command((ref: string) =>
      withWorkspace(globals(), (ws) => {
        const p = getProject(ws.db, ref);
        const c = getActiveClip(ws.db, p.id);
        return listShots(ws.db, c.id).map((s) => shotView(ws, s.id));
      }),
    ),
  );
  shots
    .command('show <shot>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => shotView(ws, id))));
  shots
    .command('split <shot>')
    .requiredOption('--at <frame>', 'first frame (clip numbering) of the new second shot')
    .option('--force', 'split a shot that already has boards or takes (they turn stale)')
    .action(
      command((id: string, opts: { at: string; force?: boolean }) =>
        withWorkspace(globals(), (ws) => {
          const [a, b] = splitShot(ws.db, id, Number(opts.at), actorFromEnv(), Date.now(), {
            force: opts.force === true,
          });
          const project = projectOfShot(ws.db, a.id);
          recomputeShotModes(ws.db, project.id);
          enqueueJob(ws.db, {
            type: 'shots.prepare',
            lane: 'media',
            projectId: project.id,
            payload: { shotIds: [a.id, b.id] },
            requestedBy: actorFromEnv(),
          });
          return [a, b];
        }),
      ),
    );
  shots
    .command('continuity <project>')
    .description(
      'Judge every cut with the continuity model and find cuts inside one continuous moment (suggestions only by default)',
    )
    .option('--apply', 'merge confident runs (only shots without boards or takes)')
    .option('--review', 'hand unsure cuts and the merges made to Codex as a shot_review task')
    .option('--rejudge', 'judge cuts again even when this model already did')
    .option('--wait', 'wait for the result')
    .action(
      command(
        (
          projectRef: string,
          opts: { apply?: boolean; review?: boolean; rejudge?: boolean; wait?: boolean },
        ) =>
          withWorkspace(globals(), async (ws) => {
            const project = getProject(ws.db, projectRef);
            const clip = findActiveClip(ws.db, project.id);
            if (!clip) throw new AniError('conflict', 'Project has no clip');
            const job = enqueueJob(ws.db, {
              type: 'shots.continuity',
              lane: 'generate',
              projectId: project.id,
              payload: {
                clipId: clip.id,
                apply: opts.apply === true,
                review: opts.review === true,
                rejudge: opts.rejudge === true,
                chain: false,
              },
              requestedBy: actorFromEnv(),
            });
            return maybeWait(ws, job.id, opts.wait);
          }),
      ),
    );
  shots
    .command('boundaries <project>')
    .description('Every recorded decision about a cut: same moment or cut, by whom, how sure')
    .action(
      command((projectRef: string) =>
        withWorkspace(globals(), (ws) => {
          const clip = findActiveClip(ws.db, getProject(ws.db, projectRef).id);
          if (!clip) throw new AniError('conflict', 'Project has no clip');
          const starts = new Map(listShots(ws.db, clip.id).map((s, i) => [s.startFrame, i + 1]));
          return listBoundaries(ws.db, clip.id).map((b) => ({
            ...b,
            // Still a cut today, and which shot starts there; a merged boundary has no shot.
            startsShot: starts.get(b.atFrame) ?? null,
            sheetAbsPath: b.sheetPath ? ws.abs(b.sheetPath) : null,
          }));
        }),
      ),
    );
  shots
    .command('boundary <project>')
    .description('Record a decision about a cut without merging or splitting (yours are locked)')
    .requiredOption('--at <frame>', 'first frame of the later shot (clip numbering)')
    .option('--cut', 'the two sides are different moments: keep the cut')
    .option('--same', 'the two sides are one moment (use `shots merge` to merge them)')
    .option('--reason <text>', 'why')
    .action(
      command((projectRef: string, opts: { at: string; cut?: boolean; same?: boolean; reason?: string }) =>
        withWorkspace(globals(), (ws) => {
          if (Boolean(opts.cut) === Boolean(opts.same))
            throw new AniError('usage', 'Pass exactly one of --cut or --same');
          const clip = findActiveClip(ws.db, getProject(ws.db, projectRef).id);
          if (!clip) throw new AniError('conflict', 'Project has no clip');
          const actor = actorFromEnv();
          const stored = recordBoundary(ws.db, {
            clipId: clip.id,
            atFrame: Number(opts.at),
            verdict: opts.cut ? 'cut' : 'same_moment',
            decidedBy: actor,
            locked: isHumanActor(actor),
            ...(opts.reason ? { reason: opts.reason } : {}),
          });
          if (!stored)
            throw new AniError('conflict', 'A person already decided this cut; it is locked', {
              hint: 'Leave it, or ask the human.',
            });
          return getBoundary(ws.db, clip.id, Number(opts.at));
        }),
      ),
    );
  shots
    .command('find-cast <shot>')
    .description(
      '找出這一鏡的角色: detect the people of a shot (if it has none), let the vision model say which character each is, assign them unlocked for the human to confirm',
    )
    .option('--wait', 'wait for the result')
    .action(
      command((shotId: string, opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const job = queueShotCast(ws, shotId, actorFromEnv());
          if (!opts.wait) return { job };
          return { job: unwrapJob(await waitForJob(ws, job.id)), check: latestShotCastCheck(ws, shotId) };
        }),
      ),
    );
  shots
    .command('discard-versions <shot>')
    .description(
      'Delete every storyboard frame and take of a shot (files go to trash/versions/…) so it can be split or merged',
    )
    .action(
      command((shotId: string) =>
        withWorkspace(globals(), (ws) => discardShotVersions(ws, shotId, actorFromEnv())),
      ),
    );
  shots
    .command('merge <first> <second>')
    .description('Merge two adjacent shots (one continuous moment cut into two)')
    .option('--force', 'merge shots that already have boards or takes (they turn stale)')
    .option('--reason <text>', 'why they belong together (kept with the merge)')
    .action(
      command((a: string, b: string, opts: { force?: boolean; reason?: string }) =>
        withWorkspace(globals(), (ws) => {
          const merged = mergeShots(ws.db, a, b, actorFromEnv(), Date.now(), {
            force: opts.force === true,
            ...(opts.reason ? { reason: opts.reason } : {}),
          });
          const project = projectOfShot(ws.db, merged.id);
          recomputeShotModes(ws.db, project.id);
          enqueueJob(ws.db, {
            type: 'shots.prepare',
            lane: 'media',
            projectId: project.id,
            payload: { shotIds: [merged.id] },
            requestedBy: actorFromEnv(),
          });
          return merged;
        }),
      ),
    );
  shots
    .command('set <shot>')
    .option('--mode <mode>', 'replace | clean | keep | exclude')
    .option('--rep-frame <frame>', 'representative frame for the board (clip numbering)')
    .option('--remove-other-overlays <bool>', 'also remove title and other overlaid text (true|false)')
    .action(
      command((id: string, opts: { mode?: ShotMode; repFrame?: string; removeOtherOverlays?: string }) =>
        withWorkspace(globals(), (ws) => {
          const updated = updateShot(
            ws.db,
            id,
            {
              ...(opts.mode ? { mode: opts.mode } : {}),
              ...(opts.repFrame ? { repFrame: Number(opts.repFrame) } : {}),
              ...(opts.removeOtherOverlays
                ? { removeOtherOverlays: opts.removeOtherOverlays === 'true' }
                : {}),
            },
            actorFromEnv(),
          );
          if (opts.repFrame) {
            enqueueJob(ws.db, {
              type: 'shots.prepare',
              lane: 'media',
              projectId: projectOfShot(ws.db, id).id,
              payload: { shotIds: [id] },
              requestedBy: actorFromEnv(),
            });
          }
          return updated;
        }),
      ),
    );
}
