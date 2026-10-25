import {
  assertWithinBudget,
  castAppearances,
  type DesignKind,
  getCastMember,
  getProject,
  MAX_EXPRESSIONS,
  MAX_POSES,
  normalizeAnalysis,
  queueDesign,
  recordCost,
  saveCastAnalysis,
  setCastAnalysisStatus,
} from '@anirecast/core';
import { estimateVisionCost, type LocalMedia } from '@anirecast/providers';
import { AniError, toEnvelopeError } from '@anirecast/shared';
import type { JobContext, JobHandler } from '../runner.ts';
import { metered } from './metered.ts';

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    style: { type: 'string' },
    body: { type: 'string' },
    outfit: { type: 'string' },
    expressions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          appearance: { type: 'integer' },
        },
        required: ['label', 'appearance'],
      },
    },
    poses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          appearance: { type: 'integer' },
        },
        required: ['label', 'appearance'],
      },
    },
  },
  required: ['style', 'body', 'outfit', 'expressions', 'poses'],
};

/**
 * 原片分析: crops of one original character (clearest appearance per shot) to a vision model, which describes
 * how the animation draws her and lists her distinct expressions and poses, each tied to an appearance.
 * With `thenKinds`, the design sheets are queued from it.
 */
export const analyzeCastHandler: JobHandler = async (ctx: JobContext) => {
  const { workspace: ws, services, signal, job } = ctx;
  const {
    castMemberId,
    thenKinds = [],
    actor = 'daemon',
  } = job.payload as {
    castMemberId: string;
    thenKinds?: DesignKind[];
    actor?: string;
  };
  const cast = getCastMember(ws.db, castMemberId);
  const project = getProject(ws.db, cast.projectId);
  try {
    setCastAnalysisStatus(ws.db, cast.id, 'analyzing', 'daemon');
    const appearances = castAppearances(ws, cast.id, 16);
    if (!appearances.length)
      throw new AniError('conflict', `No usable crops of "${cast.label}"`, {
        hint: 'Run same-person identification (the cast step) first.',
      });
    const images: LocalMedia[] = [];
    const legend: string[] = [];
    for (const [i, a] of appearances.entries()) {
      const head = images.push({ path: ws.abs(a.head as string), mimeType: 'image/jpeg' });
      const body = a.body ? images.push({ path: ws.abs(a.body), mimeType: 'image/jpeg' }) : null;
      legend.push(
        `Appearance ${i + 1} (shot #${a.shotNo}): image ${head} is the head${body ? `, image ${body} the whole body` : ''}.`,
      );
    }
    const model = services.config.models.vision;
    if (services.provider.name !== 'fake')
      assertWithinBudget(ws.db, services.config.budget.capUsd, estimateVisionCost(model, images.length));
    ctx.progress(0.2, `analysing ${appearances.length} appearances`);
    const result = await metered(ctx, { model, kind: 'vision' }, () =>
      services.provider.analyzeImages<Record<string, unknown>>({
        model,
        prompt: [
          `These images show one character, "${cast.label}", from an anime opening, appearance by appearance:`,
          ...legend,
          'Return:',
          '- style: how this animation draws her, concretely enough for an artist to imitate — eye shape and highlights, face construction, line weight and colour, shading (cel shadow layers, highlights), colour saturation, level of detail. Two or three sentences.',
          '- body: her build and proportions — head-to-body ratio, height impression, silhouette. One sentence.',
          '- outfit: what she wears, with colours. One sentence.',
          `- expressions: the distinct facial expressions she shows (at most ${MAX_EXPRESSIONS}, most characteristic first): a short label (e.g. "determined glare"), one line on eyes, brows and mouth, and the number of the appearance that shows it best.`,
          `- poses: the distinct poses or actions she performs (at most ${MAX_POSES}): a short label (e.g. "running, gun drawn"), one line on body angle, limbs and camera angle, and the number of the appearance that shows it best (prefer appearances with a whole-body image).`,
          'Only list what the images show. Answer in English.',
        ].join('\n'),
        images,
        responseSchema: ANALYSIS_SCHEMA,
        signal,
      }),
    );
    const costUsd = result.provider === 'fake' ? 0 : result.costUsd;
    recordCost(ws.db, {
      jobId: job.id,
      projectId: project.id,
      provider: result.provider,
      model,
      usage: result.usage,
      usd: costUsd,
    });
    const data = normalizeAnalysis(result.data ?? {}, appearances);
    saveCastAnalysis(ws.db, cast.id, data, { model, costUsd, actor: 'daemon' });
    const designs = thenKinds.flatMap((kind) =>
      queueDesign(ws, project.id, cast.id, actor, { kind }).map((q) => q.design.id),
    );
    return {
      result: { expressions: data.expressions.length, poses: data.poses.length, designs },
      costUsd,
    };
  } catch (error) {
    if (!signal.aborted)
      setCastAnalysisStatus(ws.db, cast.id, 'failed', 'daemon', toEnvelopeError(error).message);
    throw error;
  }
};
