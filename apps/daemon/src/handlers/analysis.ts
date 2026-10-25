import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  applyClusters,
  assertWithinBudget,
  createAgentTask,
  findActiveClip,
  getCastMember,
  getProject,
  identityInput,
  listAgentTasks,
  listCast,
  listKeyframes,
  listShots,
  projectCacheDir,
  projectDir,
  recordCost,
  replaceAutoOverlays,
  replaceAutoTracklets,
  run,
  type Shot,
  settleCast,
  toJson,
  updateShot,
  type Workspace,
} from '@anirecast/core';
import { cropGrid, runSidecar } from '@anirecast/media';
import { estimateVisionCost } from '@anirecast/providers';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';

interface DetectOutput {
  shots: Array<{ shotId: string; tracklets: Parameters<typeof replaceAutoTracklets>[2] }>;
}

interface ClusterOutput {
  threshold: number;
  clusters: Array<{ members: string[]; looks: string[][] }>;
  confidence: Record<string, number>;
  uncertain: Array<
    | { type: 'maybe_same'; a: number; b: number; distance: number }
    | { type: 'maybe_mixed'; cluster: number; maxDistance: number }
    | { type: 'singleton'; cluster: number }
  >;
}

function writeSpec(ws: Workspace, projectSlug: string, name: string, spec: unknown): string {
  const file = ws.abs(`${projectCacheDir({ slug: projectSlug })}/identity/${name}-${Date.now()}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

function headCrops(ws: Workspace, castId: string, limit = 6): string[] {
  return ws.db
    .prepare(
      `SELECT d.head_crop_path AS p FROM detections d JOIN tracklets t ON t.id = d.tracklet_id
       WHERE t.cast_member_id = :castId AND d.head_crop_path IS NOT NULL ORDER BY t.confidence DESC, d.frame LIMIT :limit`,
    )
    .all({ castId, limit })
    .map((r) => ws.abs((r as { p: string }).p));
}

/** Detect (new shots only, or all with redetect), cluster, map to cast, hand doubtful cases to Codex. */
export const identifyCastHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, signal, progress, job } = ctx;
  const { projectId, redetect = false } = job.payload as { projectId: string; redetect?: boolean };
  const project = getProject(ws.db, projectId);
  const clip = findActiveClip(ws.db, project.id);
  if (!clip) return { result: { skipped: 'no clip' } };
  const shots = listShots(ws.db, clip.id).filter((s) => s.mode !== 'exclude');
  const hasTracklets = (s: Shot) =>
    (
      ws.db.prepare('SELECT COUNT(*) AS n FROM tracklets WHERE shot_id = :id').get({ id: s.id }) as {
        n: number;
      }
    ).n > 0;
  const targets = redetect ? shots : shots.filter((s) => !hasTracklets(s));
  if (targets.length > 0) {
    progress(0.05, `detecting characters in ${targets.length} shots`);
    const spec = {
      cropDir: ws.abs(`${projectDir(project)}/crops`),
      shots: targets.map((s) => ({
        shotId: s.id,
        frames: listKeyframes(ws.db, s.id).map((k) => ({
          frame: k.frame,
          keyframeId: k.id,
          path: ws.abs(k.path),
        })),
      })),
    };
    const detected = await runSidecar<DetectOutput>(
      'detect-characters',
      ['--spec', writeSpec(ws, project.slug, 'detect', spec)],
      { signal },
    );
    for (const shot of detected.shots)
      replaceAutoTracklets(ws.db, shot.shotId, shot.tracklets, (abs) => ws.rel(abs));
  }
  progress(0.6, 'clustering identities');
  const input = identityInput(ws.db, project.id);
  const clustered = await runSidecar<ClusterOutput>(
    'cluster-identities',
    ['--spec', writeSpec(ws, project.slug, 'cluster', input)],
    { signal },
  );
  const { castIds, created } = applyClusters(ws.db, project.id, clustered);
  attachAttributes(ws, project.id);

  progress(0.8, 'checking doubtful cases');
  const lockedCasts = new Set(
    (
      ws.db
        .prepare(
          `SELECT DISTINCT cast_member_id AS c FROM tracklets WHERE assigned_by = 'user' AND cast_member_id IS NOT NULL`,
        )
        .all() as Array<{ c: string }>
    ).map((r) => r.c),
  );
  const cases = clustered.uncertain
    .map((u) =>
      u.type === 'maybe_same'
        ? { type: u.type, castIds: [castIds[u.a]!, castIds[u.b]!], distance: Number(u.distance.toFixed(3)) }
        : u.type === 'maybe_mixed'
          ? { type: u.type, castIds: [castIds[u.cluster]!], distance: Number(u.maxDistance.toFixed(3)) }
          : { type: u.type, castIds: [castIds[u.cluster]!] },
    )
    .filter((c) => c.castIds.every(Boolean) && !c.castIds.every((id) => lockedCasts.has(id)));
  let taskId: string | null = null;
  const pending = listAgentTasks(ws.db, { projectId: project.id }).some(
    (t) => t.kind === 'cast_review' && ['open', 'claimed', 'needs_user'].includes(t.status),
  );
  if (cases.length > 0 && !pending) {
    const stamp = Date.now();
    const sheets: string[] = [];
    const others = listCast(ws.db, project.id).map((c) => c.id);
    for (const [i, c] of cases.entries()) {
      const rows =
        c.type === 'singleton'
          ? [
              headCrops(ws, c.castIds[0]!),
              others
                .filter((id) => id !== c.castIds[0])
                .flatMap((id) => headCrops(ws, id, 1))
                .slice(0, 6),
            ]
          : c.castIds.map((id) => headCrops(ws, id));
      const rel = `${projectDir(project)}/cast-review/${stamp}/case-${i + 1}.jpg`;
      if (rows.some((r) => r.length > 0)) {
        await cropGrid(
          rows.filter((r) => r.length > 0),
          ws.abs(rel),
          {},
          { signal },
        );
        sheets.push(rel);
      }
    }
    const described = cases.map((c, i) => ({
      ...c,
      sheet: sheets[i] ?? null,
      members: c.castIds.map((id) => {
        const m = getCastMember(ws.db, id);
        return {
          castId: id,
          label: m.label,
          tracklets: m.tracklets.map((t) => ({ id: t.id, shotId: t.shotId, confidence: t.confidence })),
        };
      }),
      rows:
        c.type === 'singleton'
          ? ['this appearance', 'one face of every other character']
          : c.castIds.map((id) => getCastMember(ws.db, id).label),
    }));
    taskId = createAgentTask(ws.db, {
      kind: 'cast_review',
      projectId: project.id,
      payload: { cases: described, contactSheets: sheets },
      createdBy: 'system',
    }).id;
  }
  const settled = settleCast(ws, project.id, [], 'identity updated', 'system');
  return {
    result: {
      detectedShots: targets.length,
      clusters: clustered.clusters.length,
      createdCast: created,
      doubtful: cases.length,
      taskId,
      ...settled,
    },
  };
};

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'One sentence: who is doing what, setting, shot size and camera motion.',
    },
    shotSize: {
      type: 'string',
      enum: ['extreme_close_up', 'close_up', 'medium', 'full', 'wide', 'establishing', 'insert'],
    },
    cameraMovement: { type: 'string' },
    overlays: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            description: '[ymin, xmin, ymax, xmax] on a 0-1000 grid of image 2',
          },
          category: { type: 'string', enum: ['staff_credit', 'title_or_other', 'in_scene'] },
        },
        required: ['box_2d', 'category'],
      },
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            description: '[ymin, xmin, ymax, xmax] on a 0-1000 grid of image 2',
          },
          hair: { type: 'string' },
          eyes: { type: 'string' },
          outfit: { type: 'string' },
          accessories: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['box_2d'],
      },
    },
  },
  required: ['description', 'overlays', 'characters'],
};

const SHOT_PROMPT = `These are the first, middle and last frames of one shot from an anime opening (images 1, 2, 3).
Return:
- overlays: text that was added on top of the picture in post-production. category "staff_credit" for staff or cast credits (names with or without roles such as 監督, 作画監督, 原画, 演出, 絵コンテ, 主題歌, CAST, Director); "title_or_other" for the show title, logos, song lyrics or other overlaid text; "in_scene" for text that is part of the drawn scene (signs, posters, screens, books). Give each box on image 2 as [ymin, xmin, ymax, xmax] on a 0-1000 grid. Merge lines of one credit block into one box.
- characters: every person or humanoid character visible in image 2 with a box around the whole visible body and short English attributes (hair colour and style, eye colour, outfit, accessories).
- description, shotSize and cameraMovement for the whole shot.`;

/** Flash sometimes spells a missing value as the string "null". */
const cleanText = (t: string | undefined): string | null => {
  const v = t?.trim();
  return v && v.toLowerCase() !== 'null' ? v : null;
};

const toBox = (b: number[]): [number, number, number, number] => {
  const [ymin = 0, xmin = 0, ymax = 0, xmax = 0] = b;
  return [xmin / 1000, ymin / 1000, xmax / 1000, ymax / 1000];
};

const iou = (a: number[], b: number[]): number => {
  const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = ix * iy;
  const union = (a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter;
  return union > 0 ? inter / union : 0;
};

/** Copies Flash's per-character attributes onto the detections they overlap (any order of the two passes). */
function attachAttributes(ws: Workspace, projectId: string): void {
  const clip = findActiveClip(ws.db, projectId);
  if (!clip) return;
  for (const shot of listShots(ws.db, clip.id)) {
    const chars = (
      (shot.camera as { characters?: Array<{ box: number[] } & Record<string, unknown>> } | null)
        ?.characters ?? []
    ).filter((c) => Array.isArray(c.box));
    if (chars.length === 0) continue;
    const dets = ws.db
      .prepare(
        `SELECT d.id, d.body_bbox_json AS body FROM detections d JOIN tracklets t ON t.id = d.tracklet_id WHERE t.shot_id = :shotId`,
      )
      .all({ shotId: shot.id }) as Array<{ id: string; body: string | null }>;
    for (const d of dets) {
      if (!d.body) continue;
      const body = JSON.parse(d.body) as number[];
      const best = chars.map((c) => ({ c, s: iou(body, c.box) })).sort((x, y) => y.s - x.s)[0];
      if (best && best.s > 0.2) {
        const { box: _box, ...attrs } = best.c;
        run(ws.db, 'UPDATE detections SET attrs_json = :attrs WHERE id = :id', {
          id: d.id,
          attrs: toJson(attrs),
        });
      }
    }
  }
}

/** Flash pass per shot: overlaid text (to remove credits), character attributes, description. */
export const analyzeShotsHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, services, signal, progress, job } = ctx;
  const { projectId, shotIds } = job.payload as { projectId: string; shotIds?: string[] };
  const project = getProject(ws.db, projectId);
  const clip = findActiveClip(ws.db, project.id);
  if (!clip) return { result: { skipped: 'no clip' } };
  const shots = listShots(ws.db, clip.id).filter(
    (s) => s.mode !== 'exclude' && (!shotIds || shotIds.includes(s.id)),
  );
  const model = services.config.models.vision;
  let cost = 0;
  for (const [i, shot] of shots.entries()) {
    const frames = listKeyframes(ws.db, shot.id);
    const pick = ['first', 'mid', 'last']
      .map((role) => frames.find((k) => k.role === role))
      .filter((k) => k !== undefined);
    if (pick.length === 0) continue;
    if (services.provider.name !== 'fake')
      assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, pick.length));
    const result = await metered(ctx, { model, kind: 'vision', shotId: shot.id }, () =>
      services.provider.analyzeImages<{
        description?: string;
        shotSize?: string;
        cameraMovement?: string;
        overlays?: Array<{
          text?: string;
          box_2d: number[];
          category: 'staff_credit' | 'title_or_other' | 'in_scene';
        }>;
        characters?: Array<{ box_2d: number[] } & Record<string, unknown>>;
      }>({
        model,
        prompt: SHOT_PROMPT,
        images: pick.map((k) => ({ path: ws.abs(k.path), mimeType: 'image/jpeg' })),
        responseSchema: SHOT_SCHEMA,
        signal,
      }),
    );
    recordCost(ws.db, {
      jobId: job.id,
      projectId: project.id,
      provider: result.provider,
      model,
      usage: result.usage,
      usd: result.provider === 'fake' ? 0 : result.costUsd,
    });
    cost += result.provider === 'fake' ? 0 : result.costUsd;
    const mid = pick.find((k) => k.role === 'mid') ?? pick[0]!;
    replaceAutoOverlays(
      ws.db,
      shot.id,
      (result.data.overlays ?? [])
        .filter((o) => Array.isArray(o.box_2d) && o.box_2d.length === 4)
        .map((o) => ({
          keyframeId: mid.id,
          bbox: toBox(o.box_2d),
          text: cleanText(o.text),
          category: o.category,
        })),
    );
    updateShot(
      ws.db,
      shot.id,
      {
        ...(result.data.description ? { description: result.data.description } : {}),
        camera: {
          shotSize: result.data.shotSize ?? null,
          movement: result.data.cameraMovement ?? null,
          characters: (result.data.characters ?? [])
            .filter((c) => Array.isArray(c.box_2d))
            .map(({ box_2d, ...rest }) => ({ ...rest, box: toBox(box_2d) })),
        },
      },
      'daemon',
    );
    progress((i + 1) / shots.length, `analyzed ${i + 1}/${shots.length}`);
  }
  attachAttributes(ws, project.id);
  const settled = settleCast(ws, project.id, [], 'shot analysis updated', 'system');
  return { result: { analyzed: shots.length, ...settled }, costUsd: cost };
};
