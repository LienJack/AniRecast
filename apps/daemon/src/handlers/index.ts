import type { JobHandler } from '../runner.ts';
import { detectShotsHandler, extractClipHandler, prepareShotsHandler } from './clips.ts';
import { composeRenderHandler, generateBoardHandler, generateTakeHandler } from './generation.ts';
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
    ['board.generate', generateBoardHandler],
    ['take.generate', generateTakeHandler],
    ['render.compose', composeRenderHandler],
  ]);
}
