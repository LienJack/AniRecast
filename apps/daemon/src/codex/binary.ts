import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface CodexCommand {
  command: string;
  /** Arguments that start the JSON-RPC app-server on stdio. */
  args: string[];
  version: string;
  source: 'config' | 'desktop' | 'path';
}

/** macOS: the desktop app bundles its own, usually newer, CLI. Windows is M7. */
const DESKTOP_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
];

function versionOf(command: string): string | undefined {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return undefined;
  return /codex-cli\s+(\S+)/.exec(r.stdout)?.[1];
}

/** Compares `0.163.0-alpha.10.2` style versions; pre-releases sort below their release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2);
    return { core: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return (x.pre ?? '').localeCompare(y.pre ?? '', undefined, { numeric: true });
}

/**
 * Configured path wins; otherwise the newest of the desktop-bundled CLI and PATH. (The PATH 0.156
 * rejected this machine's configured model while the bundled 0.163 accepted it.)
 */
export function resolveCodexCommand(
  binPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): CodexCommand | undefined {
  if (binPath) {
    const version = versionOf(binPath);
    return version ? { command: binPath, args: ['app-server'], version, source: 'config' } : undefined;
  }
  const found: CodexCommand[] = [];
  for (const candidate of DESKTOP_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    const version = versionOf(candidate);
    if (version) found.push({ command: candidate, args: ['app-server'], version, source: 'desktop' });
  }
  const which = spawnSync('which', ['codex'], { encoding: 'utf8', env });
  const onPath = which.status === 0 ? which.stdout.trim() : '';
  if (onPath) {
    const version = versionOf(onPath);
    if (version) found.push({ command: onPath, args: ['app-server'], version, source: 'path' });
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))[0];
}
