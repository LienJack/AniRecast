import type { Clip, FrameRange, Shot } from '@anirecast/core';
import {
  decodedFrames,
  extractFrame,
  extractVideoSegment,
  rangePsnr,
  sceneChanges,
  spliceRange,
} from '@anirecast/media';
import { AniError } from '@anirecast/shared';
import type { JobContext } from '../runner.ts';
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
  }: { shot: Shot; clip: Clip; range: FrameRange; keepPath: string; dir: string; stem: string },
): Promise<{
  range: FrameRange;
  video: string;
  seams: Array<{ label: string; path: string }>;
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
  if (range.start > 0 && !startsAtCut && !earlyCut)
    await kept(range.start - 1, 'right before this part — it must start out of this frame');
  if (range.end < shot.frameCount - 1 && !endsAtCut && !lateCut)
    await kept(range.end + 1, 'right after this part — it must flow into this frame');
  return { range, video, seams, cuts, startsAtCut, endsAtCut };
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
