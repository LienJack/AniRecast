import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, initWorkspace } from '@anirecast/core';
import { afterEach } from 'vitest';
import { type DaemonHandle, startDaemon } from '../src/index.ts';

/** Tests never chain the slow identity pass, judge cuts or dispatch to Codex unless they ask for it. */
export const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  pipeline: { autoAnalyze: false },
  continuity: { ...DEFAULT_CONFIG.continuity, enabled: false },
};

const CLI = path.resolve(import.meta.dirname, '../../../packages/cli/src/main.ts');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export interface TestEnv {
  tmp: string;
  root: string;
  daemon: DaemonHandle;
  env: NodeJS.ProcessEnv;
}

/** A fresh workspace with an in-process daemon, torn down after the test. */
export async function setupWorkspace(): Promise<TestEnv> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-daemon-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'ws');
  initWorkspace(root).close();
  const daemon = await startDaemon({ root, port: 0, config: TEST_CONFIG, dispatch: false, log: () => {} });
  cleanups.push(() => daemon.stop());
  return { tmp, root, daemon, env: { ...process.env, ANIRECAST_CONFIG_DIR: path.join(tmp, 'cfg') } };
}

export interface CliResult {
  code: number | null;
  json: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  stderr: string;
}

export function cli(t: Pick<TestEnv, 'root' | 'env'>, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--workspace', t.root, ...args], { env: t.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, json: JSON.parse(out), stderr: err }));
  });
}

/** Unwraps `data` from a successful CLI call, failing the test with the CLI error otherwise. */
export async function cliData<T>(t: Pick<TestEnv, 'root' | 'env'>, args: string[]): Promise<T> {
  const r = await cli(t, args);
  if (!r.json.ok)
    throw new Error(`anirecast ${args.join(' ')} failed: ${JSON.stringify(r.json.error)}\n${r.stderr}`);
  return r.json.data as T;
}
