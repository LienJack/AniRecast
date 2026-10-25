import type { JobHandler } from '../runner.ts';
import { detectShotsHandler, extractClipHandler, prepareShotsHandler } from './clips.ts';
import { noopHandler } from './noop.ts';
import { downloadSourceHandler, importSourceHandler } from './sources.ts';

export function createHandlers(): Map<string, JobHandler> {
  return new Map<string, JobHandler>([
    ['noop', noopHandler],
    ['source.import', importSourceHandler],
    ['source.download', downloadSourceHandler],
    ['clip.extract', extractClipHandler],
    ['shots.detect', detectShotsHandler],
    ['shots.prepare', prepareShotsHandler],
  ]);
}
