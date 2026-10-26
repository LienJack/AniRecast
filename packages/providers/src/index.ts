import { AniError } from '@anirecast/shared';
import { type FakeOptions, FakeProvider } from './fake.ts';
import { FAL_PREFIX, FalProvider } from './fal.ts';
import { GeminiProvider } from './gemini.ts';
import { JEV_PREFIX, JevProvider } from './jev.ts';
import type {
  ImageGenRequest,
  Provider,
  VideoEditRequest,
  VisionRequest,
  WebSearchRequest,
} from './types.ts';

export * from './fake.ts';
export * from './fal.ts';
export * from './gemini.ts';
export * from './jev.ts';
export * from './pricing.ts';
export * from './types.ts';

export type ProviderKind = 'gemini' | 'fake';
export type Backend = 'gemini' | 'fal' | 'jev';

export const backendOf = (model: string): Backend =>
  model.startsWith(FAL_PREFIX) ? 'fal' : model.startsWith(JEV_PREFIX) ? 'jev' : 'gemini';

const SETUP_HINT: Record<Backend, string> = {
  gemini: 'Run `anirecast auth set-key`, or set GEMINI_API_KEY.',
  fal: 'Run `anirecast auth set-key --provider fal`, or set FAL_KEY.',
  jev: 'Run `anirecast auth set-key --provider jev`, or set JEV_API_KEY.',
};

/** Sends each request to the backend its model names: `fal:…` to fal.ai, `jev:…` to the JEV router, else Gemini. */
export class RoutedProvider implements Provider {
  readonly name = 'router' as const;
  readonly #routes: Partial<Record<Backend, Provider>>;

  constructor(routes: Partial<Record<Backend, Provider>>) {
    this.#routes = routes;
  }

  backendFor(model: string): Backend {
    return backendOf(model);
  }

  #pick(model: string): Provider {
    const backend = backendOf(model);
    const provider = this.#routes[backend];
    if (!provider)
      throw new AniError('dependency_missing', `No ${backend} API key configured for ${model}`, {
        hint: SETUP_HINT[backend],
      });
    return provider;
  }

  async generateImage(req: ImageGenRequest) {
    return this.#pick(req.model).generateImage(req);
  }

  async editVideo(req: VideoEditRequest) {
    return this.#pick(req.model).editVideo(req);
  }

  async searchWeb(req: WebSearchRequest) {
    const p = this.#pick(req.model);
    if (!p.searchWeb)
      throw new AniError('usage', `${req.model} cannot search the web`, {
        hint: 'Use a Gemini model for search.',
      });
    return p.searchWeb(req);
  }

  async analyzeImages<T>(req: VisionRequest) {
    return this.#pick(req.model).analyzeImages<T>(req);
  }
}

export interface ProviderKeys {
  /** Gemini API key. */
  apiKey?: string;
  fal?: string;
  jev?: { apiKey: string; baseUrl: string };
  fake?: FakeOptions;
}

export function createProvider(kind: ProviderKind, opts: ProviderKeys = {}): Provider {
  if (kind === 'fake') return new FakeProvider(opts.fake);
  return new RoutedProvider({
    ...(opts.apiKey ? { gemini: new GeminiProvider({ apiKey: opts.apiKey }) } : {}),
    ...(opts.fal ? { fal: new FalProvider({ apiKey: opts.fal }) } : {}),
    ...(opts.jev ? { jev: new JevProvider(opts.jev) } : {}),
  });
}

/** Stand-in when no key is configured: the daemon still runs downloads and media jobs, generation fails clearly. */
export function unavailableProvider(reason: string, hint: string): Provider {
  const fail = async (): Promise<never> => {
    throw new AniError('dependency_missing', reason, { hint });
  };
  return { name: 'gemini', generateImage: fail, editVideo: fail, analyzeImages: fail };
}
