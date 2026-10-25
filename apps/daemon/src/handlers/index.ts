import type { JobHandler } from '../runner.ts';
import { noopHandler } from './noop.ts';

export function createHandlers(): Map<string, JobHandler> {
  return new Map<string, JobHandler>([['noop', noopHandler]]);
}
