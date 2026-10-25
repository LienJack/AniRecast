import {
  createAgentTask,
  getBoundary,
  getClip,
  getProject,
  listShots,
  mergeShots,
  projectCacheDir,
  recordBoundary,
  recordCost,
  type Shot,
  shotHasGeneration,
} from '@anirecast/core';
import { boundarySheet, extractFrame } from '@anirecast/media';
import { AniError } from '@anirecast/shared';
import type { JobHandler } from '../runner.ts';
import { continueAfterShots } from './clips.ts';
import { metered } from './metered.ts';
import { outPath } from './util.ts';

/** The judge's definition of one shot, from the user: a continuous moment, not a single camera take. */
const PROMPT = `These four frames come from an anime opening, in order. Frames 1 and 2 are the end of shot A; frames 3 and 4 are the start of shot B, which follows A directly.

Decide whether A and B are one continuous moment that should be treated as a single shot: the same place, the same characters and continuous action. Cuts between framings of that same action still count as the same moment: wide to close-up, another angle on the same subject, a focus pull, a flash, a quick zoom or whip pan.

Answer same_moment = false when the location, the time or the main subject changes, when either side is a title, logo, text card or abstract graphic, or when B starts a different action.

confidence is how sure you are of your answer, from 0 to 1. reason is one short sentence.`;

const SCHEMA = {
  type: 'object',
  properties: {
    same_moment: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  required: ['same_moment', 'confidence', 'reason'],
};

interface Judged {
  atFrame: number;
  /** 1-based shot numbers either side of the cut, at judging time. */
  between: [number, number];
  sameMoment: boolean;
  confidence: number;
  reason: string;
  decidedBy: string;
  locked: boolean;
  sheet: string | null;
}

async function inPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

const clamp01 = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

/**
 * Judges every cut of a clip with the continuity model (JEV by default), merges runs of cuts it is sure belong
 * to one moment (never past `maxShotSeconds`, never shots with generated versions, never against a human
 * decision), and hands the unsure cuts plus the merges it made to Codex for review. With `chain`, it then
 * prepares the shots and continues the pipeline, as shot detection used to.
 */
export const shotContinuityHandler: JobHandler = async (ctx) => {
  const { workspace: ws, services, job, progress, signal } = ctx;
  const p = job.payload as {
    clipId: string;
    apply?: boolean;
    review?: boolean;
    chain?: boolean;
    rejudge?: boolean;
  };
  const clip = getClip(ws.db, p.clipId);
  if (!clip.filePath) throw new AniError('conflict', 'The clip master is not ready');
  const project = getProject(ws.db, clip.projectId);
  const model = services.config.models.continuity;
  const cfg = services.config.continuity;
  const dir = `${projectCacheDir(project)}/continuity/${clip.id}`;
  const master = ws.abs(clip.filePath);
  const shots = listShots(ws.db, clip.id);
  const pairs = shots.slice(1).map((b, i) => ({ a: shots[i]!, b, n: i + 1 }));
  const judged: Judged[] = [];
  let cost = 0;
  let done = 0;

  await inPool(pairs, 4, async ({ a, b, n }) => {
    const known = getBoundary(ws.db, clip.id, b.startFrame);
    if (known && (known.locked || (!p.rejudge && known.decidedBy === model))) {
      judged.push({
        atFrame: b.startFrame,
        between: [n, n + 1],
        sameMoment: known.verdict === 'same_moment',
        confidence: known.confidence ?? 1,
        reason: known.reason ?? '',
        decidedBy: known.decidedBy,
        locked: known.locked,
        sheet: known.sheetPath,
      });
      return;
    }
    const picks = [
      Math.max(a.startFrame, a.endFrame - 8),
      a.endFrame,
      b.startFrame,
      Math.min(b.endFrame, b.startFrame + 8),
    ];
    const files = picks.map((_frame, i) => `${dir}/f${b.startFrame}-${i}.jpg`);
    for (const [i, f] of picks.entries())
      await extractFrame(master, outPath(ws, files[i]!), f, clip.fpsNum, clip.fpsDen, {
        maxWidth: 480,
        signal,
      });
    const sheet = `${dir}/cut-f${b.startFrame}.jpg`;
    await boundarySheet(files.map((f) => ws.abs(f)) as [string, string, string, string], outPath(ws, sheet), {
      signal,
    });
    const result = await metered(ctx, { model, kind: 'vision', shotId: b.id }, () =>
      services.provider.analyzeImages<{ same_moment?: boolean; confidence?: number; reason?: string }>({
        model,
        prompt: PROMPT,
        images: files.map((f) => ({ path: ws.abs(f), mimeType: 'image/jpeg' })),
        responseSchema: SCHEMA,
        signal,
      }),
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
    const verdict = {
      atFrame: b.startFrame,
      between: [n, n + 1] as [number, number],
      sameMoment: result.data.same_moment === true,
      confidence: clamp01(result.data.confidence),
      reason: String(result.data.reason ?? '').slice(0, 300),
      decidedBy: model,
      locked: false,
      sheet,
    };
    recordBoundary(ws.db, {
      clipId: clip.id,
      atFrame: verdict.atFrame,
      verdict: verdict.sameMoment ? 'same_moment' : 'cut',
      confidence: verdict.confidence,
      reason: verdict.reason,
      decidedBy: model,
      sheetPath: sheet,
    });
    judged.push(verdict);
    done++;
    progress((0.5 * done) / Math.max(1, pairs.length), `judged ${done}/${pairs.length} cuts`);
  });
  judged.sort((x, y) => x.atFrame - y.atFrame);

  // Runs of confident same-moment cuts become one shot each, capped in length.
  const maxFrames = Math.floor((cfg.maxShotSeconds * clip.fpsNum) / clip.fpsDen);
  const byFrame = new Map(judged.map((j) => [j.atFrame, j]));
  const joins = (j: Judged | undefined) =>
    Boolean(j?.sameMoment && (j.locked || j.confidence >= cfg.autoMerge));
  const groups: Shot[][] = [];
  const tooLong: Judged[] = [];
  let run: Shot[] = [shots[0]!].filter(Boolean);
  for (const s of shots.slice(1)) {
    const cut = byFrame.get(s.startFrame);
    const length = s.endFrame - (run[0]?.startFrame ?? s.startFrame) + 1;
    if (joins(cut) && length <= maxFrames) {
      run.push(s);
      continue;
    }
    if (joins(cut) && cut) tooLong.push(cut);
    groups.push(run);
    run = [s];
  }
  if (run.length) groups.push(run);
  const merges = groups.filter((g) => g.length > 1);

  const applied: Array<{ shots: number[]; atFrames: number[]; reasons: string[] }> = [];
  const suggested: Array<{ shots: number[]; atFrames: number[]; reasons: string[]; why: string }> = [];
  const number = (s: Shot) => shots.findIndex((x) => x.id === s.id) + 1;
  for (const g of merges) {
    const entry = {
      shots: g.map(number),
      atFrames: g.slice(1).map((s) => s.startFrame),
      reasons: g.slice(1).map((s) => byFrame.get(s.startFrame)?.reason ?? ''),
    };
    const generated = g.some((s) => shotHasGeneration(ws.db, s.id));
    if (!p.apply || generated) {
      suggested.push({ ...entry, why: generated ? 'shots already have boards or takes' : 'suggest mode' });
      continue;
    }
    for (const s of g.slice(1))
      mergeShots(ws.db, g[0]!.id, s.id, 'daemon', Date.now(), {
        reason: `${model}: ${byFrame.get(s.startFrame)?.reason ?? ''}`,
      });
    applied.push(entry);
  }

  // Codex looks at what the judge was unsure about, and checks the merges it made.
  const unsure = judged.filter(
    (j) => !j.locked && j.confidence >= cfg.review && j.confidence < cfg.autoMerge,
  );
  let taskId: string | undefined;
  if (p.review && (unsure.length > 0 || applied.length > 0)) {
    taskId = createAgentTask(ws.db, {
      kind: 'shot_review',
      projectId: project.id,
      payload: {
        clipId: clip.id,
        judge: model,
        maxShotSeconds: cfg.maxShotSeconds,
        unsure: unsure.map((j) => ({ ...j, sheet: j.sheet && ws.abs(j.sheet) })),
        merged: applied.map((a) => ({
          ...a,
          sheets: a.atFrames.map((f) => {
            const s = byFrame.get(f)?.sheet;
            return s ? ws.abs(s) : null;
          }),
        })),
      },
      createdBy: 'system',
    }).id;
  }

  const chained = p.chain ? await continueAfterShots(ctx, clip.id, 0.6) : {};
  return {
    result: {
      clipId: clip.id,
      judged: judged.length,
      newlyJudged: done,
      merged: applied,
      suggested,
      unsure: unsure.length,
      tooLong: tooLong.map((j) => j.atFrame),
      ...(taskId ? { taskId } : {}),
      ...chained,
    },
    costUsd: cost,
  };
};
