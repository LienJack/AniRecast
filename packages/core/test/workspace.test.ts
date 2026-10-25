import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_FILE,
  initWorkspace,
  inspectWorkspace,
  LATEST_SCHEMA_VERSION,
  MANIFEST_FILE,
  openDb,
  openWorkspace,
  schemaVersion,
  WORKSPACE_DIRS,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('workspace', () => {
  it('initializes the folder layout, manifest, AGENTS.md and a migrated database', () => {
    const root = path.join(tempDir(), 'mediaHub');
    const ws = initWorkspace(root, { name: 'Media Hub' });
    try {
      for (const d of WORKSPACE_DIRS) expect(existsSync(path.join(root, d))).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
      expect(manifest).toMatchObject({ format: 'anirecast-workspace', formatVersion: 1, name: 'Media Hub' });
      expect(readFileSync(path.join(root, AGENTS_FILE), 'utf8')).toContain('anirecast');
      expect(schemaVersion(ws.db)).toBe(LATEST_SCHEMA_VERSION);
      expect(ws.rel(ws.abs('projects/a/b.mp4'))).toBe('projects/a/b.mp4');
      expect(() => ws.abs('../outside')).toThrow(/escapes/);
    } finally {
      ws.close();
    }
    expect(inspectWorkspace(root)).toMatchObject({ valid: true, problems: [] });
  });

  it('refuses to initialize a non-empty folder', () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(() => initWorkspace(root)).toThrow(/not empty/);
  });

  it('reports a non-workspace folder without modifying it', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'sources'));
    const result = inspectWorkspace(root);
    expect(result.valid).toBe(false);
    expect(result.problems[0]).toMatch(/Not an AniRecast workspace/);
    expect(existsSync(path.join(root, MANIFEST_FILE))).toBe(false);
    expect(() => openWorkspace(root, { role: 'cli' })).toThrow(/Not an AniRecast workspace/);
  });

  it('lets the CLI open a current workspace but refuses a newer schema', () => {
    const root = tempDir();
    initWorkspace(root).close();
    openWorkspace(root, { role: 'cli' }).close();
    const db = openDb(path.join(root, 'anirecast.db'));
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openWorkspace(root, { role: 'cli' })).toThrow(/newer than this AniRecast/);
    expect(() => openWorkspace(root, { role: 'daemon' })).toThrow(/newer than this AniRecast/);
  });
});
