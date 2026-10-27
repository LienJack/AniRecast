import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError, ulid } from '@anirecast/shared';
import { workspaceAgentsMd, workspaceClaudeMd } from './agents-md.ts';
import { type Db, openDb, run } from './db.ts';
import { appendEvent } from './events.ts';
import { assertCurrentSchema, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from './migrations.ts';
import { resolveIn, toRelative } from './paths.ts';

export const MANIFEST_FILE = 'anirecast.workspace.json';
export const DB_FILE = 'anirecast.db';
export const AGENTS_FILE = 'AGENTS.md';
export const CLAUDE_FILE = 'CLAUDE.md';
export const WORKSPACE_FORMAT = 'anirecast-workspace';
export const WORKSPACE_FORMAT_VERSION = 1;
export const APP_VERSION = '0.1.0';
export const WORKSPACE_DIRS = ['library/personas', 'sources', 'projects', 'cache', 'trash'] as const;

export interface Manifest {
  format: typeof WORKSPACE_FORMAT;
  formatVersion: number;
  workspaceId: string;
  name: string;
  createdAt: string;
  minAppVersion: string;
}

export class Workspace {
  readonly root: string;
  readonly manifest: Manifest;
  readonly db: Db;

  constructor(root: string, manifest: Manifest, db: Db) {
    this.root = root;
    this.manifest = manifest;
    this.db = db;
  }

  /** Absolute path for a workspace-relative POSIX path. */
  abs(rel: string): string {
    return resolveIn(this.root, rel);
  }

  /** Workspace-relative POSIX path for an absolute path inside the workspace. */
  rel(abs: string): string {
    return toRelative(this.root, abs);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

const IGNORABLE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function readManifest(root: string): Manifest {
  const file = path.join(root, MANIFEST_FILE);
  if (!existsSync(file)) {
    throw new AniError('invalid_workspace', `Not an AniRecast workspace (no ${MANIFEST_FILE}): ${root}`, {
      hint: 'Pick a folder created by `anirecast workspace init`, or create a new one.',
    });
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch (error) {
    throw new AniError('invalid_workspace', `${MANIFEST_FILE} is not valid JSON`, { cause: error });
  }
  if (manifest.format !== WORKSPACE_FORMAT || typeof manifest.workspaceId !== 'string') {
    throw new AniError('invalid_workspace', `${MANIFEST_FILE} is not an AniRecast workspace manifest`);
  }
  if (manifest.formatVersion > WORKSPACE_FORMAT_VERSION) {
    throw new AniError(
      'schema_mismatch',
      `Workspace format v${manifest.formatVersion} is newer than this AniRecast supports (v${WORKSPACE_FORMAT_VERSION})`,
      { hint: 'Update AniRecast before opening this workspace.' },
    );
  }
  return manifest;
}

export interface InspectResult {
  root: string;
  valid: boolean;
  problems: string[];
  manifest?: Manifest;
  schemaVersion?: number;
  latestSchemaVersion: number;
}

/** Read-only check used by the open dialog and `doctor`; never creates or migrates anything. */
export function inspectWorkspace(dir: string): InspectResult {
  const root = path.resolve(dir);
  const problems: string[] = [];
  const result: InspectResult = { root, valid: false, problems, latestSchemaVersion: LATEST_SCHEMA_VERSION };
  if (!existsSync(root)) {
    problems.push('folder does not exist');
    return result;
  }
  try {
    result.manifest = readManifest(root);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  for (const d of WORKSPACE_DIRS)
    if (!existsSync(path.join(root, ...d.split('/')))) problems.push(`missing ${d}/`);
  const dbFile = path.join(root, DB_FILE);
  if (!existsSync(dbFile)) {
    problems.push(`missing ${DB_FILE}`);
  } else {
    const db = openDb(dbFile);
    try {
      result.schemaVersion = schemaVersion(db);
      if (result.schemaVersion > LATEST_SCHEMA_VERSION)
        problems.push('database schema is newer than this AniRecast');
    } finally {
      db.close();
    }
  }
  result.valid = problems.length === 0;
  return result;
}

export function initWorkspace(dir: string, options: { name?: string } = {}): Workspace {
  const root = path.resolve(dir);
  if (existsSync(root)) {
    const entries = readdirSync(root).filter((e) => !IGNORABLE.has(e));
    if (entries.length > 0) {
      throw new AniError('conflict', `Folder is not empty: ${root}`, {
        hint: existsSync(path.join(root, MANIFEST_FILE))
          ? 'This is already a workspace; use `anirecast workspace open`.'
          : 'Choose an empty folder for a new workspace.',
      });
    }
  }
  mkdirSync(root, { recursive: true });
  const manifest: Manifest = {
    format: WORKSPACE_FORMAT,
    formatVersion: WORKSPACE_FORMAT_VERSION,
    workspaceId: `ws_${ulid().toLowerCase()}`,
    name: options.name ?? path.basename(root),
    createdAt: new Date().toISOString(),
    minAppVersion: APP_VERSION,
  };
  for (const d of WORKSPACE_DIRS) mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
  writeFileSync(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(root, AGENTS_FILE), workspaceAgentsMd(manifest.name));
  writeFileSync(path.join(root, CLAUDE_FILE), workspaceClaudeMd(manifest.name));
  const db = openDb(path.join(root, DB_FILE));
  migrate(db);
  run(db, 'INSERT INTO workspace_meta (key, value) VALUES (:key, :value)', {
    key: 'workspace_id',
    value: manifest.workspaceId,
  });
  appendEvent(db, {
    actor: 'user',
    kind: 'workspace.created',
    entityType: 'workspace',
    entityId: manifest.workspaceId,
  });
  return new Workspace(root, manifest, db);
}

export interface OpenOptions {
  /** The daemon migrates; everything else requires the schema to be current. */
  role: 'daemon' | 'cli';
}

export function openWorkspace(dir: string, options: OpenOptions): Workspace {
  const root = path.resolve(dir);
  const manifest = readManifest(root);
  const dbFile = path.join(root, DB_FILE);
  if (!existsSync(dbFile)) throw new AniError('invalid_workspace', `Workspace database missing: ${dbFile}`);
  const db = openDb(dbFile);
  try {
    if (options.role === 'daemon') migrate(db);
    else assertCurrentSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  // The generated guides follow the app: written when missing (workspaces made before a guide existed), rewritten
  // when still ours (starts with our heading) and outdated; a guide the human wrote is left alone.
  refreshGuide(path.join(root, AGENTS_FILE), workspaceAgentsMd(manifest.name));
  refreshGuide(path.join(root, CLAUDE_FILE), workspaceClaudeMd(manifest.name));
  return new Workspace(root, manifest, db);
}

function refreshGuide(file: string, guide: string): void {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === null || (current !== guide && current.startsWith('# AniRecast Workspace')))
    writeFileSync(file, guide);
}
