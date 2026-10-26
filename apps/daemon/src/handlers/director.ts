import { statSync } from 'node:fs';
import {
  assertWithinBudget,
  type Board,
  boardBrief,
  type DirectorBrief,
  type FrameRange,
  findActiveClip,
  getShot,
  type InputRef,
  projectOfShot,
  recordCost,
  sha256File,
  type TakeBrief,
  takeBrief,
} from '@anirecast/core';
import { composeReference } from '@anirecast/media';
import { estimateVisionCost, mimeFor } from '@anirecast/providers';
import { imageModelSpec, toEnvelopeError, type VideoModelSpec, videoModelSpec } from '@anirecast/shared';
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
  /** A video instruction is reviewed once before the paid request: what the review changed. */
  critique?: { changes: string[]; kept?: string };
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
    `Then choose up to ${brief.maxRefs} reference ids (R…) that show each new character best — her approved design sheets first; a library picture only for what the sheets do not show; this shot's other storyboard frames to keep her consistent. If this shot's key storyboard frame is offered, send it first and keep the new characters identical to it (this frame must look like the same people). The original character's approved sheets show who is replaced and share the layout of hers cell for cell: use them to find the matching pose or expression (send one only when it helps, and say it shows the original, not the new character). Images the human attached matter: use them as their requirement says. Never choose F or C… ids. If an art style reference is offered, add it last and say in the instruction that this Image is only the art style reference (match its line weight, eyes, shading and colours; do not draw anyone from it).`,
    'Then write the instruction for the image model, in English, concrete and specific to this frame:',
    '- name what to replace by position and looks, and which Image shows the new character (use the numbers she will receive: Image 1 is the frame, your first reference is Image 2, …);',
    '- describe her pose, action, gesture, expression and gaze exactly as the original person has them here, and where she stands;',
    '- describe the new character’s distinguishing features (hair, eyes, outfit) from her references, and the outfit rule from the facts;',
    '- keep everything else of Image 1 exactly: framing, camera, background, other people, props, light and colour grading; light her the way this frame is lit;',
    "- draw her in this anime's own style: write the specific traits from the style bible (line weight and colour, how eyes and faces are built, cel shadow tones and edges, shadow colours, highlights, palette, the compositing glow and grain) — not generic words like 'anime style' — and name what to avoid from the bible (3D, smooth CG skin, painterly, photographic);",
    '- remove the credit text if the facts say so; no new text, labels or watermarks; the human’s requirement, if any.',
    'Finally, notes: one short line in Traditional Chinese telling the human what the frame will show.',
  ].join('\n');
  const paths = brief.images.map((i) => ws.abs(i.path));
  if (services.provider.name !== 'fake')
    assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, paths.length));
  const answer = await onceMore(ctx, () =>
    metered(ctx, { model, kind: 'vision', shotId: board.shotId }, () =>
      services.provider.analyzeImages<BoardAnswer>({
        model,
        prompt,
        images: paths.map((p) => ({ path: p, mimeType: mimeFor(p) })),
        responseSchema: BOARD_SCHEMA,
        signal,
      }),
    ),
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
  input: {
    shotId: string;
    model: string;
    extra: string | null;
    outDir: string;
    stem: string;
    attachments?: string[];
    /** A partial take: the part it redoes, its clip, and the kept frames around it. */
    part?: {
      range: FrameRange;
      video: string;
      seams: Array<{ label: string; path: string }>;
      frames?: Array<{ label: string; path: string }>;
      cuts?: number[];
      startsAtCut?: boolean;
      endsAtCut?: boolean;
    };
  },
): Promise<{ prompt: string; inputs: InputRef[]; record: DirectorRecord }> {
  const { workspace: ws, services, signal, job } = ctx;
  const spec = videoModelSpec(input.model);
  const max = Math.min(spec.maxRefs, MAX_TAKE_REFS);
  if (max === 0) throw new Error(`${spec.label} takes no reference images`);
  const brief = takeBrief(ws, input.shotId, {
    extra: input.extra,
    maxRefs: max,
    attachments: input.attachments ?? [],
    ...(input.part ? { part: input.part } : {}),
  });
  if (!brief.images.some((i) => i.use === 'reference'))
    throw new Error('no approved storyboard frame or design sheet to send');
  const videoAbs = ws.abs(brief.video);
  // The vision model refuses very short clips ("invalid argument" on a 10-frame part): those go as frames only.
  const clip = findActiveClip(ws.db, projectOfShot(ws.db, input.shotId).id);
  // Whole shots too: shot 23 is 8 frames, and Codex's preview failed the same way.
  const frames = input.part
    ? input.part.range.end - input.part.range.start + 1
    : getShot(ws.db, input.shotId).frameCount;
  const clipSeconds = clip ? (frames * clip.fpsDen) / clip.fpsNum : Number.POSITIVE_INFINITY;
  const withVideo = statSync(videoAbs).size <= INLINE_VIDEO_BYTES && clipSeconds >= 1;
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
    ...(withVideo
      ? []
      : ['(The clip is not attached — too large, or too short for video; the context frames show it.)']),
    '',
    'First watch the shot: the motion of each person (steps, turns, gestures, expressions changing), the camera movement, the timing, the light and how this anime draws people.',
    `Then decide what to send. ${sendRule(spec, max)} Only R… ids may be sent; each entry of "send" becomes one image (several ids = one composite: e.g. the replacement's turnaround with her expression sheet, or the original's sheet beside hers so the model sees which becomes which). The original character's approved sheets show who is replaced, cell for cell like the replacement's. Images the human attached matter: use them as their requirement says. Send at least ${Math.max(1, spec.minRefs)}. If the model takes more than the characters need and an art style reference is offered, you may send it as its own image and say it is only the art style reference.`,
    'Then write the instruction in English. Refer to the images you send as <IMAGE_REF_0>, <IMAGE_REF_1>, … in the order of "send".',
    '- say which person to replace by position and looks, and which <IMAGE_REF_k> shows the new character;',
    '- keep the motion, timing, camera movement, positions, background, other people, light and colour grading of the original exactly; describe the movement you saw so the new character performs it;',
    '- keep what hides each person: where the original is partly behind a door, wall or object, or only peeks out, the new character is hidden the same way and does the same action with the same hand (e.g. turning a sign over);',
    '- text in the scene (shop signs, door plates, posters, screens) stays exactly as in the original: quote it word for word and say it must not change — models that redraw the whole frame garble text otherwise;',
    "- describe each new character's distinguishing features (hair, eyes, outfit) and the outfit rule from the facts;",
    "- in this anime's own style: write the specific traits from the style bible (line weight and colour, eye and face construction, cel shadow tones and edges, palette, compositing effects) rather than generic words, keep its motion feel (e.g. drawn on twos, no smooth interpolation or motion blur if the bible says so), and name what to avoid (3D, smooth CG skin, semi-realistic, photographic) — close-ups drift most;",
    '- remove the credit text if the facts say so (credits only, never the text in the scene); no new text;',
    "- NEVER write the library characters' names — describe them by looks and their reference image (the safety filter blocks some names).",
    'Finally, notes: one short line in Traditional Chinese telling the human what the shot will show.',
  ].join('\n');
  if (services.provider.name !== 'fake')
    assertWithinBudget(
      ws.db,
      services.config.budget.capUsd,
      estimateVisionCost(model, media.length + (withVideo ? 8 : 0)),
    );
  const answer = await onceMore(ctx, () =>
    metered(ctx, { model, kind: 'vision', shotId: input.shotId }, () =>
      services.provider.analyzeImages<TakeAnswer>({
        model,
        prompt,
        images: media.map((m) => ({ path: m.path, mimeType: m.mimeType })),
        responseSchema: TAKE_SCHEMA,
        signal,
      }),
    ),
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
      await composeReference(
        s.refs.map((x) => ws.abs(x.path)),
        ws.abs(path),
        {},
        { signal },
      );
    }
    const id = s.refs.map((x) => x.id).join('+');
    inputs.push({ role: `ref:${id}`, path, sha256: sha256File(ws.abs(path)) });
    references.push({ id, label: s.what || s.refs.map((x) => x.label).join(' + '), path });
  }
  // A shot video is expensive: the instruction is reviewed against the clip and the exact images sent before
  // the request goes out; a review that breaks the rules is ignored and the draft stands.
  const reviewed = await critiqueTake(ctx, {
    model,
    spec,
    draft: text,
    brief,
    withVideo,
    videoAbs,
    sent: references.map((r, k) => ({ label: `<IMAGE_REF_${k}>: ${r.label}`, path: ws.abs(r.path) })),
    sendsCount: sends.length,
  });
  text = reviewed.prompt;
  const final = brief.extra ? `${text}\nAdditional instructions: ${brief.extra}` : text;
  return {
    prompt: final,
    inputs,
    record: {
      model,
      notes: (data.notes ?? '').trim(),
      analysis: data.analysis ?? {},
      references,
      costUsd: usd + reviewed.costUsd,
      critique: reviewed.critique,
    },
  };
}

interface CritiqueAnswer {
  prompt?: string;
  changes?: string[];
}

/**
 * The second look before an expensive video request: the draft instruction is checked against the clip and the
 * exact images that will be sent, and returned corrected (same <IMAGE_REF_k> numbering) with what changed.
 */
async function critiqueTake(
  ctx: JobContext,
  input: {
    model: string;
    spec: VideoModelSpec;
    draft: string;
    brief: TakeBrief;
    withVideo: boolean;
    videoAbs: string;
    sent: Array<{ label: string; path: string }>;
    sendsCount: number;
  },
): Promise<{ prompt: string; costUsd: number; critique: DirectorRecord['critique'] }> {
  const { workspace: ws, services, signal, job } = ctx;
  const media = [
    ...(input.withVideo
      ? [{ path: input.videoAbs, mimeType: 'video/mp4', label: 'Video 1: the original shot' }]
      : []),
    ...input.sent.map((s) => ({ path: s.path, mimeType: mimeFor(s.path), label: s.label })),
  ];
  const prompt = [
    `You review a video-edit instruction before it is sent to ${input.spec.label} — an expensive request that cannot be undone.`,
    `The media: ${media.map((m) => m.label).join('; ')}.`,
    'Facts the instruction must respect:',
    ...input.brief.facts.map((f) => `- ${f}`),
    ...(input.brief.extra ? [`- Mandatory requirement from the human: ${input.brief.extra}`] : []),
    '',
    'Draft instruction:',
    input.draft,
    '',
    'Check it carefully and fix what is wrong:',
    '1. every <IMAGE_REF_k> is used for what that image really shows (look at each one), and only these refs exist;',
    '2. the motion, gestures, expression changes, camera movement and timing match the video exactly;',
    '3. who is replaced is unambiguous (position and looks), the count of people is right, and everyone and everything else stays unchanged — she is hidden by doors or objects exactly where the original is, and text in the scene (signs, plates) is quoted word for word;',
    "4. each new character's face, hair, eyes and outfit match her reference images and storyboard frames, with the outfit rule from the facts;",
    "5. the style part names this anime's specific traits from the style bible and what to avoid; anime motion feel is kept;",
    '6. no library character names; no added text; the instruction is concise and concrete, not padded with generic adjectives.',
    'Return the final instruction (keep what is right, same <IMAGE_REF_k> numbering) and the list of changes you made — each one short, in Traditional Chinese; an empty list if the draft was already right.',
  ].join('\n');
  try {
    if (services.provider.name !== 'fake')
      assertWithinBudget(
        ws.db,
        services.config.budget.capUsd,
        estimateVisionCost(input.model, media.length + 8),
      );
    const answer = await onceMore(ctx, () =>
      metered(ctx, { model: input.model, kind: 'vision', shotId: input.brief.shotId }, () =>
        services.provider.analyzeImages<CritiqueAnswer>({
          model: input.model,
          prompt,
          images: media.map((m) => ({ path: m.path, mimeType: m.mimeType })),
          responseSchema: {
            type: 'object',
            properties: { prompt: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } } },
            required: ['prompt', 'changes'],
          },
          signal,
        }),
      ),
    );
    const usd = answer.provider === 'fake' ? 0 : answer.costUsd;
    recordCost(ws.db, {
      jobId: job.id,
      projectId: projectOfShot(ws.db, input.brief.shotId).id,
      provider: answer.provider,
      model: input.model,
      usage: answer.usage,
      usd,
    });
    let text = (answer.data?.prompt ?? '').trim();
    const used = [...text.matchAll(/<IMAGE_REF_(\d+)>/g)].map((m) => Number(m[1]));
    const valid = text.length >= 80 && used.length > 0 && used.every((k) => k < input.sendsCount);
    if (!valid)
      return {
        prompt: input.draft,
        costUsd: usd,
        critique: { changes: [], kept: 'the review broke the rules; the draft stands' },
      };
    for (const name of input.brief.names)
      if (name.trim().length > 1)
        text = text.replace(
          new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          'the new character',
        );
    return {
      prompt: text,
      costUsd: usd,
      critique: { changes: (answer.data?.changes ?? []).map((c) => c.trim()).filter(Boolean) },
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      prompt: input.draft,
      costUsd: 0,
      critique: { changes: [], kept: `review failed (${toEnvelopeError(error).message}); the draft stands` },
    };
  }
}

/** A network hiccup is tried once more (after a short wait) before the director gives up for the template. */
async function onceMore<T>(ctx: JobContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (ctx.signal.aborted || toEnvelopeError(error).code !== 'transient') throw error;
    await new Promise((r) => setTimeout(r, 3000));
    return fn();
  }
}
