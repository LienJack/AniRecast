import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, MANIFEST_FILE, openWorkspace, type Workspace } from '@anirecast/core';
import { AniError } from '@anirecast/shared';

export interface GlobalOptions {
  workspace?: string;
}

/** Walks up from `start` looking for a workspace manifest (Codex runs inside the workspace root). */
function findUp(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** --workspace, then $ANIRECAST_WORKSPACE, then the current directory, then the configured default. */
export function resolveWorkspaceRoot(opts: GlobalOptions, env: NodeJS.ProcessEnv = process.env): string {
  const root =
    opts.workspace ?? env.ANIRECAST_WORKSPACE ?? findUp(process.cwd()) ?? loadConfig(env).workspace;
  if (!root) {
    throw new AniError('usage', 'No workspace selected', {
      hint: 'Pass --workspace <dir>, run inside a workspace, or `anirecast workspace open <dir>`.',
    });
  }
  return path.resolve(root);
}

export function openCliWorkspace(opts: GlobalOptions): Workspace {
  return openWorkspace(resolveWorkspaceRoot(opts), { role: 'cli' });
}

/** Opens the workspace for the duration of `fn` and always closes it. */
export async function withWorkspace<T>(
  opts: GlobalOptions,
  fn: (ws: Workspace) => T | Promise<T>,
): Promise<T> {
  const ws = openCliWorkspace(opts);
  try {
    return await fn(ws);
  } finally {
    ws.close();
  }
}
