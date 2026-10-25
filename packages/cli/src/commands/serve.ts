import { loadConfig } from '@anirecast/core';
import { startDaemon } from '@anirecast/daemon';
import { AniError } from '@anirecast/shared';
import type { Command } from 'commander';
import { type GlobalOptions, resolveWorkspaceRoot } from '../context.ts';
import { note } from '../output.ts';

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Run the AniRecast daemon in the foreground (launchd runs this after `anirecast setup`)')
    .option('--port <port>', 'HTTP port for the Web UI')
    .action(async (opts: { port?: string }) => {
      if (process.env.CODEX_SANDBOX) {
        throw new AniError('usage', 'Refusing to start the daemon inside a Codex sandbox', {
          hint: 'A sandboxed daemon has no network and cannot reach Gemini. Start it outside Codex.',
        });
      }
      const root = resolveWorkspaceRoot(program.opts<GlobalOptions>());
      const config = loadConfig();
      const daemon = await startDaemon({ root, config, ...(opts.port ? { port: Number(opts.port) } : {}) });
      const shutdown = (signal: string) => {
        note(`received ${signal}, stopping`);
        void daemon.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
}
