import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentTaskStatus,
  API_KEYS,
  type AssetKind,
  addPersonaImage,
  addReference,
  answerAgentTask,
  apiKeySource,
  applyHandoff,
  assertQuota,
  assignTracklet,
  type BoardRole,
  cancelAgentTask,
  checkAttachments,
  closeHandoff,
  createClip,
  createHandoff,
  createPersona,
  createProject,
  createRender,
  createSource,
  DESIGN_KINDS,
  type DesignKind,
  designOverview,
  discardShotVersions,
  enqueueJob,
  findActiveClip,
  type GenerationTier,
  getActiveClip,
  getAgentTask,
  getBoard,
  getCastMember,
  getHandoff,
  getJob,
  getPersona,
  getProject,
  getRender,
  getSource,
  getTake,
  type HandoffTarget,
  handoffPrompt,
  initWorkspace,
  inspectWorkspace,
  type KeyedProvider,
  type LookPolicy,
  latestEventSeq,
  listAgentTasks,
  listCast,
  listHandoffs,
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
  projectModels,
  projectOfShot,
  projectOverview,
  projectSummaries,
  queueBoard,
  queueBoards,
  queueCastAnalysis,
  queueDesign,
  queueOriginalDesign,
  queueReferenceSearch,
  queueShotCast,
  queueStillTake,
  queueStyleAnalysis,
  queueTake,
  queueTakePlan,
  quotaOverview,
  type ReferenceStatus,
  readHandoffResultFile,
  readLock,
  recomputeShotModes,
  rememberWorkspace,
  renameCast,
  requestCancel,
  retryJob,
  type ShotMode,
  saveAttachment,
  setAnalysisPicks,
  setDesignNote,
  setGenerationTier,
  setLookPolicy,
  setOverlayRemoval,
  setPrimaryImage,
  setProjectModels,
  setShotCastOverride,
  settleCast,
  shotDetail,
  shotStage,
  spendBreakdown,
  splitCast,
  splitShot,
  submitHandoff,
  submitReview,
  TIERS,
  taskContext,
  totalSpend,
  trashSource,
  updatePersona,
  updatePersonaImage,
  updateProjectSettings,
  updateReference,
  updateShot,
  type Verdict,
  type Workspace,
} from '@anirecast/core';
import { parseTimecode, probe } from '@anirecast/media';
import { AniError, type ErrorCode, IMAGE_MODELS, toEnvelopeError, VIDEO_MODELS } from '@anirecast/shared';
import type { Context, Hono } from 'hono';
import type { CodexDiscussions } from '../codex/discussions.ts';
import { addReferenceFromUrl } from '../handlers/references.ts';
import { serveWorkspaceFile } from './files.ts';

const USER = 'user';

const imageModelOrThrow = (model: string) => {
  if (!IMAGE_MODELS.some((m) => m.id === model))
    throw new AniError('usage', `Not a selectable image model: ${model}`);
};
const videoModelOrThrow = (model: string) => {
  if (!VIDEO_MODELS.some((m) => m.id === model))
    throw new AniError('usage', `Not a selectable video model: ${model}`);
};

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
export function registerRoutes(
  app: Hono,
  ws: Workspace,
  opts: { onSwitchWorkspace: () => void; discussions?: CodexDiscussions | undefined },
): void {
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
          codex: {
            autoDispatch: config.codex.autoDispatch,
            model: config.codex.model,
            effort: config.codex.effort,
          },
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
  app.get('/api/projects', (c) =>
    handle(c, () => (c.req.query('summary') === '1' ? projectSummaries(ws) : listProjects(ws.db))),
  );
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
  app.post('/api/shots/:id/discard-versions', (c) =>
    handle(c, () => discardShotVersions(ws, c.req.param('id'), USER)),
  );
  app.post('/api/shots/merge', async (c) =>
    handle(c, async () => {
      const b = await body<{ first: string; second: string; force?: boolean; reason?: string }>(c);
      const merged = mergeShots(ws.db, b.first, b.second, USER, Date.now(), {
        force: b.force === true,
        ...(b.reason ? { reason: b.reason } : {}),
      });
      recomputeShotModes(ws.db, projectOfShot(ws.db, merged.id).id);
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
  app.post('/api/shots/:id/cast/find', (c) => handle(c, () => queueShotCast(ws, c.req.param('id'), USER)));
  app.post('/api/shots/:id/takes/plan', async (c) =>
    handle(c, async () => {
      const b = await body<{ model?: string; extra?: string; attachments?: string[] }>(c);
      if (b.model) videoModelOrThrow(b.model);
      return queueTakePlan(ws, c.req.param('id'), USER, {
        ...(b.model ? { model: b.model } : {}),
        ...(b.extra?.trim() ? { extra: b.extra.trim() } : {}),
        ...(b.attachments?.length ? { attachments: b.attachments } : {}),
      });
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
  app.post('/api/projects/:ref/cast/tidy', (c) =>
    handle(c, () => {
      const project = getProject(ws.db, c.req.param('ref'));
      return enqueueJob(ws.db, {
        type: 'cast.tidy',
        lane: 'generate',
        projectId: project.id,
        payload: { projectId: project.id },
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
    handle(c, () => {
      const kind = c.req.query('kind') as AssetKind | undefined;
      return listPersonas(ws.db, {
        includeArchived: c.req.query('archived') === '1',
        ...(kind ? { kind } : {}),
      });
    }),
  );
  app.get('/api/personas/:ref', (c) => handle(c, () => getPersona(ws.db, c.req.param('ref'))));
  app.post('/api/personas', async (c) =>
    handle(c, async () => {
      const b = await body<{ name: string; description?: string; tags?: string[]; kind?: AssetKind }>(c);
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
            ...(typeof form.label === 'string' && form.label.trim() ? { label: form.label } : {}),
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
  app.patch('/api/persona-images/:id', async (c) =>
    handle(c, async () =>
      updatePersonaImage(ws, c.req.param('id'), await body<{ label?: string; view?: PersonaView }>(c), USER),
    ),
  );

  // ---- generation & review ---------------------------------------------------------------------
  app.get('/api/projects/:ref/designs', (c) =>
    handle(c, () => designOverview(ws.db, getProject(ws.db, c.req.param('ref')).id)),
  );
  app.post('/api/projects/:ref/designs', async (c) =>
    handle(c, async () => {
      const b = await body<{
        castId?: string;
        personaId?: string;
        kind?: DesignKind;
        extra?: string;
        fromDesignId?: string;
        model?: string;
        attachments?: string[];
      }>(c);
      if (b.model) imageModelOrThrow(b.model);
      return queueDesign(
        ws,
        c.req.param('ref'),
        b.fromDesignId ? null : (b.castId ?? b.personaId ?? null),
        USER,
        {
          ...(b.kind ? { kind: b.kind } : {}),
          ...(b.extra ? { extra: b.extra } : {}),
          ...(b.fromDesignId ? { fromDesignId: b.fromDesignId } : {}),
          ...(b.model ? { model: b.model } : {}),
          ...(b.attachments?.length ? { attachments: b.attachments } : {}),
        },
      );
    }),
  );
  // ---- models: what each project generates with ----------------------------------------------------
  app.get('/api/models', (c) =>
    handle(c, () => ({ image: IMAGE_MODELS, video: VIDEO_MODELS, defaults: loadConfig().models })),
  );
  app.patch('/api/projects/:ref/models', async (c) =>
    handle(c, async () =>
      setProjectModels(
        ws.db,
        c.req.param('ref'),
        await body<{ image?: string | null; design?: string | null; video?: string | null }>(c),
        USER,
      ),
    ),
  );
  app.post('/api/projects/:ref/designs/analyze', async (c) =>
    handle(c, async () => {
      const b = await body<{ castId?: string; generate?: boolean; model?: string }>(c);
      if (b.model) imageModelOrThrow(b.model);
      return queueCastAnalysis(ws, c.req.param('ref'), b.castId ?? null, USER, {
        ...(b.generate ? { thenKinds: [...DESIGN_KINDS] } : {}),
        ...(b.model ? { model: b.model } : {}),
      });
    }),
  );
  // ---- 官方設定集: reference images of an original character and her own sheets ---------------------------
  app.post('/api/projects/:ref/designs/references/search', async (c) =>
    handle(c, async () => {
      const b = await body<{ castId: string }>(c);
      return queueReferenceSearch(ws, c.req.param('ref'), b.castId, USER);
    }),
  );
  // Images the human attaches to what they tell an agent or a model.
  app.post('/api/projects/:ref/attachments', async (c) =>
    handle(c, async () => {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new AniError('usage', 'Upload an image in the "file" field');
      return saveAttachment(
        ws,
        c.req.param('ref'),
        new Uint8Array(await file.arrayBuffer()),
        file.type || file.name,
      );
    }),
  );
  app.post('/api/cast/:id/references', async (c) =>
    handle(c, async () => {
      const type = c.req.header('content-type') ?? '';
      if (type.includes('multipart/form-data')) {
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) throw new AniError('usage', 'Upload a file in the "file" field');
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-ref-'));
        try {
          const ext = path.extname(file.name).toLowerCase() || '.png';
          const tmpFile = path.join(tmp, `upload${ext}`);
          writeFileSync(tmpFile, Buffer.from(await file.arrayBuffer()));
          return addReference(
            ws,
            c.req.param('id'),
            tmpFile,
            { status: 'accepted', label: typeof form.label === 'string' ? form.label : '上傳的參考' },
            USER,
          );
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      const b = await body<{ url: string }>(c);
      if (!/^https?:\/\//.test(b.url ?? '')) throw new AniError('usage', 'Give an http(s) image URL');
      return addReferenceFromUrl(ws, c.req.param('id'), b.url, USER);
    }),
  );
  app.patch('/api/references/:id', async (c) =>
    handle(c, async () =>
      updateReference(
        ws.db,
        c.req.param('id'),
        await body<{ status?: ReferenceStatus; label?: string }>(c),
        USER,
      ),
    ),
  );
  app.post('/api/projects/:ref/designs/original', async (c) =>
    handle(c, async () => {
      const b = await body<{
        castId: string;
        kind?: DesignKind;
        extra?: string;
        fromDesignId?: string;
        model?: string;
        attachments?: string[];
      }>(c);
      if (b.model) imageModelOrThrow(b.model);
      return queueOriginalDesign(ws, c.req.param('ref'), b.castId, USER, {
        ...(b.kind ? { kind: b.kind } : {}),
        ...(b.extra ? { extra: b.extra } : {}),
        ...(b.fromDesignId ? { fromDesignId: b.fromDesignId } : {}),
        ...(b.model ? { model: b.model } : {}),
        ...(b.attachments?.length ? { attachments: b.attachments } : {}),
      });
    }),
  );
  // ---- art style: notes for every prompt, and each shot's lighting --------------------------------------
  app.post('/api/projects/:ref/style/analyze', async (c) =>
    handle(c, async () => {
      const b = await body<{ relight?: boolean }>(c);
      return queueStyleAnalysis(ws, c.req.param('ref'), USER, { relight: Boolean(b.relight) });
    }),
  );
  app.patch('/api/projects/:ref/style', async (c) =>
    handle(c, async () => {
      const b = await body<{ notes: string }>(c);
      const project = updateProjectSettings(
        ws.db,
        c.req.param('ref'),
        { styleNotes: b.notes?.trim() || null },
        USER,
      );
      return { notes: project.settings.styleNotes ?? '' };
    }),
  );
  app.post('/api/cast/:id/analysis/picks', async (c) =>
    handle(c, async () =>
      setAnalysisPicks(
        ws.db,
        c.req.param('id'),
        await body<{ expressions?: number[]; poses?: number[] }>(c),
        USER,
      ),
    ),
  );
  app.post('/api/projects/:ref/designs/note', async (c) =>
    handle(c, async () => {
      const b = await body<{ personaId: string; note: string }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      return {
        note: setDesignNote(ws.db, project.id, getPersona(ws.db, b.personaId).id, b.note ?? '', USER),
      };
    }),
  );
  app.post('/api/projects/:ref/boards', async (c) =>
    handle(c, async () => {
      const b = await body<{
        shotIds?: string[];
        extra?: string;
        fromBoardId?: string;
        model?: string;
        role?: BoardRole;
        attachments?: string[];
      }>(c);
      const ids = shotsForMode(ws, c.req.param('ref'), b.shotIds, ['replace']);
      if (b.model) imageModelOrThrow(b.model);
      const opts = {
        ...(b.extra ? { extra: b.extra } : {}),
        ...(b.model ? { model: b.model } : {}),
        ...(b.attachments?.length ? { attachments: b.attachments } : {}),
      };
      // One moment (a revision, or a single role) or all three storyboard frames of each shot.
      return queueMany(ids, (id) =>
        b.fromBoardId || b.role
          ? {
              boards: [
                queueBoard(ws, id, USER, {
                  ...opts,
                  ...(b.fromBoardId ? { fromBoardId: b.fromBoardId } : {}),
                  ...(b.role ? { role: b.role } : {}),
                }),
              ],
              skipped: [],
            }
          : queueBoards(ws, id, USER, opts),
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
        retryBlocked?: boolean;
        model?: string;
        attachments?: string[];
      }>(c);
      const project = getProject(ws.db, c.req.param('ref'));
      if (b.model) videoModelOrThrow(b.model);
      const model = b.model ?? projectModels(ws.db, project.id).video;
      const tier = b.tier ?? (b.fromTakeId ? getTake(ws.db, b.fromTakeId).tier : project.generationTier);
      if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
      let ids = shotsForMode(ws, project.id, b.shotIds, ['replace', 'clean']);
      if (!b.shotIds?.length && !b.force)
        ids = ids.filter((id) => ['take_pending', 'stale', 'failed'].includes(shotStage(ws.db, id, tier)));
      const config = loadConfig();
      // The whole batch must fit in today's quota before any of it is queued.
      if (config.provider !== 'fake' && process.env.ANIRECAST_PROVIDER !== 'fake')
        assertQuota(ws.db, config, model, ids.length, { includePending: true });
      return queueMany(ids, (id) =>
        queueTake(ws, id, tier, USER, {
          ...(b.extra ? { extra: b.extra } : {}),
          ...(b.fromTakeId ? { fromTakeId: b.fromTakeId } : {}),
          force: Boolean(b.force),
          retryBlocked: Boolean(b.retryBlocked),
          model,
          ...(b.attachments?.length ? { attachments: b.attachments } : {}),
        }),
      );
    }),
  );
  app.post('/api/shots/:id/still-take', async (c) =>
    handle(c, async () => {
      const b = await body<{ tier?: GenerationTier }>(c);
      const shotId = c.req.param('id');
      const tier = b.tier ?? projectOfShot(ws.db, shotId).generationTier;
      if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
      return queueStillTake(ws, shotId, tier, USER);
    }),
  );
  app.post('/api/takes/:id/promote', async (c) =>
    handle(c, async () => {
      const b = await body<{ retryBlocked?: boolean; model?: string }>(c);
      const take = getTake(ws.db, c.req.param('id'));
      if (take.status !== 'approved') throw new AniError('conflict', 'Only an approved take can be promoted');
      // Shot videos are 1080p now: an approved draft or preview take is redone straight at final.
      const next: GenerationTier | undefined = take.tier === 'final' ? undefined : 'final';
      if (!next) throw new AniError('conflict', 'Already at the final tier');
      if (b.model) videoModelOrThrow(b.model);
      // The approved look came from this take's model: the higher tier uses it too unless told otherwise.
      return queueTake(ws, take.shotId, next, USER, {
        fromTakeId: take.id,
        retryBlocked: Boolean(b.retryBlocked),
        model: b.model ?? take.model,
      });
    }),
  );
  app.post('/api/reviews', async (c) =>
    handle(c, async () => {
      const b = await body<{
        targetId: string;
        verdict: Verdict;
        comment?: string;
        annotations?: unknown[];
        model?: string;
        attachments?: string[];
      }>(c);
      return submitReview(ws, {
        targetId: b.targetId,
        verdict: b.verdict,
        comment: b.comment ?? null,
        annotations: b.annotations ?? [],
        model: b.model ?? null,
        ...(b.attachments?.length ? { attachments: b.attachments } : {}),
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
  // ---- Codex discussions: export a hard problem to its own Codex thread, import the conclusion ---------
  const discussionView = (handoffId: string) => {
    const h = getHandoff(ws.db, handoffId);
    const id = h.targetId;
    const targetShotId = !id
      ? null
      : h.targetType === 'shot'
        ? id
        : h.targetType === 'board'
          ? getBoard(ws.db, id).shotId
          : h.targetType === 'take'
            ? getTake(ws.db, id).shotId
            : h.targetType === 'task'
              ? getAgentTask(ws.db, id).shotId
              : null;
    return {
      handoff: h,
      prompt: handoffPrompt(ws, h),
      folder: ws.abs(h.dir),
      resultFileExists: existsSync(ws.abs(`${h.dir}/result.json`)),
      targetShotId,
    };
  };
  const openThread = async (id: string) => {
    if (!opts.discussions) return { threadId: null, openError: 'Codex 對話服務沒有啟動' };
    try {
      return { threadId: (await opts.discussions.open(id)).threadId, openError: null };
    } catch (error) {
      const e = toEnvelopeError(error);
      return { threadId: null, openError: e.hint ? `${e.message}（${e.hint}）` : e.message };
    }
  };
  app.get('/api/projects/:ref/codex', (c) =>
    handle(c, () => listHandoffs(ws.db, getProject(ws.db, c.req.param('ref')).id)),
  );
  app.post('/api/projects/:ref/codex', async (c) =>
    handle(c, async () => {
      const b = await body<{
        targetType: HandoffTarget;
        targetId?: string;
        topic: string;
        openThread?: boolean;
        attachments?: string[];
      }>(c);
      const h = createHandoff(ws, {
        projectRef: c.req.param('ref'),
        targetType: b.targetType,
        targetId: b.targetId ?? null,
        topic: b.topic ?? '',
        ...(b.attachments?.length ? { attachments: b.attachments } : {}),
        actor: USER,
      });
      const opened = b.openThread === false ? { threadId: null, openError: null } : await openThread(h.id);
      return { ...discussionView(h.id), ...opened };
    }),
  );
  app.get('/api/codex/:id', (c) => handle(c, () => discussionView(c.req.param('id'))));
  app.post('/api/codex/:id/open', (c) =>
    handle(c, async () => ({
      ...(await openThread(c.req.param('id'))),
      ...discussionView(c.req.param('id')),
    })),
  );
  app.post('/api/codex/:id/reload', (c) =>
    handle(c, () => {
      const h = getHandoff(ws.db, c.req.param('id'));
      submitHandoff(ws, h.id, readHandoffResultFile(ws, h), USER);
      return discussionView(h.id);
    }),
  );
  app.post('/api/codex/:id/import', async (c) =>
    handle(c, async () => {
      const b = await body<{ indices?: number[] }>(c);
      applyHandoff(ws, c.req.param('id'), { ...(b.indices ? { indices: b.indices } : {}), actor: USER });
      return discussionView(c.req.param('id'));
    }),
  );
  app.post('/api/codex/:id/close', (c) =>
    handle(c, () => {
      closeHandoff(ws.db, c.req.param('id'), USER);
      return discussionView(c.req.param('id'));
    }),
  );

  app.get('/api/tasks', (c) => {
    const status = c.req.query('status') as AgentTaskStatus | undefined;
    const ref = c.req.query('project');
    return handle(c, () =>
      listAgentTasks(ws.db, {
        ...(status ? { status } : {}),
        ...(ref ? { projectId: getProject(ws.db, ref).id } : {}),
      }),
    );
  });
  // What is configured, never the secrets themselves: which keys exist, models, limits.
  app.get('/api/settings', (c) =>
    handle(c, () => {
      const config = loadConfig();
      return {
        keys: (Object.keys(API_KEYS) as KeyedProvider[]).map((provider) => ({
          provider,
          label: API_KEYS[provider].label,
          source: apiKeySource(provider),
        })),
        jevBaseUrl: config.providers.jev.baseUrl,
        models: config.models,
        limits: config.limits,
        continuity: config.continuity,
        budget: config.budget,
        codex: {
          autoDispatch: config.codex.autoDispatch,
          model: config.codex.model,
          effort: config.codex.effort,
        },
        quota: quotaView(ws),
      };
    }),
  );
  app.get('/api/tasks/:id', (c) => handle(c, () => taskContext(ws, c.req.param('id'))));
  app.post('/api/tasks/:id/answer', async (c) =>
    handle(c, async () => {
      const b = await body<{ answer: string; attachments?: string[] }>(c);
      const task = getAgentTask(ws.db, c.req.param('id'));
      const images = task.projectId ? checkAttachments(ws, task.projectId, b.attachments) : [];
      return answerAgentTask(ws.db, task.id, b.answer, USER, Date.now(), images);
    }),
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
        quota: quotaView(ws),
      };
    }),
  );
  app.get('/api/quota', (c) => handle(c, () => quotaView(ws)));
}

/** Daily request quota per model; Infinity (no limit) is sent as null. */
function quotaView(ws: Workspace) {
  return quotaOverview(ws.db, loadConfig()).map((q) => ({
    ...q,
    limit: Number.isFinite(q.limit) ? q.limit : null,
    remaining: Number.isFinite(q.remaining) ? q.remaining : null,
  }));
}
