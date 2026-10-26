import {
  all,
  assertWithinBudget,
  findActiveClip,
  fromJson,
  getProject,
  listKeyframes,
  listShots,
  recordCost,
  type Shot,
  type StyleBible,
  shotCast,
  updateProjectSettings,
  updateShot,
  type Workspace,
} from '@anirecast/core';
import { estimateVisionCost } from '@anirecast/providers';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';

const STYLE_PROMPT = (n: number, closeUps: number) =>
  [
    `These are ${n} frames from one anime opening${closeUps ? `; the last ${closeUps} are its closest shots of characters` : ''}.`,
    "Write this anime's style bible: how it is drawn, so an image or video model adding a new character can match it exactly. Be concrete and specific to THIS anime — what you see, written as instructions an artist could follow. No story, no character names, no generic praise, no words like 'beautiful' or 'high quality'.",
    '- summary: one paragraph.',
    '- lineArt: line weight (thin / medium; uniform or tapered), line colour (black, dark brown, coloured lines where light hits), outer contour vs inner lines, hair strand lines.',
    '- faces: face shape and head-to-body proportions; eye construction (shape, iris layers and gradient, pupil, highlight shapes and where they sit, lashes and lid lines); nose, mouth, blush.',
    '- hair: silhouette, clumps, highlight shapes and colour.',
    '- shading: number of shadow tones, hard or soft edges, shadow colour (hue shift from the base colour, 影色), highlight tones, how skin is shaded (flat cel tones, no texture).',
    '- colour: palette, saturation and value range, skin tones, how colours are designed (色彩設計).',
    '- compositing: the 撮影 effects you see — diffusion / soft glow (DF), パラ gradients, bloom on highlights, lens flares, chromatic aberration, grain, vignette, depth of field.',
    '- backgrounds: how the 美術 is painted — painted or photo-based, detail, perspective, depth blur.',
    '- motion: what the frames suggest about the animation (limited animation drawn on twos or threes, smears, camera moves); short.',
    "- avoid: 4 to 8 short drift traps specific to this look that a generator must not fall into (for example '3D render', 'smooth CG skin with subsurface scattering', 'painterly brush texture', 'thick black outlines', 'photographic lighting').",
    "- styleReferences: the 1 or 2 image numbers that best show how this anime draws a character's face and eyes up close, its line art and its shading (clear, well lit, not motion-blurred, little text).",
  ].join('\n');

const STYLE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    lineArt: { type: 'string' },
    faces: { type: 'string' },
    hair: { type: 'string' },
    shading: { type: 'string' },
    colour: { type: 'string' },
    compositing: { type: 'string' },
    backgrounds: { type: 'string' },
    motion: { type: 'string' },
    avoid: { type: 'array', items: { type: 'string' } },
    styleReferences: { type: 'array', items: { type: 'integer' } },
  },
  required: [
    'summary',
    'lineArt',
    'faces',
    'hair',
    'shading',
    'colour',
    'compositing',
    'backgrounds',
    'motion',
    'avoid',
    'styleReferences',
  ],
};

const LIGHT_PROMPT = `This is a frame of an anime shot. In two or three sentences of English, describe its light, colour and compositing so a new character can be lit and composited the same way: where the light comes from and how hard it is, its colour or temperature, which side is in shadow, rim or back light, the colour grading or tint, and the 撮影 effects visible in this shot (bloom or diffusion glow, lens flare, パラ gradient, chromatic aberration, grain, depth blur).`;

/** Keyframes of the closest shots of characters (largest detected heads), one per shot. */
function closestShots(ws: Workspace, clipId: string, n: number): string[] {
  const rows = all<{ shot_id: string; frame: number; head_bbox_json: string | null; path: string | null }>(
    ws.db,
    `SELECT t.shot_id, d.frame, d.head_bbox_json,
            (SELECT k.path FROM keyframes k WHERE k.shot_id = t.shot_id AND (k.id = d.keyframe_id OR k.frame = d.frame) LIMIT 1) AS path
       FROM detections d JOIN tracklets t ON t.id = d.tracklet_id JOIN shots s ON s.id = t.shot_id
      WHERE s.clip_id = :clipId AND t.cast_member_id IS NOT NULL`,
    { clipId },
  );
  const area = (json: string | null) => {
    const b = fromJson<number[] | null>(json, null);
    return b ? (b[2]! - b[0]!) * (b[3]! - b[1]!) : 0;
  };
  const best = new Map<string, { path: string; area: number }>();
  for (const r of rows) {
    if (!r.path) continue;
    const a = area(r.head_bbox_json);
    if (a > (best.get(r.shot_id)?.area ?? 0)) best.set(r.shot_id, { path: r.path, area: a });
  }
  return [...best.values()]
    .sort((a, b) => b.area - a.area)
    .slice(0, n)
    .map((b) => b.path);
}

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

  // 1. Style bible: up to six frames with characters spread over the clip, then the closest shots of characters
  // (drift starts at the eyes, hair and line weight, which close-ups show).
  progress(0.05, 'reading the drawing style');
  const withCast = shots.filter((s) => shotCast(ws.db, s.id).some((e) => e.cast));
  const pool = withCast.length >= 4 ? withCast : shots;
  const picked =
    pool.length <= 6 ? pool : Array.from({ length: 6 }, (_, i) => pool[Math.floor((i * pool.length) / 6)]!);
  const spread = picked.map(mid).filter((k): k is NonNullable<typeof k> => Boolean(k));
  const closeUps = closestShots(ws, clip.id, 4).filter((p) => !spread.some((k) => k.path === p));
  const frames = [...spread.map((k) => k.path), ...closeUps];
  let style = false;
  if (frames.length) {
    const answer = await ask<StyleBible & { styleReferences: number[] }>(
      STYLE_PROMPT(frames.length, closeUps.length),
      frames,
      STYLE_SCHEMA,
    );
    const summary = (answer.summary ?? '').trim();
    if (summary) {
      const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      const bible: StyleBible = {
        summary,
        lineArt: text(answer.lineArt),
        faces: text(answer.faces),
        hair: text(answer.hair),
        shading: text(answer.shading),
        colour: text(answer.colour),
        compositing: text(answer.compositing),
        backgrounds: text(answer.backgrounds),
        motion: text(answer.motion),
        avoid: (answer.avoid ?? []).map(text).filter(Boolean).slice(0, 8),
      };
      const refs = [...new Set(answer.styleReferences ?? [])]
        .map((n) => frames[n - 1])
        .filter((p): p is string => Boolean(p))
        .slice(0, 2);
      updateProjectSettings(
        ws.db,
        project.id,
        { styleNotes: summary, styleBible: bible, styleRefs: refs.length ? refs : frames.slice(-1) },
        'daemon',
      );
      style = true;
    }
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
  return { result: { style, litShots: lit }, costUsd: cost };
};
