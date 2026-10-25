import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalConfig {
  /** Workspace the daemon opens on start. Set by `anirecast setup` / `workspace open`, never hard-coded. */
  workspace: string | null;
  recentWorkspaces: string[];
  daemon: { host: string; port: number };
  models: { image: string; video: string; vision: string };
  /** Hard cap on paid provider spend recorded in the workspace cost ledger. null = no cap. */
  budget: { capUsd: number | null };
  concurrency: { generate: number; media: number; io: number };
  codex: { autoDispatch: boolean; binPath: string | null; model: string | null };
}

export const DEFAULT_CONFIG: LocalConfig = {
  workspace: null,
  recentWorkspaces: [],
  daemon: { host: '127.0.0.1', port: 7878 },
  models: { image: 'gemini-nano-banana-2.1', video: 'gemini-omni-1.1-flash', vision: 'gemini-3.8-flash' },
  budget: { capUsd: null },
  concurrency: { generate: 2, media: 2, io: 2 },
  codex: { autoDispatch: true, binPath: null, model: null },
};

/** Per-machine settings live outside the workspace; `ANIRECAST_CONFIG_DIR` overrides for tests. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANIRECAST_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'anirecast');
}

export const configFile = (env?: NodeJS.ProcessEnv): string => path.join(configDir(env), 'config.json');

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object | null ? DeepPartial<T[K]> | T[K] : T[K] };

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? merge(b, v as DeepPartial<typeof b>)
        : v;
  }
  return out as T;
}

export function loadConfig(env?: NodeJS.ProcessEnv): LocalConfig {
  const file = configFile(env);
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  return merge(
    structuredClone(DEFAULT_CONFIG),
    JSON.parse(readFileSync(file, 'utf8')) as DeepPartial<LocalConfig>,
  );
}

export function saveConfig(config: LocalConfig, env?: NodeJS.ProcessEnv): void {
  const file = configFile(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, file);
}

export function updateConfig(fn: (config: LocalConfig) => void, env?: NodeJS.ProcessEnv): LocalConfig {
  const config = loadConfig(env);
  fn(config);
  saveConfig(config, env);
  return config;
}

/** Records `dir` as the current workspace and moves it to the front of the recent list. */
export function rememberWorkspace(dir: string, env?: NodeJS.ProcessEnv): LocalConfig {
  const abs = path.resolve(dir);
  return updateConfig((c) => {
    c.workspace = abs;
    c.recentWorkspaces = [abs, ...c.recentWorkspaces.filter((w) => w !== abs)].slice(0, 10);
  }, env);
}
