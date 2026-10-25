import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  actorFromEnv,
  createClip,
  createProject,
  createSource,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getActiveClip,
  getProject,
  getShot,
  getSource,
  listKeyframes,
  listProjects,
  listShots,
  listSources,
  mergeShots,
  projectOfShot,
  type ShotMode,
  setGenerationTier,
  splitShot,
  updateShot,
  type Workspace,
} from '@anirecast/core';
import { formatTimecode, parseTimecode } from '@anirecast/media';
import { AniError } from '@anirecast/shared';
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

  const project = program.command('project').description('Projects (one recast of one source)');
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
    .action(
      command((id: string, opts: { at: string }) =>
        withWorkspace(globals(), (ws) => {
          const [a, b] = splitShot(ws.db, id, Number(opts.at), actorFromEnv());
          const project = projectOfShot(ws.db, a.id);
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
  shots.command('merge <first> <second>').action(
    command((a: string, b: string) =>
      withWorkspace(globals(), (ws) => {
        const merged = mergeShots(ws.db, a, b, actorFromEnv());
        const project = projectOfShot(ws.db, merged.id);
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
