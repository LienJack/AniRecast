/** Stable machine-readable error codes. CLI exit codes and Web messages key off these. */
export type ErrorCode =
  | 'usage'
  | 'not_found'
  | 'conflict'
  | 'invalid_workspace'
  | 'workspace_locked'
  | 'schema_mismatch'
  | 'naming_violation'
  | 'daemon_not_running'
  | 'dependency_missing'
  | 'provider_rejected'
  | 'budget_exceeded'
  | 'transient'
  | 'internal';

export class AniError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AniError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export const isAniError = (value: unknown): value is AniError => value instanceof AniError;
