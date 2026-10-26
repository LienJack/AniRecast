import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertWithinBudget,
  type Board,
  boardFileStem,
  designDir,
  findActiveClip,
  getBoard,
  getDesign,
  getPersona,
  getProject,
  getRender,
  getShot,
  getTake,
  keyBoardFor,
  listBoards,
  listShots,
  listTakes,
  originalDesignDir,
  projectCacheDir,
  projectDir,
  projectModels,
  projectOfShot,
  type Render,
  recordCost,
  shotDir,
  type Take,
  takeFileStem,
  updateBoard,
  updateDesign,
  updateRender,
  updateTake,
  type Workspace,
} from '@anirecast/core';
import {
  conformByTime,
  conformTake,
  cropGrid,
  probe,
  renderSequence,
  scaleForUpload,
  stackCompare,
  stillClip,
} from '@anirecast/media';
import {
  estimateImageCost,
  estimateVideoEditCost,
  mimeFor,
  type ProviderCallMeta,
  TIER_RESOLUTION,
  TIER_SIZE,
  TIER_UPLOAD_HEIGHT,
  type VideoEditResult,
} from '@anirecast/providers';
import { AniError, toEnvelopeError, uploadSeconds, videoModelSpec } from '@anirecast/shared';
import type { JobContext, JobHandler } from '../runner.ts';
import { finishBoardBatch, followUpKeyBoard } from './board-batch.ts';
import { directBoard, directTake } from './director.ts';
import { metered } from './metered.ts';
import { outPath, span } from './util.ts';

/** Remote uploads expire after ~48 h; reuse one only while it is comfortably fresh. */
const UPLOAD_REUSE_MS = 40 * 3_600_000;
/** Omni accepts at most 10 s per uploaded video. */
const OMNI_MAX_SECONDS = 10;
/**
 * Omni returns whole groups of 4 frames (75 in → 76 out, 33 in → 32 out on the Lycoris OP). Uploads are padded
 * to the step by holding the last frame, and conform absorbs up to 3 frames at the end.
 */
const OMNI_END_TOLERANCE = 3;

function ledger(ctx: JobContext, meta: ProviderCallMeta, projectId: string, tier: string | null): void {
  recordCost(ctx.workspace.db, {
    jobId: ctx.job.id,
    projectId,
    provider: meta.provider,
    model: meta.model,
    tier,
    usage: meta.usage,
    usd: meta.provider === 'fake' ? 0 : meta.costUsd,
  });
}

/** Immutable provenance next to each generated file: enough to replay the request on any machine. */
async function writeProvenance(ws: Workspace, rel: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(outPath(ws, rel), `${JSON.stringify(data, null, 2)}\n`);
}

const budgetCheck = (ctx: JobContext, estimate: number) => {
  if (ctx.services.provider.name !== 'fake')
    assertWithinBudget(ctx.workspace.db, ctx.services.config.budget.capUsd, estimate);
};

export const generateBoardHandler: JobHandler = async (ctx) => {
  const { workspace: ws, services, signal, job } = ctx;
  const { boardId } = job.payload as { boardId: string };
  let board = getBoard(ws.db, boardId);
  const project = projectOfShot(ws.db, board.shotId);
  try {
    // The director writes the instruction and picks the references from what it sees; the planned (template)
    // prompt stays when it fails. A retry reuses what it already decided.
    // A first or last frame drawn with its key frame waits for it, to keep the new characters identical.
    const linked = typeof board.params.consistentWith === 'string' ? board.params.consistentWith : null;
    if (board.role !== 'key' && linked) {
      ctx.progress(0.01, 'waiting for the key frame');
      const until = Date.now() + 15 * 60_000;
      while (Date.now() < until && !signal.aborted) {
        const key = listBoards(ws.db, board.shotId).find((b) => b.id === linked);
        if (!key || !['queued', 'generating'].includes(key.status)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
    }
    let directorUsd = 0;
    if (!board.params.director) {
      ctx.progress(0.03, 'directing: reading the frame and the references');
      try {
        const d = await directBoard(ctx, board);
        directorUsd = d.record.costUsd;
        board = updateBoard(
          ws.db,
          boardId,
          { prompt: d.prompt, inputs: d.inputs, params: { ...board.params, director: d.record } },
          'daemon',
        );
      } catch (error) {
        if (signal.aborted) throw error;
        // The template, plus the key frame for consistency when this is a first or last frame.
        const key = keyBoardFor(ws.db, board);
        const withKey = key?.path && !board.inputs.some((i) => i.path === key.path);
        board = updateBoard(
          ws.db,
          boardId,
          {
            params: {
              ...board.params,
              director: { error: toEnvelopeError(error).message, fallback: true },
            },
            ...(withKey && key?.path
              ? {
                  prompt: `${board.prompt}\nImage ${board.inputs.length + 1} is this shot's key storyboard frame with the new characters already drawn: keep them identical to it (face, hair, outfit, colours, proportions).`,
                  inputs: [...board.inputs, { role: 'key-board', path: key.path }],
                }
              : {}),
          },
          'daemon',
        );
      }
    }
    const images = board.inputs.map((i) => ({ path: ws.abs(i.path), mimeType: mimeFor(i.path) }));
    budgetCheck(ctx, estimateImageCost(board.model, '1K', images.length));
    updateBoard(ws.db, boardId, { status: 'generating' }, 'daemon');
    ctx.progress(0.1, 'generating board');
    const params = board.params as { aspectRatio?: '16:9'; imageSize?: '1K' | '2K' };
    const result = await metered(ctx, { model: board.model, kind: 'image', shotId: board.shotId }, () =>
      services.provider.generateImage({
        model: board.model,
        prompt: board.prompt,
        images,
        aspectRatio: params.aspectRatio ?? '16:9',
        imageSize: params.imageSize ?? '1K',
        signal,
      }),
    );
    ledger(ctx, result, project.id, null);
    const ext = result.mimeType === 'image/png' ? 'png' : 'jpg';
    const stem = `${shotDir(project, board.shotId)}/boards/${boardFileStem(board.version)}`;
    await writeFile(outPath(ws, `${stem}.${ext}`), result.data);
    await writeProvenance(ws, `${stem}.json`, {
      kind: 'board',
      id: board.id,
      shotId: board.shotId,
      version: board.version,
      model: board.model,
      prompt: board.prompt,
      params: board.params,
      inputs: board.inputs,
      provider: result.provider,
      usage: result.usage,
      costUsd: result.costUsd,
      remote: result.remote,
      createdBy: board.createdBy,
      generatedAt: new Date().toISOString(),
    });
    const updated = updateBoard(
      ws.db,
      boardId,
      {
        status: 'ready',
        path: `${stem}.${ext}`,
        costUsd: result.costUsd + directorUsd,
        remote: result.remote,
        error: null,
      },
      'daemon',
    );
    // 生成全部分鏡圖: a key frame decides its first and last frames; the last board of a batch starts Codex's review.
    await afterBatchBoard(ctx, updated);
    return { result: { board: updated }, costUsd: result.costUsd + directorUsd };
  } catch (error) {
    if (!signal.aborted) {
      const failed = updateBoard(
        ws.db,
        boardId,
        { status: 'failed', error: toEnvelopeError(error).message },
        'daemon',
      );
      await afterBatchBoard(ctx, failed, false);
    }
    throw error;
  }
};

/** Batch bookkeeping never fails the board itself. */
async function afterBatchBoard(ctx: JobContext, board: Board, drawn = true): Promise<void> {
  if (!board.params.batch) return;
  try {
    if (drawn) await followUpKeyBoard(ctx, board);
    await finishBoardBatch(ctx, getBoard(ctx.workspace.db, board.id));
  } catch (error) {
    ctx.progress(1, `batch bookkeeping failed: ${toEnvelopeError(error).message}`);
  }
}

/** One character design sheet, drawn by the image model from the persona, style frames and a body crop. */
export const generateDesignHandler: JobHandler = async (ctx) => {
  const { workspace: ws, services, signal, job } = ctx;
  const { designId } = job.payload as { designId: string };
  const design = getDesign(ws.db, designId);
  const project = getProject(ws.db, design.projectId);
  // An original character's own sheet has no library character.
  const persona = design.personaId ? getPersona(ws.db, design.personaId) : null;
  try {
    const params = design.params as {
      aspectRatio?: '16:9' | '9:16' | '1:1';
      imageSize?: '1K' | '2K';
      tile?: { columns?: number };
    };
    const dir =
      persona && design.subject !== 'original'
        ? designDir(project, persona.slug)
        : originalDesignDir(project, design.castMemberId ?? 'unknown');
    const stem = `${dir}/${design.kind}-v${String(design.version).padStart(3, '0')}`;
    // The original's crops for expressions or poses go to the model as one grid (read left to right, top to
    // bottom), so a sheet stays within the few character images the image model handles well.
    const tiles = design.inputs.filter((i) => i.role.startsWith('tile:'));
    const grid = tiles.length ? `${stem}-reference.jpg` : null;
    if (grid) {
      const columns = params.tile?.columns ?? 3;
      const rows: string[][] = [];
      for (let i = 0; i < tiles.length; i += columns)
        rows.push(tiles.slice(i, i + columns).map((t) => ws.abs(t.path)));
      await cropGrid(rows, outPath(ws, grid), { cell: 384, maxPerRow: columns }, { signal });
    }
    const firstTile = design.inputs.findIndex((i) => i.role.startsWith('tile:'));
    const images = design.inputs
      .filter((i, k) => !i.role.startsWith('tile:') || k === firstTile)
      .map((i) => (i.role.startsWith('tile:') && grid ? grid : i.path))
      .map((p) => ({ path: ws.abs(p), mimeType: mimeFor(p) }));
    budgetCheck(ctx, estimateImageCost(design.model, params.imageSize ?? '2K', images.length));
    updateDesign(ws.db, designId, { status: 'generating' }, 'daemon');
    ctx.progress(0.1, `drawing the ${design.kind} sheet`);
    const result = await metered(ctx, { model: design.model, kind: 'image' }, () =>
      services.provider.generateImage({
        model: design.model,
        prompt: design.prompt,
        images,
        aspectRatio: params.aspectRatio ?? '16:9',
        imageSize: params.imageSize ?? '2K',
        signal,
      }),
    );
    ledger(ctx, result, project.id, null);
    const ext = result.mimeType === 'image/png' ? 'png' : 'jpg';
    await writeFile(outPath(ws, `${stem}.${ext}`), result.data);
    await writeProvenance(ws, `${stem}.json`, {
      kind: 'design',
      id: design.id,
      persona: persona ? { id: persona.id, slug: persona.slug, name: persona.name } : null,
      subject: design.subject,
      sheet: design.kind,
      version: design.version,
      model: design.model,
      prompt: design.prompt,
      params: design.params,
      inputs: design.inputs,
      ...(grid ? { referenceGrid: grid } : {}),
      castMemberId: design.castMemberId,
      provider: result.provider,
      usage: result.usage,
      costUsd: result.costUsd,
      createdBy: design.createdBy,
      generatedAt: new Date().toISOString(),
    });
    const updated = updateDesign(
      ws.db,
      designId,
      {
        status: 'ready',
        path: `${stem}.${ext}`,
        costUsd: result.costUsd,
        remote: result.remote,
        error: null,
      },
      'daemon',
    );
    return { result: { design: updated }, costUsd: result.costUsd };
  } catch (error) {
    if (!signal.aborted)
      updateDesign(ws.db, designId, { status: 'failed', error: toEnvelopeError(error).message }, 'daemon');
    throw error;
  }
};

/** The paid output of a take's video request, kept so a retry does not pay for it again. */
interface PaidVideo {
  rawPath: string;
  meta: ProviderCallMeta;
}

function reusableUpload(ws: Workspace, take: Take, uploadSha: string): string | undefined {
  const now = Date.now();
  for (const t of listTakes(ws.db, take.shotId).reverse()) {
    const r = t.remote as { fileUri?: string; uploadSha?: string; uploadedAt?: number };
    if (
      t.id !== take.id &&
      r.fileUri &&
      r.uploadSha === uploadSha &&
      r.uploadedAt &&
      now - r.uploadedAt < UPLOAD_REUSE_MS &&
      !r.fileUri.startsWith('fake://')
    ) {
      return r.fileUri;
    }
  }
  return undefined;
}

export const generateTakeHandler: JobHandler = async (ctx) => {
  const { workspace: ws, services, signal, job, progress } = ctx;
  const { takeId } = job.payload as { takeId: string };
  let take = getTake(ws.db, takeId);
  const shot = getShot(ws.db, take.shotId);
  const project = projectOfShot(ws.db, shot.id);
  const clip = findActiveClip(ws.db, project.id);
  try {
    if (!clip || clip.id !== shot.clipId)
      throw new AniError('conflict', 'Shot does not belong to the active clip');
    const spec = videoModelSpec(take.model);
    const seconds = (shot.frameCount * clip.fpsDen) / clip.fpsNum;
    const maxSeconds = Math.min(spec.maxSeconds, OMNI_MAX_SECONDS);
    if (seconds > maxSeconds) {
      throw new AniError(
        'usage',
        `Shot is ${seconds.toFixed(1)} s; ${spec.label} edits at most ${maxSeconds} s`,
        {
          hint: 'Split the shot (anirecast shots split) before generating.',
        },
      );
    }
    // The director watches the shot and writes the instruction and the references (composites where needed);
    // the planned template stays when it fails. A retry, or a revision with the same model, reuses its decision.
    let directorUsd = 0;
    if (shot.mode === 'replace' && !take.params.director) {
      progress(0.02, 'directing: watching the shot and the references');
      try {
        const extras = (take.params.extras as string[] | undefined) ?? [];
        const d = await directTake(ctx, {
          shotId: shot.id,
          model: take.model,
          extra: extras.join('\n') || null,
          outDir: `${shotDir(project, shot.id)}/takes`,
          stem: takeFileStem(take.version),
          attachments: (take.params.attachments as string[] | undefined) ?? [],
        });
        directorUsd = d.record.costUsd;
        take = updateTake(
          ws.db,
          takeId,
          { prompt: d.prompt, inputs: d.inputs, params: { ...take.params, director: d.record } },
          'daemon',
        );
      } catch (error) {
        if (signal.aborted) throw error;
        take = updateTake(
          ws.db,
          takeId,
          {
            params: {
              ...take.params,
              director: { error: toEnvelopeError(error).message, fallback: true },
            },
          },
          'daemon',
        );
      }
    }
    // Short shots are padded (last frame held) to the model's minimum, whole seconds and frame step, then cut back.
    // A model with a minimum frame rate gets the frames restamped to it (23.976 → 24 fps).
    const uploadFps = spec.minFps && clip.fpsNum / clip.fpsDen < spec.minFps ? spec.minFps : null;
    const uploadRate = uploadFps ?? clip.fpsNum / clip.fpsDen;
    const minFrames = Math.ceil(uploadSeconds(spec, seconds) * uploadRate - 1e-6);
    const video = take.inputs.find((i) => i.role === 'video');
    if (!video) throw new AniError('internal', 'Take has no video input');
    const refs = take.inputs.filter((i) => i.role !== 'video');
    const resolution = TIER_RESOLUTION[take.tier];
    const uploadHeight = Math.min(
      spec.uploadHeight?.max ?? Number.POSITIVE_INFINITY,
      Math.max(spec.uploadHeight?.min ?? 0, TIER_UPLOAD_HEIGHT[take.tier]),
    );
    budgetCheck(
      ctx,
      estimateVideoEditCost(take.model, uploadSeconds(spec, seconds), resolution, refs.length, uploadHeight),
    );
    updateTake(ws.db, takeId, { status: 'generating', framesIn: shot.frameCount }, 'daemon');

    const cache = projectCacheDir(project);
    const fpsTag = uploadFps ? `-fps${uploadFps}` : '';
    const uploadRel = `${cache}/uploads/${shot.id}-${uploadHeight}p-step${spec.frameStep}-min${minFrames}${fpsTag}.mp4`;
    progress(0.05, 'preparing upload');
    const upload = await scaleForUpload(ws.abs(video.path), outPath(ws, uploadRel), uploadHeight, {
      signal,
      frameStep: spec.frameStep,
      minFrames,
      ...(uploadFps ? { fps: uploadFps } : {}),
    });
    const uploadedSeconds = (upload.frames + upload.padded) / uploadRate;
    const uploadSha = `${video.sha256 ?? ''}:${uploadHeight}:step${spec.frameStep}:min${minFrames}${fpsTag}`;
    const cachedFileUri = reusableUpload(ws, take, uploadSha);

    // A retry after the paid request went through (download, conform …) reuses what the model made: one video,
    // paid once.
    const made = (take.remote as { made?: PaidVideo }).made;
    const earlier = made && existsSync(ws.abs(made.rawPath)) ? made : null;
    const result: VideoEditResult = earlier
      ? { ...earlier.meta, data: await readFile(ws.abs(earlier.rawPath)), mimeType: 'video/mp4' }
      : await metered(ctx, { model: take.model, kind: 'video_edit', shotId: shot.id }, () =>
          services.provider.editVideo({
            model: take.model,
            prompt: take.prompt,
            video: { path: ws.abs(uploadRel), mimeType: 'video/mp4' },
            inputFrames: upload.frames + upload.padded,
            inputSeconds: uploadedSeconds,
            images: refs.map((r) => ({ path: ws.abs(r.path), mimeType: mimeFor(r.path) })),
            resolution,
            aspectRatio: '16:9',
            ...(cachedFileUri ? { cachedFileUri } : {}),
            signal,
            onStatus: (m) => progress(0.15, m),
          }),
        );
    if (!earlier) ledger(ctx, result, project.id, take.tier);
    const stem = takeFileStem(take.version);
    const rawRel = earlier?.rawPath ?? `${cache}/takes/${shot.id}-${take.id}.raw.mp4`;
    const { data: _data, mimeType: _mime, ...meta } = result;
    const remote = {
      ...result.remote,
      uploadSha,
      uploadedAt: cachedFileUri ? undefined : Date.now(),
      made: { rawPath: rawRel, meta } satisfies PaidVideo,
    };
    if (!earlier) {
      await writeFile(outPath(ws, rawRel), result.data);
      updateTake(ws.db, takeId, { remote, costUsd: result.costUsd + directorUsd }, 'daemon');
    }
    progress(0.8, 'conforming');
    const size = TIER_SIZE[take.tier];
    const outRel = `${shotDir(project, shot.id)}/takes/${stem}.mp4`;
    let conform: Awaited<ReturnType<typeof conformTake>> | Awaited<ReturnType<typeof conformByTime>>;
    try {
      const base = { frames: shot.frameCount, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen, ...size };
      // Frame-exact models (Omni) are conformed by count; the others by time, padding cut off.
      conform =
        spec.timing === 'frames'
          ? await conformTake(
              ws.abs(rawRel),
              outPath(ws, outRel),
              { ...base, endTolerance: Math.max(OMNI_END_TOLERANCE, upload.padded) },
              { signal },
            )
          : await conformByTime(
              ws.abs(rawRel),
              outPath(ws, outRel),
              { ...base, inputSeconds: uploadedSeconds },
              { signal },
            );
    } catch (error) {
      updateTake(
        ws.db,
        takeId,
        {
          remote,
          costUsd: result.costUsd + directorUsd,
          framesOut: ((error as AniError).details as { framesOut?: number })?.framesOut ?? null,
        },
        'daemon',
      );
      throw error;
    }
    progress(0.9, 'building review compare');
    const compareRel = `${cache}/takes/${shot.id}-${stem}.compare.mp4`;
    if (!shot.sourcePath) throw new AniError('internal', 'Shot source missing');
    await stackCompare(
      ws.abs(shot.sourcePath),
      ws.abs(outRel),
      outPath(ws, compareRel),
      { layout: 'v', height: 360 },
      { signal },
    );
    await writeProvenance(ws, `${shotDir(project, shot.id)}/takes/${stem}.json`, {
      kind: 'take',
      id: take.id,
      shotId: shot.id,
      version: take.version,
      tier: take.tier,
      model: take.model,
      prompt: take.prompt,
      params: take.params,
      inputs: take.inputs,
      boardId: take.boardId,
      provider: result.provider,
      usage: result.usage,
      costUsd: result.costUsd + directorUsd,
      remote: { interactionId: result.remote.interactionId },
      conform,
      createdBy: take.createdBy,
      generatedAt: new Date().toISOString(),
    });
    const updated = updateTake(
      ws.db,
      takeId,
      {
        status: 'ready',
        path: outRel,
        costUsd: result.costUsd + directorUsd,
        remote: { ...remote, comparePath: compareRel },
        framesOut: conform.framesOut,
        conform: { ...conform },
        error: null,
      },
      'daemon',
    );
    return { result: { take: updated }, costUsd: result.costUsd + directorUsd };
  } catch (error) {
    if (!signal.aborted)
      updateTake(ws.db, takeId, { status: 'failed', error: toEnvelopeError(error).message }, 'daemon');
    throw error;
  }
};

/** Holds the approved board for the shot's exact frame count; no provider request, no cost. */
export const stillTakeHandler: JobHandler = async (ctx) => {
  const { workspace: ws, signal, job, progress } = ctx;
  const { takeId } = job.payload as { takeId: string };
  const take = getTake(ws.db, takeId);
  const shot = getShot(ws.db, take.shotId);
  const project = projectOfShot(ws.db, shot.id);
  const clip = findActiveClip(ws.db, project.id);
  try {
    if (!clip || clip.id !== shot.clipId)
      throw new AniError('conflict', 'Shot does not belong to the active clip');
    const board = take.inputs.find((i) => i.role === 'board');
    if (!board) throw new AniError('internal', 'Still take has no board input');
    if (!shot.sourcePath) throw new AniError('internal', 'Shot source missing');
    updateTake(ws.db, takeId, { status: 'generating', framesIn: shot.frameCount }, 'daemon');
    progress(0.1, 'holding the board');
    const stem = takeFileStem(take.version);
    const outRel = `${shotDir(project, shot.id)}/takes/${stem}.mp4`;
    const size = TIER_SIZE[take.tier];
    await stillClip(
      ws.abs(board.path),
      outPath(ws, outRel),
      { frames: shot.frameCount, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen, ...size },
      { signal },
    );
    const out = await probe(ws.abs(outRel), { countFrames: true, signal });
    if (out.frameCount !== shot.frameCount)
      throw new AniError(
        'internal',
        `Still clip has ${out.frameCount} frames, the shot has ${shot.frameCount}`,
      );
    progress(0.7, 'building review compare');
    const compareRel = `${projectCacheDir(project)}/takes/${shot.id}-${stem}.compare.mp4`;
    await stackCompare(
      ws.abs(shot.sourcePath),
      ws.abs(outRel),
      outPath(ws, compareRel),
      { layout: 'v', height: 360 },
      { signal },
    );
    const conform = {
      framesIn: shot.frameCount,
      framesOut: out.frameCount,
      endAdjust: 0,
      sourceFps: `${clip.fpsNum}/${clip.fpsDen}`,
      sourceSize: `${size.width}x${size.height}`,
    };
    await writeProvenance(ws, `${shotDir(project, shot.id)}/takes/${stem}.json`, {
      kind: 'take',
      id: take.id,
      shotId: shot.id,
      version: take.version,
      tier: take.tier,
      model: take.model,
      still: true,
      inputs: take.inputs,
      boardId: take.boardId,
      costUsd: 0,
      conform,
      createdBy: take.createdBy,
      generatedAt: new Date().toISOString(),
    });
    const updated = updateTake(
      ws.db,
      takeId,
      {
        status: 'ready',
        path: outRel,
        costUsd: 0,
        remote: { comparePath: compareRel },
        framesOut: out.frameCount,
        conform,
        error: null,
      },
      'daemon',
    );
    return { result: { take: updated }, costUsd: 0 };
  } catch (error) {
    if (!signal.aborted)
      updateTake(ws.db, takeId, { status: 'failed', error: toEnvelopeError(error).message }, 'daemon');
    throw error;
  }
};

/** Picks each shot's segment for a render; final renders refuse anything not approved at the tier. */
export function renderPlan(ws: Workspace, render: Render): Render['shots'] {
  const clip = findActiveClip(ws.db, render.projectId);
  if (!clip) throw new AniError('conflict', 'Project has no clip');
  const missing: string[] = [];
  const plan = listShots(ws.db, clip.id).map((shot): Render['shots'][number] => {
    if (shot.mode === 'keep' || shot.mode === 'exclude') return { shotId: shot.id, source: 'original' };
    const takes = listTakes(ws.db, shot.id).filter((t) => t.path);
    const approvedAtTier = takes.filter((t) => t.status === 'approved' && t.tier === render.tier).at(-1);
    if (approvedAtTier) return { shotId: shot.id, source: 'take', takeId: approvedAtTier.id };
    if (render.kind === 'final') {
      missing.push(`#${shot.orderIndex + 1}`);
      return { shotId: shot.id, source: 'original' };
    }
    const best =
      takes.filter((t) => t.status === 'approved').at(-1) ?? takes.filter((t) => t.status === 'ready').at(-1);
    return best
      ? { shotId: shot.id, source: 'take', takeId: best.id }
      : { shotId: shot.id, source: 'original' };
  });
  if (missing.length > 0) {
    throw new AniError(
      'conflict',
      `Final render needs approved ${render.tier} takes for shots ${missing.join(', ')}`,
      {
        hint: 'Approve them, set them to keep the original, or make a draft render.',
      },
    );
  }
  return plan;
}

export const composeRenderHandler: JobHandler = async (ctx) => {
  const { workspace: ws, signal, job, progress } = ctx;
  const { renderId } = job.payload as { renderId: string };
  const render = getRender(ws.db, renderId);
  const project = getProject(ws.db, render.projectId);
  try {
    const clip = findActiveClip(ws.db, project.id);
    if (!clip?.filePath || !clip.audioPath) throw new AniError('conflict', 'Clip is not ready');
    updateRender(ws.db, renderId, { status: 'rendering' }, 'daemon');
    const plan = renderPlan(ws, render);
    const segments = plan.map((p) => {
      const shot = getShot(ws.db, p.shotId);
      const file = p.source === 'take' && p.takeId ? getTake(ws.db, p.takeId).path : shot.sourcePath;
      if (!file) throw new AniError('internal', `No segment for shot ${shot.id}`);
      return { file: ws.abs(file), frames: shot.frameCount };
    });
    const size = TIER_SIZE[render.tier];
    const stem = `${projectDir(project)}/renders/r${String(render.version).padStart(3, '0')}`;
    const total = await renderSequence(
      segments,
      ws.abs(clip.audioPath),
      outPath(ws, `${stem}.mp4`),
      { fpsNum: clip.fpsNum, fpsDen: clip.fpsDen, ...size, draftMark: render.kind === 'draft' },
      { signal, onProgress: span(progress, 0, 0.7, 'rendering') },
    );
    if (total !== clip.frameCount)
      throw new AniError('internal', `Render has ${total} frames, clip has ${clip.frameCount}`);
    progress(0.75, 'comparison video');
    const original = ws.abs(clip.filePath);
    const compareHeight = Math.min(size.height, 720);
    await stackCompare(
      original,
      ws.abs(`${stem}.mp4`),
      outPath(ws, `${stem}.compare.mp4`),
      { layout: 'h', height: compareHeight, audioFrom: ws.abs(clip.audioPath) },
      { signal },
    );
    progress(0.9, 'slider proxy');
    const proxyRel = `${projectCacheDir(project)}/renders/r${String(render.version).padStart(3, '0')}.slider.mp4`;
    await stackCompare(
      original,
      ws.abs(`${stem}.mp4`),
      outPath(ws, proxyRel),
      { layout: 'v', height: 540, audioFrom: ws.abs(clip.audioPath) },
      { signal },
    );
    await writeProvenance(ws, `${stem}.json`, {
      kind: 'render',
      id: render.id,
      version: render.version,
      renderKind: render.kind,
      tier: render.tier,
      size,
      frames: total,
      shots: plan,
      generatedAt: new Date().toISOString(),
    });
    const updated = updateRender(
      ws.db,
      renderId,
      {
        status: 'ready',
        path: `${stem}.mp4`,
        comparePath: `${stem}.compare.mp4`,
        compareProxyPath: proxyRel,
        shots: plan,
        error: null,
      },
      'daemon',
    );
    return { result: { render: updated } };
  } catch (error) {
    if (!signal.aborted)
      updateRender(ws.db, renderId, { status: 'failed', error: toEnvelopeError(error).message }, 'daemon');
    throw error;
  }
};

/** Keeps the original under a stable name when a user exports (copy, never move). */
export async function exportFile(ws: Workspace, rel: string, name: string): Promise<string> {
  const target = `${rel.split('/').slice(0, 2).join('/')}/exports/${name}`;
  await copyFile(ws.abs(rel), outPath(ws, target));
  return path.posix.normalize(target);
}

/**
 * 預覽提示詞: the video director's decision for a shot without making the video — the instruction, the images it
 * would send (composites kept in the cache) and its reading of the shot. Costs one vision call.
 */
export const planTakeHandler: JobHandler = async (ctx) => {
  const { workspace: ws, job } = ctx;
  const {
    shotId,
    model: chosen,
    extra,
    attachments,
  } = job.payload as {
    shotId: string;
    model?: string;
    extra?: string;
    attachments?: string[];
  };
  const project = projectOfShot(ws.db, shotId);
  const model = chosen ?? projectModels(ws.db, project.id).video;
  const d = await directTake(ctx, {
    shotId,
    model,
    extra: extra?.trim() || null,
    outDir: `${projectCacheDir(project)}/take-plan/${job.id}`,
    stem: 'plan',
    attachments: attachments ?? [],
  });
  return {
    result: { model, prompt: d.prompt, inputs: d.inputs, director: d.record },
    costUsd: d.record.costUsd,
  };
};
