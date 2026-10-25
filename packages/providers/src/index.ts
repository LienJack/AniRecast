import { AniError } from '@anirecast/shared';
import { type FakeOptions, FakeProvider } from './fake.ts';
import { GeminiProvider } from './gemini.ts';
import type { Provider } from './types.ts';

export * from './fake.ts';
export * from './gemini.ts';
export * from './pricing.ts';
export * from './types.ts';

export type ProviderKind = 'gemini' | 'fake';

export function createProvider(
  kind: ProviderKind,
  opts: { apiKey?: string; fake?: FakeOptions } = {},
): Provider {
  if (kind === 'fake') return new FakeProvider(opts.fake);
  if (!opts.apiKey) {
    throw new AniError('dependency_missing', 'No Gemini API key configured', {
      hint: 'Run `anirecast auth set-key` or set GEMINI_API_KEY.',
    });
  }
  return new GeminiProvider({ apiKey: opts.apiKey });
}

/** Stand-in when no key is configured: the daemon still runs downloads and media jobs, generation fails clearly. */
export function unavailableProvider(reason: string, hint: string): Provider {
  const fail = async (): Promise<never> => {
    throw new AniError('dependency_missing', reason, { hint });
  };
  return { name: 'gemini', generateImage: fail, editVideo: fail, analyzeImages: fail };
}
