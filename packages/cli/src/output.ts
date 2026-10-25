import { exitCodeFor, ok, toEnvelopeError } from '@anirecast/shared';

/** Progress and human notes go to stderr so stdout stays a single JSON object. */
export const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** Wraps a command body: prints `{ok,data}` or `{ok:false,error}` and sets the exit code. */
export function command<A extends unknown[]>(fn: (...args: A) => unknown | Promise<unknown>) {
  return async (...args: A): Promise<void> => {
    try {
      const data = await fn(...args);
      process.stdout.write(`${JSON.stringify(ok(data ?? null))}\n`);
    } catch (error) {
      const envelope = toEnvelopeError(error);
      process.stdout.write(`${JSON.stringify({ ok: false, error: envelope })}\n`);
      process.exitCode = exitCodeFor(envelope.code);
    }
  };
}
