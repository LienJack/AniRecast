import {
  all,
  assertWithinBudget,
  type CastMember,
  createAgentTask,
  fromJson,
  getCastMember,
  getProject,
  listAgentTasks,
  listCast,
  listLooks,
  mergeCast,
  mergeLooks,
  projectCacheDir,
  recordCost,
  settleCast,
  type Workspace,
} from '@anirecast/core';
import { cropGrid } from '@anirecast/media';
import { estimateVisionCost, type LocalMedia } from '@anirecast/providers';
import { toEnvelopeError } from '@anirecast/shared';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';
import { outPath } from './util.ts';

interface Crop {
  trackletId: string;
  shotId: string;
  path: string;
}

/** The clearest crop of each appearance (largest box), one per shot first, up to `limit`. */
function crops(
  ws: Workspace,
  where: string,
  params: Record<string, string>,
  part: 'head' | 'body',
  limit: number,
) {
  const rows = all<{ tracklet_id: string; shot_id: string; path: string; box: string | null }>(
    ws.db,
    `SELECT d.tracklet_id, t.shot_id, d.${part}_crop_path AS path, d.${part}_bbox_json AS box
       FROM detections d JOIN tracklets t ON t.id = d.tracklet_id
     WHERE ${where} AND d.${part}_crop_path IS NOT NULL`,
    params,
  );
  const area = (json: string | null) => {
    const b = fromJson<number[] | null>(json, null);
    return b ? (b[2]! - b[0]!) * (b[3]! - b[1]!) : 0;
  };
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.tracklet_id);
    if (!cur || area(r.box) > area(cur.box)) best.set(r.tracklet_id, r);
  }
  const sorted = [...best.values()].sort((a, b) => area(b.box) - area(a.box));
  const picked: Crop[] = [];
  for (const pass of [true, false])
    for (const r of sorted) {
      if (picked.length >= limit) break;
      if (picked.some((p) => p.trackletId === r.tracklet_id)) continue;
      if (pass && picked.some((p) => p.shotId === r.shot_id)) continue;
      picked.push({ trackletId: r.tracklet_id, shotId: r.shot_id, path: r.path });
    }
  return picked;
}

const GROUPS_SCHEMA = (key: string, extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          [key]: { type: 'array', items: { type: 'integer' } },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          ...extra,
        },
        required: [key, 'confidence'],
      },
    },
  },
  required: ['groups'],
});

const LOOK_SCHEMA = {
  ...GROUPS_SCHEMA('looks', { label: { type: 'string' } }),
  properties: {
    ...GROUPS_SCHEMA('looks', { label: { type: 'string' } }).properties,
    strangers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          look: { type: 'integer' },
          cell: { type: 'integer' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['look', 'cell', 'confidence'],
      },
    },
  },
};

interface ReviewCase {
  type: 'maybe_same' | 'maybe_mixed';
  castIds: string[];
  trackletIds?: string[];
  confidence: number;
  reason: string;
  sheet: string | null;
}

/**
 * 整理角色 with the JEV judge: which characters of the cast table are the same person (merged when sure),
 * which looks of a character are the same outfit (merged when sure) and which appearances are someone else.
 * Doubtful cases go to Codex as one `cast_review` task. Decisions a person locked are never touched.
 */
export const tidyCastHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, services, signal, job, progress } = ctx;
  const { projectId } = job.payload as { projectId: string };
  const project = getProject(ws.db, projectId);
  const model = services.config.models.continuity;
  const { autoMerge, review } = services.config.continuity;
  const actor = `jev:${model.replace(/^jev:/, '')}`;
  const dir = `${projectCacheDir(project)}/cast-tidy/${Date.now()}`;
  let cost = 0;
  const ask = async <T>(
    prompt: string,
    images: LocalMedia[],
    schema: Record<string, unknown>,
  ): Promise<T> => {
    if (services.provider.name !== 'fake')
      assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, images.length));
    const result = await metered(ctx, { model, kind: 'vision' }, () =>
      services.provider.analyzeImages<T>({ model, prompt, images, responseSchema: schema, signal }),
    );
    const usd = result.provider === 'fake' ? 0 : result.costUsd;
    recordCost(ws.db, {
      jobId: job.id,
      projectId: project.id,
      provider: result.provider,
      model,
      usage: result.usage,
      usd,
    });
    cost += usd;
    return (result.data ?? {}) as T;
  };
  const grid = async (name: string, rows: string[][], cell: number) => {
    const rel = `${dir}/${name}.jpg`;
    await cropGrid(
      rows.map((r) => r.map((p) => ws.abs(p))),
      outPath(ws, rel),
      { cell, maxPerRow: 4 },
      { signal },
    );
    return rel;
  };
  const cases: ReviewCase[] = [];
  const castMerges: Array<{ keep: string; drop: string; confidence: number; reason: string }> = [];
  const lookMerges: Array<{ cast: string; looks: number; label: string; confidence: number }> = [];

  // 1. The same person listed twice in the cast table.
  progress(0.1, 'comparing characters');
  const cast = listCast(ws.db, project.id).filter((c) => c.tracklets.length > 0);
  const faces = new Map<string, Crop[]>();
  for (const c of cast) faces.set(c.id, crops(ws, 't.cast_member_id = :id', { id: c.id }, 'head', 4));
  const shown = cast.filter((c) => (faces.get(c.id) ?? []).length > 0);
  if (shown.length >= 2) {
    const sheets = await Promise.all(
      shown.map((c, i) => grid(`character-${i + 1}`, [(faces.get(c.id) ?? []).map((f) => f.path)], 160)),
    );
    const answer = await ask<{
      groups?: Array<{ characters?: number[]; confidence?: number; reason?: string }>;
    }>(
      [
        'Each image shows up to four face crops of one character found in an anime opening:',
        ...shown.map(
          (c, i) =>
            `Image ${i + 1}: character ${i + 1}, "${c.label}"${c.description ? ` (${c.description})` : ''}.`,
        ),
        'Which characters are the same person? One person can appear in different outfits, with hair tied or loose, in other lighting or from other angles: judge by face shape, eyes and eye colour, hair colour and distinctive features. Different people can wear the same uniform.',
        'Return groups of two or more characters (by number) that are the same person, each with your confidence from 0 to 1 and a one-sentence reason. Leave out characters that match nobody.',
      ].join('\n'),
      sheets.map((s) => ({ path: ws.abs(s), mimeType: 'image/jpeg' })),
      GROUPS_SCHEMA('characters'),
    );
    for (const g of answer.groups ?? []) {
      const members = [...new Set(g.characters ?? [])]
        .map((k) => shown[k - 1])
        .filter((c): c is CastMember => Boolean(c));
      const confidence = Number(g.confidence ?? 0);
      const reason = g.reason ?? '';
      if (members.length < 2 || confidence < review) continue;
      const personas = new Set(members.map((m) => m.personaId).filter(Boolean));
      const sheet = await grid(
        `same-${cases.length + castMerges.length + 1}`,
        members.map((m) => (faces.get(m.id) ?? []).map((f) => f.path)),
        160,
      );
      if (confidence < autoMerge || personas.size > 1) {
        cases.push({ type: 'maybe_same', castIds: members.map((m) => m.id), confidence, reason, sheet });
        continue;
      }
      // Keep the one bound to a library character, else the one with the most appearances.
      const keep =
        members.find((m) => m.personaId) ??
        [...members].sort((a, b) => b.tracklets.length - a.tracklets.length)[0]!;
      for (const drop of members.filter((m) => m.id !== keep.id)) {
        try {
          mergeCast(ws.db, keep.id, drop.id, actor, { reason: `JEV：${reason}`, confidence });
          castMerges.push({ keep: keep.label, drop: drop.label, confidence, reason });
        } catch (error) {
          cases.push({
            type: 'maybe_same',
            castIds: [keep.id, drop.id],
            confidence,
            reason: `${reason}（無法自動合併：${toEnvelopeError(error).message}）`,
            sheet,
          });
        }
      }
    }
  }

  // 2. Looks of one character that are the same outfit, and appearances that are someone else.
  const remaining = listCast(ws.db, project.id).filter((c) => c.tracklets.length > 0);
  for (const [n, c] of remaining.entries()) {
    progress(0.3 + (0.6 * n) / Math.max(1, remaining.length), `looks of ${c.label}`);
    const looks = listLooks(ws.db, c.id)
      .map((look) => ({ look, crops: crops(ws, 't.look_id = :id', { id: look.id }, 'body', 4) }))
      .filter((l) => l.crops.length > 0);
    if (looks.length < 2) continue;
    const sheets = await Promise.all(
      looks.map((l, i) => grid(`${c.id}-look-${i + 1}`, [l.crops.map((x) => x.path)], 200)),
    );
    const answer = await ask<{
      groups?: Array<{ looks?: number[]; label?: string; confidence?: number; reason?: string }>;
      strangers?: Array<{ look?: number; cell?: number; confidence?: number; reason?: string }>;
    }>(
      [
        `These are the looks found for one character, "${c.label}", in an anime opening. Image k shows look k: up to four appearances (whole-body crops), the cells read left to right. A look is one outfit and hairstyle.`,
        '1. Group looks that are the same outfit and hairstyle, seen from another angle, distance or in other light, or from behind. Give each group of two or more looks a short label in Traditional Chinese naming the outfit (e.g. 制服、咖啡廳和服、便服), your confidence from 0 to 1 and a reason.',
        '2. List appearances that are clearly a different person from the rest (look number and cell number, counting from 1), with confidence and reason.',
      ].join('\n'),
      sheets.map((s) => ({ path: ws.abs(s), mimeType: 'image/jpeg' })),
      LOOK_SCHEMA,
    );
    const taken = new Set<string>();
    for (const g of answer.groups ?? []) {
      const members = [...new Set(g.looks ?? [])]
        .map((k) => looks[k - 1])
        .filter((l): l is (typeof looks)[number] => Boolean(l) && !taken.has(l!.look.id));
      const confidence = Number(g.confidence ?? 0);
      if (members.length < 2 || confidence < autoMerge) continue;
      const count = (id: string) => c.tracklets.filter((t) => t.lookId === id).length;
      const keep = [...members].sort((a, b) => count(b.look.id) - count(a.look.id))[0]!;
      mergeLooks(
        ws.db,
        keep.look.id,
        members.filter((m) => m !== keep).map((m) => m.look.id),
        actor,
        { ...(g.label ? { label: g.label } : {}), ...(g.reason ? { reason: g.reason } : {}) },
      );
      for (const m of members) taken.add(m.look.id);
      lookMerges.push({
        cast: c.label,
        looks: members.length,
        label: g.label ?? keep.look.label,
        confidence,
      });
    }
    const strangers = (answer.strangers ?? [])
      .filter((s) => Number(s.confidence ?? 0) >= review)
      .map((s) => ({ s, crop: looks[(s.look ?? 0) - 1]?.crops[(s.cell ?? 0) - 1] }))
      .filter((x): x is { s: (typeof x)['s']; crop: Crop } => Boolean(x.crop));
    if (strangers.length) {
      const sheet = await grid(
        `${c.id}-strangers`,
        [strangers.map((x) => x.crop.path), (faces.get(c.id) ?? []).map((f) => f.path)],
        160,
      );
      cases.push({
        type: 'maybe_mixed',
        castIds: [c.id],
        trackletIds: strangers.map((x) => x.crop.trackletId),
        confidence: Math.max(...strangers.map((x) => Number(x.s.confidence ?? 0))),
        reason: strangers
          .map((x) => x.s.reason ?? '')
          .filter(Boolean)
          .join('；'),
        sheet,
      });
    }
  }

  // 3. Doubtful cases go to Codex (who may hand them to the human), as one task.
  let taskId: string | null = null;
  const pending = listAgentTasks(ws.db, { projectId: project.id }).some(
    (t) => t.kind === 'cast_review' && ['open', 'claimed', 'needs_user'].includes(t.status),
  );
  const live = cases.filter((k) => k.castIds.every((id) => getCastMember(ws.db, id).status === 'active'));
  if (live.length && !pending)
    taskId = createAgentTask(ws.db, {
      kind: 'cast_review',
      projectId: project.id,
      payload: {
        source: 'jev',
        cases: live.map((k) => ({
          ...k,
          members: k.castIds.map((id) => {
            const m = getCastMember(ws.db, id);
            return {
              castId: id,
              label: m.label,
              tracklets: m.tracklets.map((t) => ({ id: t.id, shotId: t.shotId })),
            };
          }),
          rows:
            k.type === 'maybe_mixed'
              ? [
                  'appearances JEV thinks are someone else',
                  `faces of "${getCastMember(ws.db, k.castIds[0]!).label}"`,
                ]
              : k.castIds.map((id) => getCastMember(ws.db, id).label),
        })),
        contactSheets: live.map((k) => k.sheet).filter((s): s is string => Boolean(s)),
      },
      createdBy: actor,
    }).id;
  const settled = settleCast(ws, project.id, [], 'cast tidied by JEV', actor);
  return {
    result: { castMerges, lookMerges, review: live.length, taskId, ...settled },
    costUsd: cost,
  };
};
