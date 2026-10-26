import { statSync } from 'node:fs';
import {
  assertWithinBudget,
  type Board,
  boardBrief,
  type DirectorBrief,
  type InputRef,
  projectOfShot,
  recordCost,
  sha256File,
  takeBrief,
} from '@anirecast/core';
import { cropGrid } from '@anirecast/media';
import { estimateVisionCost, mimeFor } from '@anirecast/providers';
import { imageModelSpec, type VideoModelSpec, videoModelSpec } from '@anirecast/shared';
import type { JobContext } from '../runner.ts';
import { metered } from './metered.ts';

/** What the director decided for one generation, kept in the version's params. */
export interface DirectorRecord {
  model: string;
  /** One line for the human, in Traditional Chinese. */
  notes: string;
  analysis: Record<string, string>;
  /** The references chosen, in the order the generator receives them after the frame. */
  references: Array<{ id: string; label: string; path: string }>;
  costUsd: number;
}

interface BoardAnswer {
  analysis?: Record<string, string>;
  references?: string[];
  prompt?: string;
  notes?: string;
}

/** Fewer, better references: past this the image models start mixing characters up. */
const MAX_BOARD_REFS = 6;

const BOARD_SCHEMA = {
  type: 'object',
  properties: {
    analysis: {
      type: 'object',
      properties: {
        scene: { type: 'string' },
        action: { type: 'string' },
        composition: { type: 'string' },
        lighting: { type: 'string' },
        style: { type: 'string' },
      },
      required: ['scene', 'action', 'composition', 'lighting', 'style'],
    },
    references: { type: 'array', items: { type: 'string' } },
    prompt: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['analysis', 'references', 'prompt', 'notes'],
};

const listImages = (brief: DirectorBrief) =>
  brief.images.map(
    (img, i) => `Image ${i + 1} [${img.id}${img.use === 'context' ? ', context only' : ''}]: ${img.label}`,
  );

/**
 * The storyboard director: reads the frame, the shot's other moments, the people to replace and every reference,
 * then writes the image model's instruction from what it sees — action, composition, positions, light, the
 * anime's drawing style — and picks the references to send. Returns null when there is nothing to direct.
 */
export async function directBoard(
  ctx: JobContext,
  board: Board,
): Promise<{ prompt: string; inputs: InputRef[]; record: DirectorRecord }> {
  const { workspace: ws, services, signal, job } = ctx;
  const generator = imageModelSpec(board.model);
  const brief = boardBrief(ws, board.id, Math.min(MAX_BOARD_REFS, Math.max(1, generator.maxRefs - 1)));
  const model = services.config.models.director;
  const prompt = [
    'You are the storyboard director of an anime opening in which some characters are replaced by other characters.',
    `An image model (${generator.label}) will redraw one frame. It receives Image 1 = the original frame, then the reference images you choose, in your order, as Image 2, Image 3 and so on. Write its instruction.`,
    '',
    'Facts you must respect:',
    ...brief.facts.map((f) => `- ${f}`),
    ...(brief.extra ? [`- The human asked for this; it is mandatory: ${brief.extra}`] : []),
    '',
    'The images in this message (their ids in brackets):',
    ...listImages(brief),
    '',
    'First study the frame and the context: what happens, the composition and camera, where each person is, their pose, gesture, expression and gaze, the light (direction, colour, shadows, rim light) and how this anime draws people (line weight and colour, eyes, shading, palette).',
    `Then choose up to ${brief.maxRefs} reference ids (R…) that show each new character best — her approved design sheets first; a library picture only for what the sheets do not show; this shot's other approved storyboard frames to keep her consistent. Never choose F or C… ids.`,
    'Then write the instruction for the image model, in English, concrete and specific to this frame:',
    '- name what to replace by position and looks, and which Image shows the new character (use the numbers she will receive: Image 1 is the frame, your first reference is Image 2, …);',
    '- describe her pose, action, gesture, expression and gaze exactly as the original person has them here, and where she stands;',
    '- describe the new character’s distinguishing features (hair, eyes, outfit) from her references, and the outfit rule from the facts;',
    '- keep everything else of Image 1 exactly: framing, camera, background, other people, props, light and colour grading; light her the way this frame is lit;',
    "- draw her in this anime's own style (flat 2D cel animation, its line weight, eyes and shading), never 3D, painterly or photographic;",
    '- remove the credit text if the facts say so; no new text, labels or watermarks; the human’s requirement, if any.',
    'Finally, notes: one short line in Traditional Chinese telling the human what the frame will show.',
  ].join('\n');
  const paths = brief.images.map((i) => ws.abs(i.path));
  if (services.provider.name !== 'fake')
    assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, paths.length));
  const answer = await metered(ctx, { model, kind: 'vision', shotId: board.shotId }, () =>
    services.provider.analyzeImages<BoardAnswer>({
      model,
      prompt,
      images: paths.map((p) => ({ path: p, mimeType: mimeFor(p) })),
      responseSchema: BOARD_SCHEMA,
      signal,
    }),
  );
  const usd = answer.provider === 'fake' ? 0 : answer.costUsd;
  recordCost(ws.db, {
    jobId: job.id,
    projectId: projectOfShot(ws.db, board.shotId).id,
    provider: answer.provider,
    model,
    usage: answer.usage,
    usd,
  });
  const data = answer.data ?? {};
  const text = (data.prompt ?? '').trim();
  const chosen = [...new Set(data.references ?? [])]
    .map((id) => brief.images.find((i) => i.id === id && i.use === 'reference'))
    .filter((i): i is NonNullable<typeof i> => Boolean(i))
    .slice(0, brief.maxRefs);
  if (text.length < 80) throw new Error('the director wrote no usable instruction');
  if (!chosen.length) throw new Error('the director chose no reference of the new character');
  const frame = brief.images.find((i) => i.use === 'frame')!;
  const inputs: InputRef[] = [
    { role: 'frame', path: frame.path, sha256: sha256File(ws.abs(frame.path)) },
    ...chosen.map((c) => ({ role: `ref:${c.id}`, path: c.path, sha256: sha256File(ws.abs(c.path)) })),
  ];
  // The human's requirement goes in verbatim too, whatever the director made of it.
  const final = brief.extra ? `${text}\nAdditional instructions: ${brief.extra}` : text;
  return {
    prompt: final,
    inputs,
    record: {
      model,
      notes: (data.notes ?? '').trim(),
      analysis: data.analysis ?? {},
      references: chosen.map((c) => ({ id: c.id, label: c.label, path: c.path })),
      costUsd: usd,
    },
  };
}

interface TakeAnswer {
  analysis?: Record<string, string>;
  send?: Array<{ ids?: string[]; what?: string }>;
  prompt?: string;
  notes?: string;
}

const TAKE_SCHEMA = {
  type: 'object',
  properties: {
    analysis: {
      type: 'object',
      properties: {
        motion: { type: 'string' },
        camera: { type: 'string' },
        timing: { type: 'string' },
        lighting: { type: 'string' },
        style: { type: 'string' },
      },
      required: ['motion', 'camera', 'timing', 'lighting', 'style'],
    },
    send: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } }, what: { type: 'string' } },
        required: ['ids', 'what'],
      },
    },
    prompt: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['analysis', 'send', 'prompt', 'notes'],
};

/** The director watches the clip inline up to this size; past it, the shot's frames stand in for the video. */
const INLINE_VIDEO_BYTES = 15_000_000;
/** More images confuse the video models; composites keep the count down. */
const MAX_TAKE_REFS = 4;
const MAX_PER_COMPOSITE = 4;

function sendRule(spec: VideoModelSpec, max: number): string {
  if (spec.refStyle === 'board')
    return 'This model takes exactly ONE reference image. Send the approved storyboard frame (key first); if the first and last storyboard frames are approved too, you may composite them into that one image.';
  if (spec.refStyle === 'per-character')
    return `This model takes ONE reference image PER NEW CHARACTER (at most ${max}), in the order the characters appear from left to right. Each may be a composite of that one character's sheets — never mix two characters in one image.`;
  return `This model takes 1 to ${max} reference images. Send the approved storyboard frame(s) and each new character's design sheets; group related images into one composite (up to ${MAX_PER_COMPOSITE} images tiled into one) to stay within the limit.`;
}

/**
 * The video director: watches the shot (inline video, or its frames when the clip is large), reads the facts and
 * every reference, then writes the video model's instruction in its reference syntax and decides which images to
 * send — composites where the model takes fewer than it should see. Never writes the library characters' names.
 */
export async function directTake(
  ctx: JobContext,
  input: { shotId: string; model: string; extra: string | null; outDir: string; stem: string },
): Promise<{ prompt: string; inputs: InputRef[]; record: DirectorRecord }> {
  const { workspace: ws, services, signal, job } = ctx;
  const spec = videoModelSpec(input.model);
  const max = Math.min(spec.maxRefs, MAX_TAKE_REFS);
  if (max === 0) throw new Error(`${spec.label} takes no reference images`);
  const brief = takeBrief(ws, input.shotId, { extra: input.extra, maxRefs: max });
  if (!brief.images.some((i) => i.use === 'reference'))
    throw new Error('no approved storyboard frame or design sheet to send');
  const videoAbs = ws.abs(brief.video);
  const withVideo = statSync(videoAbs).size <= INLINE_VIDEO_BYTES;
  const media = [
    ...(withVideo
      ? [{ path: videoAbs, mimeType: 'video/mp4', label: 'Video 1: the original shot to edit' }]
      : []),
    ...brief.images.map((img, i) => ({
      path: ws.abs(img.path),
      mimeType: mimeFor(img.path),
      label: `Image ${i + 1} [${img.id}${img.use === 'context' ? ', context only' : ''}]: ${img.label}`,
    })),
  ];
  const model = services.config.models.director;
  const prompt = [
    'You are the director of an anime opening in which some characters are replaced by other characters, shot by shot.',
    `A video model (${spec.label}) will edit this shot: it receives the original shot and the reference images you decide to send. Write its instruction.`,
    '',
    'Facts you must respect:',
    ...brief.facts.map((f) => `- ${f}`),
    ...(brief.extra ? [`- The human asked for this; it is mandatory: ${brief.extra}`] : []),
    '',
    'The media in this message:',
    ...media.map((m) => `- ${m.label}`),
    ...(withVideo ? [] : ['(The clip is too large to attach; the context frames show it.)']),
    '',
    'First watch the shot: the motion of each person (steps, turns, gestures, expressions changing), the camera movement, the timing, the light and how this anime draws people.',
    `Then decide what to send. ${sendRule(spec, max)} Only R… ids may be sent; each entry of "send" becomes one image (several ids = one composite). Send at least ${Math.max(1, spec.minRefs)}.`,
    'Then write the instruction in English. Refer to the images you send as <IMAGE_REF_0>, <IMAGE_REF_1>, … in the order of "send".',
    '- say which person to replace by position and looks, and which <IMAGE_REF_k> shows the new character;',
    '- keep the motion, timing, camera movement, positions, background, other people, light and colour grading of the original exactly; describe the movement you saw so the new character performs it;',
    "- describe each new character's distinguishing features (hair, eyes, outfit) and the outfit rule from the facts;",
    "- in this anime's own flat 2D cel style, never 3D, semi-realistic or photographic;",
    '- remove the credit text if the facts say so; no new text;',
    "- NEVER write the library characters' names — describe them by looks and their reference image (the safety filter blocks some names).",
    'Finally, notes: one short line in Traditional Chinese telling the human what the shot will show.',
  ].join('\n');
  if (services.provider.name !== 'fake')
    assertWithinBudget(
      ws.db,
      services.config.budget.capUsd,
      estimateVisionCost(model, media.length + (withVideo ? 8 : 0)),
    );
  const answer = await metered(ctx, { model, kind: 'vision', shotId: input.shotId }, () =>
    services.provider.analyzeImages<TakeAnswer>({
      model,
      prompt,
      images: media.map((m) => ({ path: m.path, mimeType: m.mimeType })),
      responseSchema: TAKE_SCHEMA,
      signal,
    }),
  );
  const usd = answer.provider === 'fake' ? 0 : answer.costUsd;
  recordCost(ws.db, {
    jobId: job.id,
    projectId: projectOfShot(ws.db, input.shotId).id,
    provider: answer.provider,
    model,
    usage: answer.usage,
    usd,
  });
  const data = answer.data ?? {};
  let text = (data.prompt ?? '').trim();
  const sends = (data.send ?? [])
    .map((s) => ({
      what: (s.what ?? '').trim(),
      refs: [...new Set(s.ids ?? [])]
        .map((id) => brief.images.find((i) => i.id === id && i.use === 'reference'))
        .filter((i): i is NonNullable<typeof i> => Boolean(i))
        .slice(0, MAX_PER_COMPOSITE),
    }))
    .filter((s) => s.refs.length > 0);
  if (text.length < 80) throw new Error('the director wrote no usable instruction');
  if (sends.length < Math.max(1, spec.minRefs) || sends.length > max)
    throw new Error(
      `the director chose ${sends.length} images; ${spec.label} takes ${Math.max(1, spec.minRefs)}–${max}`,
    );
  const used = [...text.matchAll(/<IMAGE_REF_(\d+)>/g)].map((m) => Number(m[1]));
  if (!used.length || used.some((k) => k >= sends.length))
    throw new Error('the instruction refers to images that are not sent');
  for (const name of brief.names)
    if (name.trim().length > 1)
      text = text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'the new character');
  // Composites are kept beside the take, so the request can be replayed and audited.
  const inputs: InputRef[] = [{ role: 'video', path: brief.video, sha256: sha256File(videoAbs) }];
  const references: DirectorRecord['references'] = [];
  for (const [k, s] of sends.entries()) {
    let path = s.refs[0]!.path;
    if (s.refs.length > 1) {
      path = `${input.outDir}/${input.stem}-ref${k + 1}.jpg`;
      const rows: string[][] = [];
      for (let i = 0; i < s.refs.length; i += 2) rows.push(s.refs.slice(i, i + 2).map((x) => ws.abs(x.path)));
      await cropGrid(rows, ws.abs(path), { cell: 768, maxPerRow: 2 }, { signal });
    }
    const id = s.refs.map((x) => x.id).join('+');
    inputs.push({ role: `ref:${id}`, path, sha256: sha256File(ws.abs(path)) });
    references.push({ id, label: s.what || s.refs.map((x) => x.label).join(' + '), path });
  }
  const final = brief.extra ? `${text}\nAdditional instructions: ${brief.extra}` : text;
  return {
    prompt: final,
    inputs,
    record: {
      model,
      notes: (data.notes ?? '').trim(),
      analysis: data.analysis ?? {},
      references,
      costUsd: usd,
    },
  };
}
