import { copyFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSource, sourceCacheDir, sourceDir, updateSource } from '@anirecast/core';
import { exec, extractFrame, makeProxy, probe } from '@anirecast/media';
import { AniError } from '@anirecast/shared';
import type { JobContext, JobHandler, JobOutcome } from '../runner.ts';
import { outPath, span } from './util.ts';

const VIDEO_EXT = /^\.(mp4|mkv|webm|mov|m4v|avi|ts|flv)$/;

/** Probe + thumbnail + browser proxy, shared by import and download. */
async function finalizeSource(
  ctx: JobContext,
  sourceId: string,
  fileRel: string,
  extra: Record<string, unknown> = {},
): Promise<JobOutcome> {
  const { workspace: ws, signal, progress } = ctx;
  progress(0.6, 'probing');
  const p = await probe(ws.abs(fileRel), { signal });
  const cache = sourceCacheDir(sourceId);
  const thumbRel = `${cache}/thumb.jpg`;
  await extractFrame(
    ws.abs(fileRel),
    outPath(ws, thumbRel),
    Math.floor(p.frameCount * 0.1),
    p.fpsNum,
    p.fpsDen,
    { maxWidth: 480, signal },
  );
  progress(0.65, 'building browser proxy');
  await makeProxy(ws.abs(fileRel), outPath(ws, `${cache}/proxy.mp4`), {
    height: 720,
    signal,
    totalFrames: p.frameCount,
    onProgress: span(progress, 0.65, 0.99, 'building browser proxy'),
  });
  const source = updateSource(
    ws.db,
    sourceId,
    {
      ...extra,
      filePath: fileRel,
      thumbPath: thumbRel,
      durationMs: p.durationMs,
      width: p.width,
      height: p.height,
      fpsNum: p.fpsNum,
      fpsDen: p.fpsDen,
      status: 'ready',
      error: null,
    },
    'daemon',
  );
  return { result: { source, probe: p } };
}

async function failSource(ctx: JobContext, sourceId: string, error: unknown): Promise<never> {
  if (!ctx.signal.aborted) {
    const message = error instanceof Error ? error.message : String(error);
    updateSource(ctx.workspace.db, sourceId, { status: 'failed', error: message }, 'daemon');
  }
  throw error;
}

export const importSourceHandler: JobHandler = async (ctx) => {
  const { sourceId, file } = ctx.job.payload as { sourceId: string; file: string };
  try {
    const ext = path.extname(file).toLowerCase();
    if (!VIDEO_EXT.test(ext)) throw new AniError('usage', `Unsupported video file type: ${ext || '(none)'}`);
    const rel = `${sourceDir(sourceId)}/source${ext}`;
    ctx.progress(0.05, 'copying');
    await copyFile(file, outPath(ctx.workspace, rel));
    return await finalizeSource(ctx, sourceId, rel);
  } catch (error) {
    return failSource(ctx, sourceId, error);
  }
};

interface YtInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  extractor_key?: string;
  webpage_url?: string;
}

export const downloadSourceHandler: JobHandler = async (ctx) => {
  const { sourceId, url } = ctx.job.payload as { sourceId: string; url: string };
  const { workspace: ws, signal, progress } = ctx;
  try {
    updateSource(ws.db, sourceId, { status: 'downloading' }, 'daemon');
    const dirRel = sourceDir(sourceId);
    const dirAbs = path.dirname(outPath(ws, `${dirRel}/x`));
    await exec(
      'yt-dlp',
      [
        '--newline',
        '--no-playlist',
        '--no-mtime',
        '-f',
        'bv*+ba/b',
        '-S',
        'res,fps,ext:mp4:m4a',
        '--merge-output-format',
        'mp4',
        '--write-info-json',
        '-o',
        path.join(dirAbs, 'source.%(ext)s'),
        '-o',
        `infojson:${path.join(dirAbs, 'info')}`,
        '--progress-template',
        'download:[anirecast] %(progress._percent_str)s',
        url,
      ],
      {
        signal,
        onStdoutLine: (line) => {
          const m = /\[anirecast\]\s+([\d.]+)%/.exec(line);
          if (m) progress((Number(m[1]) / 100) * 0.55, 'downloading');
        },
      },
    );
    const files = await readdir(dirAbs);
    const video = files.find((f) => f.startsWith('source.') && VIDEO_EXT.test(path.extname(f).toLowerCase()));
    if (!video)
      throw new AniError('internal', 'yt-dlp finished but no video file was found', { details: { files } });
    const infoFile = files.find((f) => f.startsWith('info') && f.endsWith('.json'));
    const info: YtInfo = infoFile ? JSON.parse(await readFile(path.join(dirAbs, infoFile), 'utf8')) : {};
    return await finalizeSource(ctx, sourceId, `${dirRel}/${video}`, {
      title: info.title ?? getSource(ws.db, sourceId).title,
      uploader: info.uploader ?? info.channel ?? null,
      site: info.extractor_key ?? null,
      infoPath: infoFile ? `${dirRel}/${infoFile}` : null,
    });
  } catch (error) {
    return failSource(ctx, sourceId, error);
  }
};
