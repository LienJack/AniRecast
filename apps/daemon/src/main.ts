#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '@anirecast/core';
import { toEnvelopeError } from '@anirecast/shared';
import { startDaemon } from './daemon.ts';

const { values } = parseArgs({
  options: { workspace: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' } },
});
const root = values.workspace ?? process.env.ANIRECAST_WORKSPACE ?? loadConfig().workspace;
if (!root) {
  process.stderr.write('No workspace: pass --workspace or set one with `anirecast workspace open <dir>`.\n');
  process.exit(2);
}

try {
  const daemon = await startDaemon({
    root,
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host } : {}),
  });
  const shutdown = (signal: string) => {
    process.stderr.write(`received ${signal}, stopping\n`);
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: toEnvelopeError(error) })}\n`);
  process.exit(1);
}
