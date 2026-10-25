import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentTaskStatus,
  addPersonaImage,
  answerAgentTask,
  assignTracklet,
  cancelAgentTask,
  createClip,
  createPersona,
  createProject,
  createRender,
  createSource,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getActiveClip,
  getCastMember,
  getJob,
  getPersona,
  getProject,
  getRender,
  getSource,
  getTake,
  initWorkspace,
  inspectWorkspace,
  type LookPolicy,
  latestEventSeq,
  listAgentTasks,
  listCast,
  listJobs,
  listPersonas,
  listProjects,
  listRenders,
  listShots,
  listSources,
  loadConfig,
  mapCast,
  markNotCharacter,
  mergeCast,
  mergeShots,
  type OverlayCategory,
  type PersonaView,
  projectOfShot,
  projectOverview,
  queueBoard,
  queueTake,
  readLock,
  recomputeShotModes,
  rememberWorkspace,
  renameCast,
  requestCancel,
  retryJob,
  type ShotMode,
  setGenerationTier,
  setLookPolicy,
  setOverlayRemoval,
  setPrimaryImage,
  setShotCastOverride,
  settleCast,
  shotDetail,
  shotStage,
  spendBreakdown,
  splitCast,
  splitShot,
  submitReview,
  TIERS,
  taskContext,
  totalSpend,
  trashSource,
  updatePersona,
  updateShot,
  type Verdict,
  type Workspace,
} from '@anirecast/core';
import { parseTimecode, probe } from '@anirecast/media';
import { AniError, type ErrorCode, toEnvelopeError } from '@anirecast/shared';
import type { Context, Hono } from 'hono';
import { serveWorkspaceFile } from './files.ts';

const USER = 'user';

const STATUS: Partial<Record<ErrorCode, 400 | 402 | 404 | 409 | 423 | 503>> = {
  usage: 400,
  naming_violation: 400,
  not_found: 404,
  conflict: 409,
  budget_exceeded: 402,
  workspace_locked: 423,
  daemon_not_running: 503,
  dependency_missing: 503,
};

/** Runs a handler and wraps its result (or error) in the same envelope the CLI prints. */
async function handle(c: Context, fn: () => unknown): Promise<Response> {
  try {
    return c.json({ ok: true, data: (await fn()) ?? null });
  } catch (error) {
    const e = toEnvelopeError(error);
    return c.json({ ok: false, error: e }, STATUS[e.code] ?? 500);
  }
}

const body = async <T>(c: Context): Promise<T> => {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
};

function queueMany<T>(
  ids: string[],
  fn: (id: string) => T,
): { queued: T[]; errors: Array<{ shotId: string; error: unknown }> } {
  const queued: T[] = [];
  const errors: Array<{ shotId: string; error: unknown }> = [];
  for (const id of ids) {
    try {
      queued.push(fn(id));
    } catch (error) {
      errors.push({ shotId: id, error: toEnvelopeError(error) });
    }
  }
  return { queued, errors };
}

function shotsForMode(
  ws: Workspace,
  projectRef: string,
  ids: string[] | undefined,
  modes: ShotMode[],
): string[] {
  if (ids && ids.length > 0) return ids;
  const clip = findActiveClip(ws.db, getProject(ws.db, projectRef).id);
  if (!clip) throw new AniError('conflict', 'Project has no clip');
  return listShots(ws.db, clip.id)
    .filter((s) => modes.includes(s.mode))
    .map((s) => s.id);
}

/**
 * JSON API for the Web UI. Every mutation uses the same core use cases as the CLI, with actor "user".
 * `onSwitchWorkspace` lets the process restart onto another workspace (launchd brings it back).
 */
export function registerRoutes(app: Hono, ws: Workspace, opts: { onSwitchWorkspace: () => void }): void {
  // ---- workspace -------------------------------------------------------------------------------
  app.get('/api/workspace', (c) =>
    handle(c, () => {
      const config = loadConfig();
      return {
        root: ws.root,
        manifest: ws.manifest,
        lock: readLock(ws.root) ?? null,
        latestEventSeq: latestEventSeq(ws.db),
        config: {
          provider: process.env.ANIRECAST_PROVIDER ?? config.provider,
          models: config.models,
          budget: config.budget,
          codex: { autoDispatch: config.codex.autoDispatch },
          recentWorkspaces: config.recentWorkspaces,
        },
        spend: { totalUsd: totalSpend(ws.db) },
      };
    }),
  );
  app.post('/api/workspace/inspect', async (c) =>
    handle(c, async () => inspectWorkspace((await body<{ path: string }>(c)).path)),
  );
  app.post('/api/workspace/switch', async (c) =>
    handle(c, async () => {
      const b = await body<{ path: string; create?: boolean; name?: string }>(c);
      if (!b.path) throw new AniError('usage', 'path is required');
      if (b.create) initWorkspace(b.path, b.name ? { name: b.name } : {}).close();
      const result = inspectWorkspace(b.path);
      if (!result.valid)
        throw new AniError('invalid_workspace', `Not a usable workspace: ${result.problems.join('; ')}`, {
          details: result,
        });
      rememberWorkspace(result.root);
      setTimeout(opts.onSwitchWorkspace, 300);
      return { root: result.root, restarting: true };
    }),
  );

  // ---- files -----------------------------------------------------------------------------------
  app.get('/api/files/*', (c) => serveWorkspaceFile(c, ws, c.req.path.slice('/api/files/'.length)));

  // ---- sources ---------------------------------------------------------------------------------
  app.get('/api/sources', (c) => handle(c, () => listSources(ws.db)));
  app.get('/api/sources/:id', (c) => handle(c, () => getSource(ws.db, c.req.param('id'))));
  app.delete('/api/sources/:id', (c) => handle(c, () => trashSource(ws, c.req.param('id'), USER)));
  app.post('/api/sources', async (c) =>
    handle(c, async () => {
      const { url } = await body<{ url: string }>(c);
      if (!/^https?:\/\//.test(url ?? '')) throw new AniError('usage', 'Expected an http(s) URL');
      const source = createSource(ws.db, { url, title: url, status: 'pending' }, USER);
      const job = enqueueJob(ws.db, {
        type: 'source.download',
        lane: 'io',
        payload: { sourceId: source.id, url },
        requestedBy: USER,
        maxAttempts: 2,
      });
      return { source, job };
    }),
  );
  app.post('/api/sources/import', async (c) =>
    handle(c, async () => {
      const { file, title } = await body<{ file: string; title?: string }>(c);
      if (!file) throw new AniError('usage', 'file is required');
      const source = createSource(ws.db, { title: title ?? path.parse(file).name, status: 'pending' }, USER);
      const job = enqueueJob(ws.db, {
        type: 'source.import',
        lane: 'io',
        payload: { sourceId: source.id, file: path.resolve(file) },
        requestedBy: USER,
      });
      return { source, job };
    }),
  );

  // ---- projects, clip, shots -------------------------------------------------------------------
  app.get('/api/projects', (c) => handle(c, () => listProjects(ws.db)));
  app.post('/api/projects', async (c) =>
    handle(c, async () => {
      const b = await body<{ sourceId: string; name: string }>(c);
      return createProject(ws.db, { name: b.name, sourceId: b.sourceId }, USER);
    }),
  );
  app.get('/api/projects/:ref', (c) => handle(c, () => projectOverview(ws, c.req.param('ref'))));
  app.post('/api/projects/:ref/tier', async (c) =>
    handle(c, async () =>
      setGenerationTier(ws.db, c.req.param('ref'), (await body<{ tier: GenerationTier }>(c)).tier, USER),
    ),
  );
  app.post('/api/projects/:ref/clip', async (c) =>
    handle(c, async () => {
      const b = await body<{ in: string | number; out: string | number; force?: boolean }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      const src = getSource(ws.db, project.sourceId);
      if (!src.fpsNum || !src.fpsDen) throw new AniError('conflict', 'Source is not ready');
      const frame = (v: string | number) =>
        typeof v === 'number' ? v : parseTimecode(v, src.fpsNum!, src.fpsDen!);
      const clip = createClip(
        ws.db,
        { projectRef: project.id, inFrame: frame(b.in), outFrame: frame(b.out) },
        USER,
        { force: Boolean(b.force) },
      );
      const job = enqueueJob(ws.db, {
        type: 'clip.extract',
        lane: 'media',
        projectId: project.id,
        payload: { clipId: clip.id },
        requestedBy: USER,
      });
      return { clip, job };
    }),
  );
  app.post('/api/projects/:ref/shots/detect', async (c) =>
    handle(c, async () => {
      const b = await body<{ detector?: string; threshold?: number; minSceneLen?: number }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      const clip = getActiveClip(ws.db, project.id);
      return enqueueJob(ws.db, {
        type: 'shots.detect',
        lane: 'media',
        projectId: project.id,
        payload: { clipId: clip.id, ...b },
        requestedBy: USER,
      });
    }),
  );
  app.get('/api/shots/:id', (c) => handle(c, () => shotDetail(ws, c.req.param('id'))));
  app.patch('/api/shots/:id', async (c) =>
    handle(c, async () => {
      const id = c.req.param('id');
      const b = await body<{ mode?: ShotMode; repFrame?: number; removeOtherOverlays?: boolean }>(c);
      const shot = updateShot(ws.db, id, b, USER);
      const project = projectOfShot(ws.db, id);
      if (b.repFrame !== undefined)
        enqueueJob(ws.db, {
          type: 'shots.prepare',
          lane: 'media',
          projectId: project.id,
          payload: { shotIds: [id] },
          requestedBy: USER,
        });
      if (b.removeOtherOverlays !== undefined)
        settleCast(ws, project.id, [id], 'overlay switch changed', USER);
      return shot;
    }),
  );
  app.post('/api/shots/:id/split', async (c) =>
    handle(c, async () => {
      const req = await body<{ at: number; force?: boolean }>(c);
      const [a, b] = splitShot(ws.db, c.req.param('id'), req.at, USER, Date.now(), {
        force: req.force === true,
      });
      recomputeShotModes(ws.db, projectOfShot(ws.db, a.id).id);
      enqueueJob(ws.db, {
        type: 'shots.prepare',
        lane: 'media',
        projectId: projectOfShot(ws.db, a.id).id,
        payload: { shotIds: [a.id, b.id] },
        requestedBy: USER,
      });
      return [a, b];
    }),
  );
  app.post('/api/shots/merge', async (c) =>
    handle(c, async () => {
      const b = await body<{ first: string; second: string }>(c);
      const merged = mergeShots(ws.db, b.first, b.second, USER);
      enqueueJob(ws.db, {
        type: 'shots.prepare',
        lane: 'media',
        projectId: projectOfShot(ws.db, merged.id).id,
        payload: { shotIds: [merged.id] },
        requestedBy: USER,
      });
      return merged;
    }),
  );
  app.patch('/api/overlays/:id', async (c) =>
    handle(c, async () => {
      const b = await body<{ remove?: boolean; category?: OverlayCategory }>(c);
      const overlay = setOverlayRemoval(ws.db, c.req.param('id'), b, USER);
      return {
        overlay,
        ...settleCast(
          ws,
          projectOfShot(ws.db, overlay.shotId).id,
          [overlay.shotId],
          'overlay decision changed',
          USER,
        ),
      };
    }),
  );
  app.post('/api/shots/:id/cast-override', async (c) =>
    handle(c, async () => {
      const shotId = c.req.param('id');
      const b = await body<{ castId: string; personaId?: string | null; keep?: boolean; clear?: boolean }>(c);
      setShotCastOverride(
        ws.db,
        shotId,
        b.castId,
        b.clear ? null : { personaId: b.personaId ?? null, keep: Boolean(b.keep) },
        USER,
      );
      return settleCast(ws, projectOfShot(ws.db, shotId).id, [shotId], 'per-shot override changed', USER);
    }),
  );

  // ---- cast & personas -------------------------------------------------------------------------
  app.get('/api/projects/:ref/cast', (c) =>
    handle(c, () => listCast(ws.db, getProject(ws.db, c.req.param('ref')).id)),
  );
  app.post('/api/projects/:ref/cast/identify', async (c) =>
    handle(c, async () => {
      const b = await body<{ redetect?: boolean }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      return enqueueJob(ws.db, {
        type: 'cast.identify',
        lane: 'media',
        projectId: project.id,
        payload: { projectId: project.id, redetect: Boolean(b.redetect) },
        requestedBy: USER,
      });
    }),
  );
  app.post('/api/projects/:ref/shots/analyze', (c) =>
    handle(c, () => {
      const project = getProject(ws.db, c.req.param('ref'));
      return enqueueJob(ws.db, {
        type: 'shots.analyze',
        lane: 'generate',
        projectId: project.id,
        payload: { projectId: project.id },
        requestedBy: USER,
      });
    }),
  );
  app.post('/api/cast/:id/map', async (c) =>
    handle(c, async () => {
      const { personaId } = await body<{ personaId: string | null }>(c);
      const { cast, affectedShotIds } = mapCast(ws.db, c.req.param('id'), personaId ?? null, USER);
      return { cast, ...settleCast(ws, cast.projectId, affectedShotIds, 'persona mapping changed', USER) };
    }),
  );
  app.post('/api/cast/:id/rename', async (c) =>
    handle(c, async () =>
      renameCast(ws.db, c.req.param('id'), (await body<{ label: string }>(c)).label, USER),
    ),
  );
  app.post('/api/cast/:id/merge', async (c) =>
    handle(c, async () => {
      const { drop } = await body<{ drop: string }>(c);
      const before = getCastMember(ws.db, drop).shotIds;
      const cast = mergeCast(ws.db, c.req.param('id'), drop, USER);
      return { cast, ...settleCast(ws, cast.projectId, before, 'cast merged', USER) };
    }),
  );
  app.post('/api/cast/:id/split', async (c) =>
    handle(c, async () => {
      const b = await body<{ trackletIds: string[]; label: string }>(c);
      const cast = splitCast(ws.db, c.req.param('id'), b.trackletIds, b.label, USER);
      return { cast, ...settleCast(ws, cast.projectId, cast.shotIds, 'cast split', USER) };
    }),
  );
  app.post('/api/tracklets/:id/assign', async (c) =>
    handle(c, async () => {
      const { castId } = await body<{ castId: string }>(c);
      const tracklet = assignTracklet(ws.db, c.req.param('id'), castId, USER);
      return {
        tracklet,
        ...settleCast(
          ws,
          getCastMember(ws.db, castId).projectId,
          [tracklet.shotId],
          'appearance reassigned',
          USER,
        ),
      };
    }),
  );
  app.post('/api/tracklets/:id/not-character', (c) =>
    handle(c, () => {
      const tracklet = markNotCharacter(ws.db, c.req.param('id'), USER);
      return {
        tracklet,
        ...settleCast(
          ws,
          projectOfShot(ws.db, tracklet.shotId).id,
          [tracklet.shotId],
          'detection dismissed',
          USER,
        ),
      };
    }),
  );
  app.post('/api/looks/:id/policy', async (c) =>
    handle(c, async () =>
      setLookPolicy(ws.db, c.req.param('id'), (await body<{ policy: LookPolicy }>(c)).policy, USER),
    ),
  );

  app.get('/api/personas', (c) =>
    handle(c, () => listPersonas(ws.db, { includeArchived: c.req.query('archived') === '1' })),
  );
  app.get('/api/personas/:ref', (c) => handle(c, () => getPersona(ws.db, c.req.param('ref'))));
  app.post('/api/personas', async (c) =>
    handle(c, async () => {
      const b = await body<{ name: string; description?: string; tags?: string[] }>(c);
      return createPersona(ws, b, USER);
    }),
  );
  app.patch('/api/personas/:ref', async (c) =>
    handle(c, async () => updatePersona(ws, c.req.param('ref'), await body(c), USER)),
  );
  app.post('/api/personas/:ref/images', (c) =>
    handle(c, async () => {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new AniError('usage', 'Upload a file in the "file" field');
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-upload-'));
      try {
        const ext = path.extname(file.name).toLowerCase() || '.png';
        const tmpFile = path.join(tmp, `upload${ext}`);
        writeFileSync(tmpFile, Buffer.from(await file.arrayBuffer()));
        const size = await probe(tmpFile).catch(() => undefined);
        return addPersonaImage(
          ws,
          c.req.param('ref'),
          tmpFile,
          {
            view: (form.view as PersonaView) ?? 'other',
            ...(form.primary === 'true' ? { primary: true } : {}),
            width: size?.width ?? null,
            height: size?.height ?? null,
          },
          USER,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }),
  );
  app.post('/api/persona-images/:id/primary', (c) =>
    handle(c, () => setPrimaryImage(ws, c.req.param('id'), USER)),
  );

  // ---- generation & review ---------------------------------------------------------------------
  app.post('/api/projects/:ref/boards', async (c) =>
    handle(c, async () => {
      const b = await body<{ shotIds?: string[]; extra?: string; fromBoardId?: string }>(c);
      const ids = shotsForMode(ws, c.req.param('ref'), b.shotIds, ['replace']);
      return queueMany(ids, (id) =>
        queueBoard(ws, id, USER, {
          ...(b.extra ? { extra: b.extra } : {}),
          ...(b.fromBoardId ? { fromBoardId: b.fromBoardId } : {}),
        }),
      );
    }),
  );
  app.post('/api/projects/:ref/takes', async (c) =>
    handle(c, async () => {
      const b = await body<{
        shotIds?: string[];
        tier?: GenerationTier;
        extra?: string;
        fromTakeId?: string;
        force?: boolean;
      }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      const tier = b.tier ?? (b.fromTakeId ? getTake(ws.db, b.fromTakeId).tier : project.generationTier);
      if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
      let ids = shotsForMode(ws, project.id, b.shotIds, ['replace', 'clean']);
      if (!b.shotIds?.length && !b.force)
        ids = ids.filter((id) => ['take_pending', 'stale', 'failed'].includes(shotStage(ws.db, id, tier)));
      return queueMany(ids, (id) =>
        queueTake(ws, id, tier, USER, {
          ...(b.extra ? { extra: b.extra } : {}),
          ...(b.fromTakeId ? { fromTakeId: b.fromTakeId } : {}),
          force: Boolean(b.force),
        }),
      );
    }),
  );
  app.post('/api/takes/:id/promote', (c) =>
    handle(c, () => {
      const take = getTake(ws.db, c.req.param('id'));
      if (take.status !== 'approved') throw new AniError('conflict', 'Only an approved take can be promoted');
      const next = TIERS[TIERS.indexOf(take.tier) + 1];
      if (!next) throw new AniError('conflict', 'Already at the final tier');
      return queueTake(ws, take.shotId, next, USER, { fromTakeId: take.id });
    }),
  );
  app.post('/api/reviews', async (c) =>
    handle(c, async () => {
      const b = await body<{ targetId: string; verdict: Verdict; comment?: string; annotations?: unknown[] }>(
        c,
      );
      return submitReview(ws, {
        targetId: b.targetId,
        verdict: b.verdict,
        comment: b.comment ?? null,
        annotations: b.annotations ?? [],
        actor: USER,
      });
    }),
  );

  // ---- renders ---------------------------------------------------------------------------------
  app.get('/api/projects/:ref/renders', (c) =>
    handle(c, () => listRenders(ws.db, getProject(ws.db, c.req.param('ref')).id)),
  );
  app.get('/api/renders/:id', (c) => handle(c, () => getRender(ws.db, c.req.param('id'))));
  app.post('/api/projects/:ref/renders', async (c) =>
    handle(c, async () => {
      const b = await body<{ draft?: boolean; tier?: GenerationTier }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      const render = createRender(ws.db, {
        projectId: project.id,
        kind: b.draft ? 'draft' : 'final',
        tier: b.tier ?? project.generationTier,
        createdBy: USER,
      });
      const job = enqueueJob(ws.db, {
        type: 'render.compose',
        lane: 'media',
        projectId: project.id,
        payload: { renderId: render.id },
        requestedBy: USER,
      });
      return { render, job };
    }),
  );

  // ---- tasks, jobs, cost -----------------------------------------------------------------------
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status') as AgentTaskStatus | undefined;
    return handle(c, () => listAgentTasks(ws.db, status ? { status } : {}));
  });
  app.get('/api/tasks/:id', (c) => handle(c, () => taskContext(ws, c.req.param('id'))));
  app.post('/api/tasks/:id/answer', async (c) =>
    handle(c, async () =>
      answerAgentTask(ws.db, c.req.param('id'), (await body<{ answer: string }>(c)).answer, USER),
    ),
  );
  app.post('/api/tasks/:id/cancel', (c) => handle(c, () => cancelAgentTask(ws.db, c.req.param('id'), USER)));
  app.get('/api/jobs/:id', (c) => handle(c, () => getJob(ws.db, c.req.param('id'))));
  app.get('/api/jobs', (c) =>
    handle(c, () => listJobs(ws.db, { limit: Number(c.req.query('limit') ?? 200) })),
  );
  app.post('/api/jobs/:id/cancel', (c) => handle(c, () => requestCancel(ws.db, c.req.param('id'), USER)));
  app.post('/api/jobs/:id/retry', (c) => handle(c, () => retryJob(ws.db, c.req.param('id'), USER)));
  app.get('/api/cost', (c) =>
    handle(c, () => {
      const ref = c.req.query('project');
      const projectId = ref ? getProject(ws.db, ref).id : undefined;
      return {
        totalUsd: totalSpend(ws.db, projectId ? { projectId } : {}),
        capUsd: loadConfig().budget.capUsd,
        breakdown: spendBreakdown(ws.db, projectId),
      };
    }),
  );
}
