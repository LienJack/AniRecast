import {
  enqueueJob,
  getClip,
  getProject,
  getShot,
  getSource,
  listShots,
  projectOfShot,
  replaceShots,
  sampleFrames,
  setClipStatus,
  setKeyframes,
  shotDir,
  updateShot,
} from '@anirecast/core';
import {
  extractAudioSegment,
  extractFrame,
  extractVideoSegment,
  ffmpeg,
  makeProxy,
  probe,
  runSidecar,
} from '@anirecast/media';
import { AniError } from '@anirecast/shared';
import type { JobContext, JobHandler } from '../runner.ts';
import { outPath, span } from './util.ts';

/** Cuts the frame-accurate CFR master, its audio and a proxy, then queues shot detection. */
export const extractClipHandler: JobHandler = async (ctx) => {
  const { workspace: ws, signal, progress, job } = ctx;
  const { clipId } = job.payload as { clipId: string };
  const clip = getClip(ws.db, clipId);
  try {
    setClipStatus(ws.db, clipId, 'processing', 'daemon');
    const project = getProject(ws.db, clip.projectId);
    const source = getSource(ws.db, project.sourceId);
    if (!source.filePath || !clip.filePath || !clip.audioPath || !clip.proxyPath)
      throw new AniError('internal', 'Clip paths missing');
    const seg = {
      startFrame: clip.inFrame,
      frameCount: clip.frameCount,
      fpsNum: clip.fpsNum,
      fpsDen: clip.fpsDen,
    };
    const sourceAbs = ws.abs(source.filePath);
    await extractVideoSegment(sourceAbs, outPath(ws, clip.filePath), seg, {
      crf: 14,
      keyint: 12,
      signal,
      onProgress: span(progress, 0, 0.6, 'cutting master'),
    });
    const audioAbs = outPath(ws, clip.audioPath);
    if ((await probe(sourceAbs, { signal })).hasAudio) {
      await extractAudioSegment(sourceAbs, audioAbs, seg, { signal });
    } else {
      const seconds = (clip.frameCount * clip.fpsDen) / clip.fpsNum;
      await ffmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          `anullsrc=r=48000:cl=stereo`,
          '-t',
          seconds.toFixed(6),
          '-c:a',
          'pcm_s16le',
          audioAbs,
        ],
        { signal },
      );
    }
    const check = await probe(ws.abs(clip.filePath), { countFrames: true, signal });
    if (check.frameCount !== clip.frameCount) {
      throw new AniError('internal', `Clip has ${check.frameCount} frames, expected ${clip.frameCount}`);
    }
    progress(0.65, 'building proxy');
    await makeProxy(ws.abs(clip.filePath), outPath(ws, clip.proxyPath), {
      audio: audioAbs,
      signal,
      totalFrames: clip.frameCount,
      onProgress: span(progress, 0.65, 0.99, 'building proxy'),
    });
    setClipStatus(ws.db, clipId, 'ready', 'daemon');
    const detect = enqueueJob(ws.db, {
      type: 'shots.detect',
      lane: 'media',
      projectId: clip.projectId,
      payload: { clipId },
      requestedBy: job.requestedBy,
    });
    return { result: { clipId, frameCount: clip.frameCount, detectJobId: detect.id } };
  } catch (error) {
    if (!signal.aborted) setClipStatus(ws.db, clipId, 'failed', 'daemon');
    throw error;
  }
};

interface DetectResult {
  frameCount: number;
  shots: Array<{ start: number; end: number }>;
}

/** Keyframes and the per-shot source segment (what gets uploaded for editing). */
export async function prepareShots(
  ctx: JobContext,
  shotIds: string[],
  from: number,
  to: number,
): Promise<void> {
  const { workspace: ws, signal, progress } = ctx;
  for (const [i, shotId] of shotIds.entries()) {
    const project = projectOfShot(ws.db, shotId);
    const shot = getShot(ws.db, shotId);
    const clip = getClip(ws.db, shot.clipId);
    if (!clip.filePath) throw new AniError('internal', 'Clip master missing');
    const clipAbs = ws.abs(clip.filePath);
    const dir = shotDir(project, shot.id);
    const frames = sampleFrames(shot, clip.fpsNum / clip.fpsDen);
    const keyframes = [];
    for (const f of frames) {
      const rel = `${dir}/frames/f${String(f.frame).padStart(6, '0')}.jpg`;
      await extractFrame(clipAbs, outPath(ws, rel), f.frame, clip.fpsNum, clip.fpsDen, { signal });
      keyframes.push({ frame: f.frame, role: f.role, path: rel });
    }
    setKeyframes(ws.db, shot.id, keyframes);
    const sourceRel = `${dir}/source.mp4`;
    await extractVideoSegment(
      clipAbs,
      outPath(ws, sourceRel),
      { startFrame: shot.startFrame, frameCount: shot.frameCount, fpsNum: clip.fpsNum, fpsDen: clip.fpsDen },
      { crf: 16, signal },
    );
    updateShot(ws.db, shot.id, { sourcePath: sourceRel, status: 'prepared' }, 'daemon');
    progress(from + ((to - from) * (i + 1)) / shotIds.length, `prepared shot ${i + 1}/${shotIds.length}`);
  }
}

export const detectShotsHandler: JobHandler = async (ctx) => {
  const { workspace: ws, signal, progress, job } = ctx;
  const opts = job.payload as { clipId: string; detector?: string; threshold?: number; minSceneLen?: number };
  const clip = getClip(ws.db, opts.clipId);
  if (clip.status !== 'ready' || !clip.filePath)
    throw new AniError('conflict', `Clip is not ready (${clip.status})`);
  progress(0.02, 'detecting cuts');
  const args = ['--video', ws.abs(clip.filePath)];
  if (opts.detector) args.push('--detector', opts.detector);
  if (opts.threshold !== undefined) args.push('--threshold', String(opts.threshold));
  if (opts.minSceneLen !== undefined) args.push('--min-scene-len', String(opts.minSceneLen));
  const detected = await runSidecar<DetectResult>('detect-shots', args, { signal });
  const ranges = detected.shots
    .filter((s) => s.start < clip.frameCount)
    .map((s) => ({ start: s.start, end: Math.min(s.end, clip.frameCount - 1) }));
  const last = ranges.at(-1);
  if (last && last.end < clip.frameCount - 1) last.end = clip.frameCount - 1;
  const shots = replaceShots(ws.db, clip.id, ranges, 'daemon');
  progress(0.3, `${shots.length} shots`);
  const result = { clipId: clip.id, shots: shots.length, cuts: ranges.slice(1).map((r) => r.start) };
  // Judge the cuts first, so nothing is prepared or analyzed for shots that are about to merge.
  if (ctx.services.config.continuity.enabled) {
    const continuity = enqueueJob(ws.db, {
      type: 'shots.continuity',
      lane: 'generate',
      projectId: clip.projectId,
      payload: { clipId: clip.id, apply: true, review: true, chain: true },
      requestedBy: job.requestedBy,
    });
    return { result: { ...result, continuityJobId: continuity.id } };
  }
  return { result: { ...result, ...(await continueAfterShots(ctx, clip.id, 0.3)) } };
};

/**
 * The rest of the pipeline once the shot list is settled: prepare every shot, then (with autoAnalyze) queue
 * the Flash pass for overlaid text and descriptions, and same-person identification.
 */
export async function continueAfterShots(
  ctx: JobContext,
  clipId: string,
  from: number,
): Promise<{ analyzeJobId?: string; identifyJobId?: string }> {
  const { workspace: ws, job } = ctx;
  const clip = getClip(ws.db, clipId);
  await prepareShots(
    ctx,
    listShots(ws.db, clipId).map((s) => s.id),
    from,
    1,
  );
  if (!ctx.services.config.pipeline.autoAnalyze) return {};
  const analyze = enqueueJob(ws.db, {
    type: 'shots.analyze',
    lane: 'generate',
    projectId: clip.projectId,
    payload: { projectId: clip.projectId },
    requestedBy: job.requestedBy,
  });
  const identify = enqueueJob(ws.db, {
    type: 'cast.identify',
    lane: 'media',
    projectId: clip.projectId,
    payload: { projectId: clip.projectId, redetect: true },
    requestedBy: job.requestedBy,
  });
  return { analyzeJobId: analyze.id, identifyJobId: identify.id };
}

/** Rebuilds keyframes and source segments after split/merge or a representative-frame change. */
export const prepareShotsHandler: JobHandler = async (ctx) => {
  const { shotIds } = ctx.job.payload as { shotIds: string[] };
  await prepareShots(ctx, shotIds, 0, 1);
  return { result: { prepared: shotIds.length } };
};
