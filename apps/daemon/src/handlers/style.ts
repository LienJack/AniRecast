import {
  assertWithinBudget,
  findActiveClip,
  getProject,
  listKeyframes,
  listShots,
  recordCost,
  type Shot,
  shotCast,
  updateProjectSettings,
  updateShot,
} from '@anirecast/core';
import { estimateVisionCost } from '@anirecast/providers';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';

const STYLE_PROMPT = `These are frames from one anime opening. Describe its drawing style so that an image or video model adding a new character can match it exactly: line art (weight and colour), how faces and eyes are drawn, head-to-body proportions, cel shading (how many shadow tones, hard or soft edges, highlights), colour palette and saturation, how characters sit against the backgrounds, and any finishing effects (bloom, glow, chromatic aberration, grain). Three to five concrete sentences in English; no story, no character names.`;

const LIGHT_PROMPT = `This is a frame of an anime shot. In one or two sentences of English, describe its light and colour so a new character can be lit the same way: where the light comes from and how hard it is, its colour or temperature, which side is in shadow, rim or back light, and the overall colour grading or tint.`;

/**
 * 畫風與光影分析: the anime's drawing style (project.settings.styleNotes, for every design, board and take
 * prompt) from a spread of frames with characters, then the lighting of each shot that is generated
 * (shots.lighting), shots that already have it skipped unless `relight`.
 */
export const styleAnalysisHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, services, signal, job, progress } = ctx;
  const { projectId, relight } = job.payload as { projectId: string; relight?: boolean };
  const project = getProject(ws.db, projectId);
  const clip = findActiveClip(ws.db, project.id);
  if (!clip) return { result: { skipped: 'no clip' } };
  const shots = listShots(ws.db, clip.id);
  const model = services.config.models.vision;
  let cost = 0;
  const mid = (s: Shot) => {
    const frames = listKeyframes(ws.db, s.id);
    return frames.find((k) => k.role === 'mid') ?? frames.find((k) => k.frame === s.repFrame) ?? frames[0];
  };
  const ask = async <T>(
    prompt: string,
    paths: string[],
    schema: Record<string, unknown>,
    shotId?: string,
  ) => {
    if (services.provider.name !== 'fake')
      assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, paths.length));
    const result = await metered(ctx, { model, kind: 'vision', ...(shotId ? { shotId } : {}) }, () =>
      services.provider.analyzeImages<T>({
        model,
        prompt,
        images: paths.map((p) => ({ path: ws.abs(p), mimeType: 'image/jpeg' })),
        responseSchema: schema,
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
    return (result.data ?? {}) as Partial<T>;
  };

  // 1. Style: up to six frames with characters, spread over the clip.
  progress(0.05, 'reading the drawing style');
  const withCast = shots.filter((s) => shotCast(ws.db, s.id).some((e) => e.cast));
  const pool = withCast.length >= 4 ? withCast : shots;
  const picked =
    pool.length <= 6 ? pool : Array.from({ length: 6 }, (_, i) => pool[Math.floor((i * pool.length) / 6)]!);
  const frames = picked.map(mid).filter((k): k is NonNullable<typeof k> => Boolean(k));
  let style = '';
  if (frames.length) {
    const answer = await ask<{ style: string }>(
      STYLE_PROMPT,
      frames.map((k) => k.path),
      { type: 'object', properties: { style: { type: 'string' } }, required: ['style'] },
    );
    style = (answer.style ?? '').trim();
    if (style) updateProjectSettings(ws.db, project.id, { styleNotes: style }, 'daemon');
  }

  // 2. Lighting of every shot that gets generated.
  const toLight = shots.filter(
    (s) => (s.mode === 'replace' || s.mode === 'clean') && (relight || !s.lighting?.trim()),
  );
  let lit = 0;
  for (const [i, s] of toLight.entries()) {
    progress(0.2 + (0.8 * i) / Math.max(1, toLight.length), `lighting of shot ${s.orderIndex + 1}`);
    const k = mid(s);
    if (!k) continue;
    const answer = await ask<{ lighting: string }>(
      LIGHT_PROMPT,
      [k.path],
      { type: 'object', properties: { lighting: { type: 'string' } }, required: ['lighting'] },
      s.id,
    );
    const lighting = (answer.lighting ?? '').trim();
    if (lighting) {
      updateShot(ws.db, s.id, { lighting }, 'daemon');
      lit++;
    }
  }
  return { result: { style: style.length > 0, litShots: lit }, costUsd: cost };
};
