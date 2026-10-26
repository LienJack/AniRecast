import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import {
  assertWithinBudget,
  type FrameRange,
  findActiveClip,
  framesBrief,
  getShot,
  getTake,
  projectCacheDir,
  projectOfShot,
  recordCost,
  shotDir,
  takeFileStem,
  updateTake,
} from '@anirecast/core';
import { ffmpeg, rangePsnr, stackCompare } from '@anirecast/media';
import { estimateImageCost, mimeFor, TIER_SIZE } from '@anirecast/providers';
import { AniError, imageModelSpec, toEnvelopeError } from '@anirecast/shared';
import type { JobHandler } from '../runner.ts';
import { metered } from './metered.ts';
import { splicePart } from './take-part.ts';
import { outPath } from './util.ts';

/** Two frames this close are the same drawing held (anime is drawn on twos and threes): one edit serves both. */
const SAME_DRAWING_DB = 38;
/** Image edits running at once inside the job. */
const AT_ONCE = 3;

const pad = (n: number) => String(n).padStart(4, '0');

/**
 * `take.frames` (逐格重繪): every drawing of the part redrawn by the image model with the people replaced, assembled
 * at the shot's frame rate and put in place of those frames of the kept take. A refused frame falls back to the
 * previous drawing's edit, else the original frame, and is listed.
 */
export const takeFramesHandler: JobHandler = async (ctx) => {
  const { workspace: ws, services, signal, job, progress } = ctx;
  const { takeId } = job.payload as { takeId: string };
  const take = getTake(ws.db, takeId);
  const shot = getShot(ws.db, take.shotId);
  const project = projectOfShot(ws.db, shot.id);
  const clip = findActiveClip(ws.db, project.id);
  try {
    const range = take.params.range as FrameRange;
    const keep = getTake(ws.db, take.params.keepFrom as string);
    const model = take.params.imageModel as string;
    const extra = (take.params.extra as string | undefined) ?? null;
    if (!clip || !shot.sourcePath || !keep.path)
      throw new AniError('conflict', 'Shot, clip or kept take is not ready');
    const count = range.end - range.start + 1;
    updateTake(ws.db, takeId, { status: 'generating', framesIn: count }, 'daemon');
    const dir = `${projectCacheDir(project)}/takes/${take.id}-frames`;
    rmSync(ws.abs(dir), { recursive: true, force: true });
    mkdirSync(ws.abs(dir), { recursive: true });

    progress(0.03, 'extracting the frames');
    await ffmpeg(
      [
        '-i',
        ws.abs(shot.sourcePath),
        '-vf',
        `select='between(n\\,${range.start}\\,${range.end})'`,
        '-fps_mode',
        'passthrough',
        ws.abs(`${dir}/src-%04d.png`),
      ],
      { signal },
    );
    const src = (i: number) => ws.abs(`${dir}/src-${pad(i + 1)}.png`);

    // Which frames start a new drawing.
    const drawingOf: number[] = [0];
    for (let i = 1; i < count; i++) {
      const db = await rangePsnr(src(i - 1), src(i), { from: 0, count: 1 }, { signal });
      drawingOf.push(db >= SAME_DRAWING_DB ? drawingOf[i - 1]! : i);
    }
    const drawings = [...new Set(drawingOf)];

    const spec = imageModelSpec(model);
    const brief = framesBrief(ws, shot.id, range, spec.maxRefs);
    const refs = brief.refs.map((r) => ({ path: ws.abs(r.path), mimeType: mimeFor(r.path) }));
    const prompt = (frame: number) =>
      [
        `Image 1 is frame ${frame} of shot ${shot.orderIndex + 1} of an anime opening. Redraw Image 1 with the people below replaced and NOTHING else changed.`,
        ...brief.lines,
        'Keep exactly: the composition, framing and crop; every graphic element (strips, black bars, colour panels, colour bars, glitch lines, flowers, props, weapons, text and signs); the motion blur, focus blur and chromatic aberration; the light and the colours. Only the replaced people change — face, hair, eyes, skin and clothing. Where only a hand, the lips or a lock of hair of someone shows, change just that to match the new character. If nobody to replace is in view, return Image 1 unchanged.',
        'No new text, labels or watermarks. Same size and aspect as Image 1.',
        ...(extra ? [`Additional instructions: ${extra}`] : []),
      ].join('\n');

    const edited = new Map<number, string>();
    const fallbacks: Array<{ frame: number; reason: string }> = [];
    let usd = 0;
    let done = 0;
    const queue = [...drawings];
    const worker = async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        const frame = range.start + i;
        if (services.provider.name !== 'fake')
          assertWithinBudget(
            ws.db,
            services.config.budget.capUsd,
            estimateImageCost(model, '1K', refs.length + 1),
          );
        try {
          // A dropped connection is retried here (twice, with a pause): one bad frame must not fail the part.
          const call = () =>
            metered(ctx, { model, kind: 'image', shotId: shot.id }, () =>
              services.provider.generateImage({
                model,
                prompt: prompt(frame),
                images: [{ path: src(i), mimeType: 'image/png' }, ...refs],
                aspectRatio: '16:9',
                imageSize: '1K',
                signal,
              }),
            );
          let result: Awaited<ReturnType<typeof call>> | undefined;
          for (let attempt = 0; !result; attempt++) {
            try {
              result = await call();
            } catch (error) {
              if (signal.aborted || toEnvelopeError(error).code !== 'transient' || attempt >= 2) throw error;
              await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
            }
          }
          recordCost(ws.db, {
            jobId: job.id,
            projectId: project.id,
            provider: result.provider,
            model,
            tier: take.tier,
            usage: result.usage,
            usd: result.provider === 'fake' ? 0 : result.costUsd,
          });
          usd += result.provider === 'fake' ? 0 : result.costUsd;
          const out = ws.abs(`${dir}/edit-${pad(i + 1)}.${result.mimeType === 'image/png' ? 'png' : 'jpg'}`);
          await writeFile(out, result.data);
          edited.set(i, out);
        } catch (error) {
          if (signal.aborted) throw error;
          const e = toEnvelopeError(error);
          if (e.code !== 'provider_rejected') throw error;
          fallbacks.push({ frame, reason: e.message });
        }
        done++;
        progress(0.08 + (0.72 * done) / drawings.length, `redrawn ${done}/${drawings.length} drawings`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, drawings.length) }, worker));

    // Each frame shows its drawing's edit; a refused drawing borrows the previous edit, else stays the original.
    progress(0.82, 'assembling the part');
    const size = TIER_SIZE[take.tier];
    let last: string | null = null;
    for (let i = 0; i < count; i++) {
      const d = drawingOf[i]!;
      const pick = edited.get(d) ?? last ?? src(i);
      if (edited.has(d)) last = edited.get(d)!;
      await ffmpeg(
        [
          '-i',
          pick,
          '-vf',
          `scale=${size.width}:${size.height}:flags=lanczos,setsar=1`,
          ws.abs(`${dir}/seq-${pad(i + 1)}.png`),
        ],
        { signal },
      );
    }
    const partRel = `${dir}/part.mp4`;
    await ffmpeg(
      [
        '-framerate',
        `${clip.fpsNum}/${clip.fpsDen}`,
        '-i',
        ws.abs(`${dir}/seq-%04d.png`),
        '-frames:v',
        String(count),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '14',
        '-pix_fmt',
        'yuv420p',
        ws.abs(partRel),
      ],
      { signal },
    );

    progress(0.88, 'putting the part into the kept take');
    const stem = takeFileStem(take.version);
    const outRel = `${shotDir(project, shot.id)}/takes/${stem}.mp4`;
    const psnrDb = await splicePart(ctx, {
      keepPath: keep.path,
      partPath: partRel,
      outRel,
      range,
      shot,
      clip,
    });
    const compareRel = `${projectCacheDir(project)}/takes/${shot.id}-${stem}.compare.mp4`;
    await stackCompare(
      ws.abs(shot.sourcePath),
      ws.abs(outRel),
      outPath(ws, compareRel),
      { layout: 'v', height: size.height, crf: 16 },
      { signal },
    );
    // Keep the edits for the record; the frame sequences are rebuilt from them.
    for (let i = 0; i < count; i++) rmSync(ws.abs(`${dir}/seq-${pad(i + 1)}.png`), { force: true });
    copyFileSync(ws.abs(partRel), ws.abs(`${dir}/part-kept.mp4`));
    const updated = updateTake(
      ws.db,
      takeId,
      {
        status: 'ready',
        path: outRel,
        costUsd: usd,
        remote: { comparePath: compareRel },
        framesOut: count,
        conform: {
          range,
          kept: { from: keep.id, psnrDb },
          frames: { drawings: drawings.length, edited: edited.size, fallbacks },
        },
        error: null,
      },
      'daemon',
    );
    return { result: { take: updated }, costUsd: usd };
  } catch (error) {
    if (!signal.aborted)
      updateTake(ws.db, takeId, { status: 'failed', error: toEnvelopeError(error).message }, 'daemon');
    throw error;
  }
};
