import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalConfig {
  /** Workspace the daemon opens on start. Set by `anirecast setup` / `workspace open`, never hard-coded. */
  workspace: string | null;
  recentWorkspaces: string[];
  daemon: { host: string; port: number };
  /** `fake` runs the whole pipeline offline at zero cost (tests, dev past the budget). */
  provider: 'gemini' | 'fake';
  /**
   * Model per task. A `fal:` prefix routes to fal.ai (e.g. `fal:bytedance/seedance-2.5/us/reference-to-video`),
   * `jev:` to the OpenAI-compatible JEV router (e.g. `jev:google/gemini-3.8-flash`); no prefix is Gemini.
   */
  models: {
    image: string;
    video: string;
    vision: string;
    continuity: string;
    design: string;
    /** Web search with sources (official character art); a Gemini model, it uses Google Search. */
    search: string;
    /**
     * The director: reads the original frame or shot, the references and the style, then writes each storyboard
     * and video prompt and picks its references. A vision model.
     */
    director: string;
  };
  providers: { jev: { baseUrl: string } };
  /** After detection, judge each cut and merge the ones inside one continuous moment. */
  continuity: {
    enabled: boolean;
    /** Merge automatically at or above this confidence. */
    autoMerge: number;
    /** Between this and `autoMerge` the cut goes to Codex; below it the cut stays. */
    review: number;
    /** A merge never makes a shot longer than this (Omni edits at most 10 s). */
    maxShotSeconds: number;
  };
  /** Hard cap on paid provider spend recorded in the workspace cost ledger. null = no cap. */
  budget: { capUsd: number | null };
  /** Jobs at once per lane; `video` caps shot videos inside the generate lane (images use the rest). */
  concurrency: { generate: number; media: number; io: number; video: number };
  /**
   * Codex sessions (review tasks, discussions): the model and reasoning effort every thread and turn asks for;
   * null leaves it to Codex's own config.
   */
  codex: {
    autoDispatch: boolean;
    binPath: string | null;
    model: string | null;
    effort: string | null;
    /** Agent tasks Codex works on at once (each in its own thread; never two on one shot). */
    concurrency?: number;
  };
  /** After shot detection, queue the Flash analysis and same-person identification automatically. */
  pipeline: { autoAnalyze: boolean };
  limits: {
    /** Requests per model per quota day; blocked requests count too. Models not listed are not limited. */
    perDay: Record<string, number>;
    /** Google resets daily quotas at midnight Pacific time. */
    quotaTimeZone: string;
    /** After this many safety-filter blocks a shot is not sent again without `--retry-blocked`. */
    maxSafetyBlocks: number;
  };
}

export const DEFAULT_CONFIG: LocalConfig = {
  workspace: null,
  recentWorkspaces: [],
  daemon: { host: '127.0.0.1', port: 7878 },
  provider: 'gemini',
  models: {
    // Storyboard frames and design sheets: GPT Image 2.5 Sunburst (fal). Shot videos: Wan 3.0 (fal) — on the
    // Lycoris OP its 1080p takes were crisper than Seedance 2.5's and about a sixth of the price.
    image: 'fal:openai/gpt-image-2.5/sunburst/edit',
    video: 'fal:alibaba/wan-3.0/reference-to-video',
    vision: 'gemini-3.8-flash',
    continuity: 'jev:google/gemini-3.8-flash',
    // Character design sheets; `gemini-nano-banana-2.1` (Nano Banana 2.1) also works.
    design: 'fal:openai/gpt-image-2.5/sunburst/edit',
    search: 'gemini-3.8-flash',
    director: 'gemini-3.8-flash',
  },
  providers: { jev: { baseUrl: 'https://router.shengsuanyun.com/api/v1' } },
  continuity: { enabled: true, autoMerge: 0.85, review: 0.5, maxShotSeconds: 10 },
  budget: { capUsd: null },
  concurrency: { generate: 3, media: 2, io: 2, video: 3 },
  codex: { autoDispatch: true, binPath: null, model: 'gpt-6.1-sol', effort: 'high', concurrency: 3 },
  pipeline: { autoAnalyze: true },
  // Omni allows 100 requests a day on API tier 2 (measured 2026-10-25); raise it after upgrading the tier.
  limits: {
    perDay: { 'gemini-omni-1.1-flash': 100 },
    quotaTimeZone: 'America/Los_Angeles',
    maxSafetyBlocks: 2,
  },
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
