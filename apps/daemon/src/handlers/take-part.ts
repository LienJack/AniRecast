import { rmSync } from 'node:fs';
import {
  type Clip,
  type FrameRange,
  findActiveClip,
  getShot,
  getTake,
  type PartSeams,
  projectCacheDir,
  projectOfShot,
  type Shot,
  shotDir,
  takeFileStem,
  updateTake,
} from '@anirecast/core';
import {
  decodedFrames,
  extractFrame,
  extractVideoSegment,
  rangePsnr,
  sceneChanges,
  spliceRange,
  stackCompare,
} from '@anirecast/media';
import { TIER_SIZE } from '@anirecast/providers';
import { AniError, toEnvelopeError } from '@anirecast/shared';
import type { JobContext, JobHandler } from '../runner.ts';
import { outPath } from './util.ts';

/** Kept frames re-encoded with the new part score well above this; a shifted or wrong frame far below. */
const KEPT_MIN_PSNR_DB = 40;

/**
 * What a partial take edits: its frames of the shot as a clip of their own, and the kept take's frames right
 * around them, so the director keeps the new characters' looks and light continuous across the joins.
 */
export async function cutPart(
  ctx: JobContext,
  {
    shot,
    clip,
    range,
    keepPath,
    dir,
    stem,
    seams: wanted = 'both',
  }: {
    shot: Shot;
    clip: Clip;
    range: FrameRange;
    keepPath: string;
    dir: string;
    stem: string;
    /** `none` when the frames beside the part are being redone too (they would show the wrong thing). */
    seams?: PartSeams;
  },
): Promise<{
  range: FrameRange;
  video: string;
  seams: Array<{ label: string; path: string }>;
  frames: Array<{ label: string; path: string }>;
  cuts: number[];
  startsAtCut: boolean;
  endsAtCut: boolean;
}> {
  const { workspace: ws, signal } = ctx;
  if (!shot.sourcePath) throw new AniError('conflict', 'Shot source segment is not prepared yet');
  const frames = range.end - range.start + 1;
  const video = `${dir}/${stem}-part.mp4`;
  await extractVideoSegment(
    ws.abs(shot.sourcePath),
    outPath(ws, video),
    { startFrame: range.start, frameCount: frames, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen },
    { crf: 16, signal },
  );
  const decoded = await decodedFrames(ws.abs(video), { signal });
  if (decoded !== frames)
    throw new AniError('internal', `The part clip decodes ${decoded} of ${frames} frames`);
  const seams: Array<{ label: string; path: string }> = [];
  const kept = async (frame: number, where: string) => {
    const path = `${dir}/${stem}-kept-f${frame}.jpg`;
    await extractFrame(ws.abs(keepPath), outPath(ws, path), frame, clip.fpsNum, clip.fpsDen, { signal });
    seams.push({
      label: `already made: frame ${frame} of the finished shot, ${where} (the new characters as they must look there)`,
      path,
    });
  };
  // At a cut there is nothing to flow from or into: shot 24's part began at its close-up, was told to "start out
  // of" the kept wide shot before it, and stayed a wide shot.
  // A cut's frame is the first frame of the new camera set-up.
  const changes = (await sceneChanges(ws.abs(shot.sourcePath), { signal })).filter((c) => c.kind === 'cut');
  const startsAtCut = range.start > 0 && changes.some((c) => c.frame === range.start);
  const endsAtCut = range.end < shot.frameCount - 1 && changes.some((c) => c.frame === range.end + 1);
  const cuts = changes.filter((c) => c.frame > range.start && c.frame <= range.end).map((c) => c.frame);
  // A cut in the first or last few frames makes the part mostly another set-up than the kept frame beside it.
  const near = Math.max(3, Math.round(frames * 0.15));
  const earlyCut = cuts.some((f) => f - range.start <= near);
  const lateCut = cuts.some((f) => range.end - f < near);
  if (range.start > 0 && !startsAtCut && !earlyCut && (wanted === 'both' || wanted === 'before'))
    await kept(range.start - 1, 'right before this part — it must start out of this frame');
  if (range.end < shot.frameCount - 1 && !endsAtCut && !lateCut && (wanted === 'both' || wanted === 'after'))
    await kept(range.end + 1, 'right after this part — it must flow into this frame');
  // The part's own first, middle and last frames: the director's context, and all it gets when the part is too
  // short to send as video.
  const frameOf: Array<{ label: string; path: string }> = [];
  for (const at of [...new Set([range.start, Math.round((range.start + range.end) / 2), range.end])]) {
    const path = `${dir}/${stem}-part-f${at}.jpg`;
    await extractFrame(ws.abs(shot.sourcePath), outPath(ws, path), at, clip.fpsNum, clip.fpsDen, { signal });
    frameOf.push({ label: `frame ${at} of the shot, inside this part (the original)`, path });
  }
  return { range, video, seams, frames: frameOf, cuts, startsAtCut, endsAtCut };
}

/**
 * Puts the conformed part in place of its frames of the kept take and checks the result: the shot's frame count,
 * and the kept frames still being the kept take's own (PSNR per kept stretch, returned for the record).
 */
export async function splicePart(
  ctx: JobContext,
  {
    keepPath,
    partPath,
    outRel,
    range,
    shot,
    clip,
  }: { keepPath: string; partPath: string; outRel: string; range: FrameRange; shot: Shot; clip: Clip },
): Promise<number[]> {
  const { workspace: ws, signal } = ctx;
  const keep = ws.abs(keepPath);
  const out = outPath(ws, outRel);
  await spliceRange(
    keep,
    ws.abs(partPath),
    out,
    { ...range, frames: shot.frameCount, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen },
    { signal },
  );
  const decoded = await decodedFrames(out, { signal });
  if (decoded !== shot.frameCount)
    throw new AniError('internal', `The joined take has ${decoded} frames, the shot has ${shot.frameCount}`);
  const stretches: Array<{ from: number; count: number }> = [];
  if (range.start > 0) stretches.push({ from: 0, count: range.start });
  if (range.end < shot.frameCount - 1)
    stretches.push({ from: range.end + 1, count: shot.frameCount - 1 - range.end });
  const scores: number[] = [];
  for (const s of stretches) {
    const db = await rangePsnr(keep, out, s, { signal });
    if (db < KEPT_MIN_PSNR_DB)
      throw new AniError(
        'internal',
        `Kept frames ${s.from}–${s.from + s.count - 1} changed when joined (PSNR ${db.toFixed(1)} dB)`,
      );
    scores.push(Number.isFinite(db) ? Number(db.toFixed(1)) : 99);
  }
  return scores;
}

/**
 * `take.merge`: one take from a base and partial takes made from it side by side — each part's frames from its
 * take, the rest from the base — checked frame for frame against where each stretch came from.
 */
export const mergeTakeHandler: JobHandler = async (ctx) => {
  const { workspace: ws, signal, job, progress } = ctx;
  const { takeId } = job.payload as { takeId: string };
  const take = getTake(ws.db, takeId);
  const shot = getShot(ws.db, take.shotId);
  const project = projectOfShot(ws.db, shot.id);
  const clip = findActiveClip(ws.db, project.id);
  try {
    if (!clip || !shot.sourcePath) throw new AniError('conflict', 'Shot or clip is not ready');
    const base = getTake(ws.db, take.params.keepFrom as string);
    const merged = take.params.merged as Array<{ from: string; range: FrameRange }>;
    if (!base.path) throw new AniError('conflict', 'The base take has no video');
    updateTake(ws.db, takeId, { status: 'generating', framesIn: shot.frameCount }, 'daemon');
    const cache = projectCacheDir(project);
    const stem = takeFileStem(take.version);
    const outRel = `${shotDir(project, shot.id)}/takes/${stem}.mp4`;
    const fps = { fpsNum: clip.fpsNum, fpsDen: clip.fpsDen };
    let current = ws.abs(base.path);
    for (const [i, m] of merged.entries()) {
      progress(0.1 + (0.6 * i) / merged.length, `joining frames ${m.range.start}–${m.range.end}`);
      const part = getTake(ws.db, m.from);
      if (!part.path) throw new AniError('conflict', `Take v${part.version} has no video`);
      const out =
        i === merged.length - 1 ? outPath(ws, outRel) : outPath(ws, `${cache}/takes/${take.id}-join${i}.mp4`);
      await spliceRange(
        current,
        ws.abs(part.path),
        out,
        { ...m.range, frames: shot.frameCount, ...fps, partStart: m.range.start },
        { signal },
      );
      current = out;
    }
    const out = ws.abs(outRel);
    const decoded = await decodedFrames(out, { signal });
    if (decoded !== shot.frameCount)
      throw new AniError(
        'internal',
        `The joined take has ${decoded} frames, the shot has ${shot.frameCount}`,
      );
    // Every stretch must still be its source's own frames.
    progress(0.75, 'checking every stretch');
    const stretches: Array<{ path: string; from: number; count: number }> = [];
    let at = 0;
    for (const m of merged) {
      if (m.range.start > at) stretches.push({ path: base.path, from: at, count: m.range.start - at });
      stretches.push({
        path: getTake(ws.db, m.from).path!,
        from: m.range.start,
        count: m.range.end - m.range.start + 1,
      });
      at = m.range.end + 1;
    }
    if (at < shot.frameCount) stretches.push({ path: base.path, from: at, count: shot.frameCount - at });
    const psnrDb: number[] = [];
    for (const s of stretches) {
      const db = await rangePsnr(ws.abs(s.path), out, s, { signal });
      if (db < KEPT_MIN_PSNR_DB)
        throw new AniError(
          'internal',
          `Frames ${s.from}–${s.from + s.count - 1} changed when joined (${db.toFixed(1)} dB)`,
        );
      psnrDb.push(Number.isFinite(db) ? Number(db.toFixed(1)) : 99);
    }
    progress(0.85, 'building review compare');
    const compareRel = `${cache}/takes/${shot.id}-${stem}.compare.mp4`;
    await stackCompare(
      ws.abs(shot.sourcePath),
      out,
      outPath(ws, compareRel),
      { layout: 'v', height: TIER_SIZE[take.tier].height, crf: 16 },
      { signal },
    );
    for (const [i] of merged.entries())
      if (i < merged.length - 1) rmSync(ws.abs(`${cache}/takes/${take.id}-join${i}.mp4`), { force: true });
    const updated = updateTake(
      ws.db,
      takeId,
      {
        status: 'ready',
        path: outRel,
        costUsd: 0,
        remote: { comparePath: compareRel },
        framesOut: shot.frameCount,
        conform: { merged, base: base.id, psnrDb },
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
