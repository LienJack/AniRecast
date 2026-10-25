import { execFileSync, spawnSync } from 'node:child_process';
import { AniError } from '@anirecast/shared';

const SERVICE = 'anirecast';
const ACCOUNT = 'gemini-api-key';

/** Environment first (dev `.env`), then the macOS keychain. The key is never written to a workspace. */
export function getGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.GEMINI_API_KEY ?? env.GEMINI_OMNI_API_KEY;
  if (fromEnv) return fromEnv;
  if (process.platform !== 'darwin' || env.ANIRECAST_DISABLE_KEYCHAIN === '1') return undefined;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function geminiKeySource(env: NodeJS.ProcessEnv = process.env): 'env' | 'keychain' | 'missing' {
  if (env.GEMINI_API_KEY ?? env.GEMINI_OMNI_API_KEY) return 'env';
  return getGeminiApiKey(env) ? 'keychain' : 'missing';
}

/** Stores the key in the macOS keychain. The key goes through `security -i` stdin, never argv. */
export function setGeminiApiKey(key: string): void {
  if (process.platform !== 'darwin') {
    throw new AniError('dependency_missing', 'Keychain storage is only implemented on macOS', {
      hint: 'Set GEMINI_API_KEY in the environment instead.',
    });
  }
  if (!/^[\w.-]{20,}$/.test(key)) throw new AniError('usage', 'That does not look like a Gemini API key');
  const command = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${key}"\n`;
  const result = spawnSync('security', ['-i'], { input: command, encoding: 'utf8' });
  if (result.status !== 0) throw new AniError('internal', 'Failed to store the key in the keychain');
}
