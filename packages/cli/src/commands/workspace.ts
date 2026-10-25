import {
  all,
  daemonStatus,
  initWorkspace,
  inspectWorkspace,
  readLock,
  rememberWorkspace,
} from '@anirecast/core';
import { AniError } from '@anirecast/shared';
import type { Command } from 'commander';
import { type GlobalOptions, resolveWorkspaceRoot, withWorkspace } from '../context.ts';
import { command } from '../output.ts';

export function registerWorkspace(program: Command): void {
  const ws = program.command('workspace').description('Create, open and inspect workspaces');

  ws.command('init <dir>')
    .description('Create a new workspace in an empty folder and make it the default')
    .option('--name <name>', 'display name')
    .action(
      command((dir: string, opts: { name?: string }) => {
        const workspace = initWorkspace(dir, opts.name ? { name: opts.name } : {});
        try {
          rememberWorkspace(workspace.root);
          return { root: workspace.root, manifest: workspace.manifest };
        } finally {
          workspace.close();
        }
      }),
    );

  ws.command('open <dir>')
    .description('Validate an existing workspace and make it the default')
    .action(
      command((dir: string) => {
        const result = inspectWorkspace(dir);
        if (!result.valid) {
          throw new AniError('invalid_workspace', `Not a usable workspace: ${result.problems.join('; ')}`, {
            details: result,
          });
        }
        rememberWorkspace(result.root);
        return result;
      }),
    );

  ws.command('status')
    .description('Show the current workspace, schema and daemon state')
    .action(
      command(async () => {
        const globals = program.opts<GlobalOptions>();
        const root = resolveWorkspaceRoot(globals);
        const inspect = inspectWorkspace(root);
        if (!inspect.valid) return { root, inspect };
        return withWorkspace(globals, (w) => {
          const counts = Object.fromEntries(
            ['sources', 'projects', 'personas', 'jobs'].map((t) => [
              t,
              all<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM ${t}`)[0]?.n ?? 0,
            ]),
          );
          return {
            root,
            manifest: w.manifest,
            schemaVersion: inspect.schemaVersion,
            daemon: daemonStatus(w.db),
            lock: readLock(root) ?? null,
            counts,
          };
        });
      }),
    );
}
