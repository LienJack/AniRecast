import {
  assertWithinBudget,
  type Board,
  boardBrief,
  type DirectorBrief,
  type InputRef,
  projectOfShot,
  recordCost,
  sha256File,
} from '@anirecast/core';
import { estimateVisionCost, mimeFor } from '@anirecast/providers';
import { imageModelSpec } from '@anirecast/shared';
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
