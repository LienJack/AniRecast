import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_FILE, daemonStatus, geminiKeySource, inspectWorkspace, openWorkspace } from '@anirecast/core';
import type { Command } from 'commander';
import { type GlobalOptions, resolveWorkspaceRoot } from '../context.ts';
import { command } from '../output.ts';

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  hint?: string;
}

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function version(cmd: string, args: string[], pattern: RegExp): string | undefined {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return undefined;
  return (`${r.stdout}\n${r.stderr}`.match(pattern)?.[1] ?? r.stdout.trim().split('\n')[0]) || undefined;
}

function tool(
  name: string,
  cmd: string,
  args: string[],
  pattern: RegExp,
  hint: string,
  required = true,
): Check {
  const v = version(cmd, args, pattern);
  return v
    ? { name, ok: true, required, detail: v }
    : { name, ok: false, required, detail: 'not found', hint };
}

export function runDoctor(globals: GlobalOptions): { healthy: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    ok: major >= 24,
    required: true,
    detail: process.version,
    ...(major >= 24 ? {} : { hint: 'Install Node.js 24 LTS or newer.' }),
  });
  checks.push(tool('ffmpeg', 'ffmpeg', ['-version'], /ffmpeg version (\S+)/, 'brew install ffmpeg'));
  checks.push(tool('ffprobe', 'ffprobe', ['-version'], /ffprobe version (\S+)/, 'brew install ffmpeg'));
  checks.push(tool('yt-dlp', 'yt-dlp', ['--version'], /^(\S+)/, 'uv tool install yt-dlp'));
  checks.push(
    tool('deno', 'deno', ['--version'], /deno (\S+)/, 'brew install deno (yt-dlp needs it for YouTube)'),
  );
  checks.push(tool('uv', 'uv', ['--version'], /uv (\S+)/, 'brew install uv'));

  const pyProject = path.join(REPO_ROOT, 'python');
  const venvOk = existsSync(path.join(pyProject, '.venv'));
  checks.push({
    name: 'python-sidecar',
    ok: venvOk,
    required: true,
    detail: venvOk ? pyProject : 'environment not created',
    ...(venvOk ? {} : { hint: `uv sync --project ${pyProject}` }),
  });

  const keySource = geminiKeySource();
  checks.push({
    name: 'gemini-api-key',
    ok: keySource !== 'missing',
    required: true,
    detail: keySource,
    ...(keySource === 'missing' ? { hint: 'Run `anirecast auth set-key` (reads the key from stdin).' } : {}),
  });

  let root: string | undefined;
  try {
    root = resolveWorkspaceRoot(globals);
  } catch {
    checks.push({
      name: 'workspace',
      ok: false,
      required: true,
      detail: 'none selected',
      hint: 'anirecast workspace init|open <dir>',
    });
  }
  if (root) {
    const inspect = inspectWorkspace(root);
    checks.push({
      name: 'workspace',
      ok: inspect.valid,
      required: true,
      detail: inspect.valid ? `${root} (schema v${inspect.schemaVersion})` : inspect.problems.join('; '),
    });
    if (inspect.valid) {
      checks.push({
        name: 'workspace-agents-md',
        ok: existsSync(path.join(root, AGENTS_FILE)),
        required: false,
        detail: path.join(root, AGENTS_FILE),
      });
      const ws = openWorkspace(root, { role: 'cli' });
      try {
        const status = daemonStatus(ws.db);
        checks.push({
          name: 'daemon',
          ok: status.alive,
          required: true,
          detail: status.alive ? `pid ${status.heartbeat?.pid} on ${status.heartbeat?.host}` : 'not running',
          ...(status.alive ? {} : { hint: 'anirecast serve' }),
        });
      } finally {
        ws.close();
      }
    }
  }
  return { healthy: checks.every((c) => c.ok || !c.required), checks };
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check tools, keys, the workspace and the daemon')
    .action(command(() => runDoctor(program.opts<GlobalOptions>())));
}
