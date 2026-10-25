import { type ErrorCode, isAniError } from './errors.ts';

/** The single JSON object every CLI command prints to stdout. */
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: EnvelopeError };

export interface EnvelopeError {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: unknown;
}

export const ok = <T>(data: T): Envelope<T> => ({ ok: true, data });

export function toEnvelopeError(error: unknown): EnvelopeError {
  if (isAniError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}

/** Exit codes: 0 ok, 2 usage/user error, 3 transient (safe to retry), 4 provider rejected, 1 anything else. */
export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case 'usage':
    case 'not_found':
    case 'conflict':
    case 'invalid_workspace':
    case 'naming_violation':
    case 'schema_mismatch':
    case 'budget_exceeded':
      return 2;
    case 'transient':
    case 'daemon_not_running':
    case 'workspace_locked':
      return 3;
    case 'provider_rejected':
      return 4;
    default:
      return 1;
  }
}
