import { execFileSync, spawnSync } from 'node:child_process';
import { AniError } from '@anirecast/shared';

const SERVICE = 'anirecast';

/** Services that need an API key. The daemon (launchd) cannot read `.env`, so keys live in the keychain. */
export type KeyedProvider = 'gemini' | 'fal' | 'jev';

export const API_KEYS: Record<KeyedProvider, { account: string; env: string[]; label: string }> = {
  gemini: { account: 'gemini-api-key', env: ['GEMINI_API_KEY', 'GEMINI_OMNI_API_KEY'], label: 'Gemini' },
  fal: { account: 'fal-api-key', env: ['FAL_KEY', 'FAL_AI_KEY'], label: 'fal.ai' },
  jev: { account: 'jev-api-key', env: ['JEV_API_KEY'], label: 'JEV (OpenAI-compatible router)' },
};

const fromEnv = (provider: KeyedProvider, env: NodeJS.ProcessEnv) =>
  API_KEYS[provider].env.map((name) => env[name]).find((v) => v);

/** Environment first (dev `.env`), then the macOS keychain. Keys are never written to a workspace. */
export function getApiKey(provider: KeyedProvider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = fromEnv(provider, env);
  if (value) return value;
  if (process.platform !== 'darwin' || env.ANIRECAST_DISABLE_KEYCHAIN === '1') return undefined;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', API_KEYS[provider].account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function apiKeySource(
  provider: KeyedProvider,
  env: NodeJS.ProcessEnv = process.env,
): 'env' | 'keychain' | 'missing' {
  if (fromEnv(provider, env)) return 'env';
  return getApiKey(provider, env) ? 'keychain' : 'missing';
}

/** Stores a key in the macOS keychain. The key goes through `security -i` stdin, never argv. */
export function setApiKey(provider: KeyedProvider, key: string): void {
  const { account, env, label } = API_KEYS[provider];
  if (process.platform !== 'darwin') {
    throw new AniError('dependency_missing', 'Keychain storage is only implemented on macOS', {
      hint: `Set ${env[0]} in the environment instead.`,
    });
  }
  // Keys are tokens (fal's contain a colon); anything with spaces or quotes is not one.
  if (!/^[\w.:-]{20,}$/.test(key)) throw new AniError('usage', `That does not look like a ${label} API key`);
  const command = `add-generic-password -U -s ${SERVICE} -a ${account} -w "${key}"\n`;
  const result = spawnSync('security', ['-i'], { input: command, encoding: 'utf8' });
  if (result.status !== 0) throw new AniError('internal', 'Failed to store the key in the keychain');
}

/** The provider's key from `.env`-style text (`NAME=value`, optional quotes). */
export function keyFromEnvText(provider: KeyedProvider, text: string): string | undefined {
  for (const name of API_KEYS[provider].env) {
    const m = new RegExp(`^${name}\\s*=\\s*"?([^"\\n]+)"?`, 'm').exec(text);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return undefined;
}

export const getGeminiApiKey = (env: NodeJS.ProcessEnv = process.env) => getApiKey('gemini', env);
export const geminiKeySource = (env: NodeJS.ProcessEnv = process.env) => apiKeySource('gemini', env);
export const setGeminiApiKey = (key: string) => setApiKey('gemini', key);
