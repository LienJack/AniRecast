import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProject,
  createSource,
  initWorkspace,
  listSources,
  sourceCacheDir,
  sourceDir,
  trashSource,
  updateSource,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('trashing a source', () => {
  it('moves its folder to trash, drops the cache and hides it, but not while a project uses it', () => {
    const ws = initWorkspace(path.join(tempDir(), 'ws'));
    const used = createSource(ws.db, { title: 'used' }, 'user');
    updateSource(ws.db, used.id, { status: 'ready' }, 'daemon');
    createProject(ws.db, { name: 'OP', sourceId: used.id }, 'user');
    expect(() => trashSource(ws, used.id, 'user')).toThrow(/used by: OP/);

    const spare = createSource(ws.db, { title: 'spare', url: 'https://example.com/v' }, 'user');
    mkdirSync(ws.abs(sourceDir(spare.id)), { recursive: true });
    writeFileSync(ws.abs(`${sourceDir(spare.id)}/source.mp4`), 'video');
    mkdirSync(ws.abs(sourceCacheDir(spare.id)), { recursive: true });
    updateSource(
      ws.db,
      spare.id,
      { status: 'ready', filePath: `${sourceDir(spare.id)}/source.mp4` },
      'daemon',
    );

    expect(trashSource(ws, spare.id, 'user')).toMatchObject({ status: 'trashed', filePath: null });
    expect(existsSync(ws.abs(`trash/sources/${spare.id}/source.mp4`))).toBe(true);
    expect(existsSync(ws.abs(sourceDir(spare.id)))).toBe(false);
    expect(existsSync(ws.abs(sourceCacheDir(spare.id)))).toBe(false);
    expect(listSources(ws.db).map((s) => s.id)).toEqual([used.id]);
    // The same URL can be added again once its old entry is trashed.
    expect(createSource(ws.db, { title: 'again', url: 'https://example.com/v' }, 'user').status).toBe(
      'pending',
    );
    ws.close();
  });
});
