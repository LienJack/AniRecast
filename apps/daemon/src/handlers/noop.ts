import { type JobHandler, sleep } from '../runner.ts';

/** Diagnostic job: sleeps `ms` in ten steps, reporting progress. Used by tests and `jobs noop`. */
export const noopHandler: JobHandler = async ({ job, signal, progress }) => {
  const { ms = 100 } = (job.payload ?? {}) as { ms?: number };
  for (let i = 1; i <= 10; i++) {
    await sleep(ms / 10, signal);
    progress(i / 10, `step ${i}/10`);
  }
  return { result: { sleptMs: ms } };
};
