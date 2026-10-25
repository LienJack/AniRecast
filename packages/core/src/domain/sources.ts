import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AniError, newId } from '@anirecast/shared';
import { all, type Db, one, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { Workspace } from '../workspace.ts';

export type SourceStatus = 'pending' | 'downloading' | 'ready' | 'failed' | 'trashed';

export interface Source {
  id: string;
  url: string | null;
  site: string | null;
  title: string;
  uploader: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fpsNum: number | null;
  fpsDen: number | null;
  filePath: string | null;
  infoPath: string | null;
  thumbPath: string | null;
  status: SourceStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SourceRow {
  id: string;
  url: string | null;
  site: string | null;
  title: string;
  uploader: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps_num: number | null;
  fps_den: number | null;
  file_path: string | null;
  info_path: string | null;
  thumb_path: string | null;
  status: SourceStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const toSource = (r: SourceRow): Source => ({
  id: r.id,
  url: r.url,
  site: r.site,
  title: r.title,
  uploader: r.uploader,
  durationMs: r.duration_ms,
  width: r.width,
  height: r.height,
  fpsNum: r.fps_num,
  fpsDen: r.fps_den,
  filePath: r.file_path,
  infoPath: r.info_path,
  thumbPath: r.thumb_path,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Folder for a source's original file and metadata. */
export const sourceDir = (id: string): string => `sources/${id}`;
/** Regenerable browser proxy and thumbnail. */
export const sourceCacheDir = (id: string): string => `cache/sources/${id}`;

export function getSource(db: Db, id: string): Source {
  const row = one<SourceRow>(db, 'SELECT * FROM sources WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Source not found: ${id}`);
  return toSource(row);
}

export function findSourceByUrl(db: Db, url: string): Source | undefined {
  const row = one<SourceRow>(db, `SELECT * FROM sources WHERE url = :url AND status != 'trashed'`, { url });
  return row && toSource(row);
}

export function listSources(db: Db, { includeTrashed = false } = {}): Source[] {
  return all<SourceRow>(
    db,
    `SELECT * FROM sources ${includeTrashed ? '' : `WHERE status != 'trashed'`} ORDER BY created_at DESC`,
  ).map(toSource);
}

export function createSource(
  db: Db,
  input: { url?: string | null; site?: string | null; title: string; status?: SourceStatus },
  actor: string,
  now: number = Date.now(),
): Source {
  return tx(db, () => {
    if (input.url) {
      const existing = findSourceByUrl(db, input.url);
      if (existing) {
        throw new AniError('conflict', `This URL is already in the library: ${existing.title}`, {
          details: { source: existing },
        });
      }
    }
    const id = newId('src', now);
    run(
      db,
      `INSERT INTO sources (id, url, site, title, status, created_at, updated_at)
       VALUES (:id, :url, :site, :title, :status, :now, :now)`,
      {
        id,
        url: input.url ?? null,
        site: input.site ?? null,
        title: input.title,
        status: input.status ?? 'pending',
        now,
      },
    );
    const source = getSource(db, id);
    appendEvent(db, {
      actor,
      kind: 'source.created',
      entityType: 'source',
      entityId: id,
      payload: { title: source.title },
    });
    return source;
  });
}

export type SourcePatch = Partial<Omit<Source, 'id' | 'createdAt' | 'updatedAt'>>;

const SOURCE_COLUMNS: Record<keyof SourcePatch, string> = {
  url: 'url',
  site: 'site',
  title: 'title',
  uploader: 'uploader',
  durationMs: 'duration_ms',
  width: 'width',
  height: 'height',
  fpsNum: 'fps_num',
  fpsDen: 'fps_den',
  filePath: 'file_path',
  infoPath: 'info_path',
  thumbPath: 'thumb_path',
  status: 'status',
  error: 'error',
};

export function updateSource(
  db: Db,
  id: string,
  patch: SourcePatch,
  actor: string,
  now: number = Date.now(),
): Source {
  return tx(db, () => {
    const sets: string[] = ['updated_at = :now'];
    const params: Record<string, string | number | null> = { id, now };
    for (const [key, value] of Object.entries(patch) as [keyof SourcePatch, unknown][]) {
      sets.push(`${SOURCE_COLUMNS[key]} = :${key}`);
      params[key] = (value ?? null) as string | number | null;
    }
    run(db, `UPDATE sources SET ${sets.join(', ')} WHERE id = :id`, params);
    const source = getSource(db, id);
    appendEvent(db, {
      actor,
      kind: 'source.updated',
      entityType: 'source',
      entityId: id,
      payload: { status: source.status, fields: Object.keys(patch) },
    });
    return source;
  });
}

/**
 * Takes a source out of the collection. Its folder moves to `trash/sources/<id>` (recoverable by moving it
 * back), the regenerable proxy and thumbnail are deleted, and the record stays as trashed. Refused while an
 * active project uses it or its download or import is still running.
 */
export function trashSource(ws: Workspace, id: string, actor: string, now: number = Date.now()): Source {
  const source = getSource(ws.db, id);
  if (source.status === 'trashed') return source;
  const users = all<{ name: string }>(
    ws.db,
    `SELECT name FROM projects WHERE source_id = :id AND status = 'active'`,
    { id },
  );
  if (users.length > 0)
    throw new AniError('conflict', `Source is used by: ${users.map((u) => u.name).join(', ')}`, {
      hint: 'Archive those projects first.',
    });
  const busy = one<{ n: number }>(
    ws.db,
    `SELECT COUNT(*) AS n FROM jobs WHERE type IN ('source.download', 'source.import')
       AND status IN ('queued', 'running') AND json_extract(payload_json, '$.sourceId') = :id`,
    { id },
  );
  if ((busy?.n ?? 0) > 0)
    throw new AniError('conflict', 'This source is still downloading or importing', {
      hint: 'Cancel its job first (anirecast jobs cancel <job>).',
    });
  const folder = ws.abs(sourceDir(id));
  const trashRel = `trash/sources/${id}`;
  let trashed: string | null = null;
  if (existsSync(folder)) {
    if (existsSync(ws.abs(trashRel))) throw new AniError('conflict', `${trashRel} already exists`);
    mkdirSync(path.dirname(ws.abs(trashRel)), { recursive: true });
    renameSync(folder, ws.abs(trashRel));
    trashed = trashRel;
  }
  rmSync(ws.abs(sourceCacheDir(id)), { recursive: true, force: true });
  return tx(ws.db, () => {
    const updated = updateSource(
      ws.db,
      id,
      { status: 'trashed', filePath: null, infoPath: null, thumbPath: null },
      actor,
      now,
    );
    appendEvent(ws.db, {
      actor,
      kind: 'source.trashed',
      entityType: 'source',
      entityId: id,
      payload: { title: source.title, movedTo: trashed },
    });
    return updated;
  });
}
