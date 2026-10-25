import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Workspace } from '@anirecast/core';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** Serves a workspace-relative file with HTTP Range support so videos can seek and frame-step. */
export function serveWorkspaceFile(c: Context, ws: Workspace, rel: string): Response {
  let abs: string;
  try {
    abs = ws.abs(decodeURIComponent(rel));
  } catch {
    return c.json({ ok: false, error: { code: 'naming_violation', message: 'Bad path' } }, 400);
  }
  let size: number;
  let mtime: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    return c.json({ ok: false, error: { code: 'not_found', message: `No such file: ${rel}` } }, 404);
  }
  const etag = `"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`;
  const headers: Record<string, string> = {
    'Content-Type': TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  if (range) {
    let start = range[1] ? Number(range[1]) : Number.NaN;
    let end = range[2] ? Number(range[2]) : size - 1;
    if (Number.isNaN(start)) {
      start = Math.max(0, size - end);
      end = size - 1;
    }
    if (start >= size || end < start)
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    end = Math.min(end, size - 1);
    const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}
