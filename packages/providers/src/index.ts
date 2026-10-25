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
