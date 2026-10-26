import type { JobHandler } from '../runner.ts';
import { analyzeShotsHandler, identifyCastHandler } from './analysis.ts';
import { tidyCastHandler } from './cast-tidy.ts';
import { detectShotsHandler, extractClipHandler, prepareShotsHandler } from './clips.ts';
import { shotContinuityHandler } from './continuity.ts';
import { analyzeCastHandler } from './design.ts';
import {
  composeRenderHandler,
  generateBoardHandler,
  generateDesignHandler,
  generateTakeHandler,
  planTakeHandler,
  stillTakeHandler,
} from './generation.ts';
import { noopHandler } from './noop.ts';
import { searchReferencesHandler } from './references.ts';
import { shotCastHandler } from './shot-cast.ts';
import { downloadSourceHandler, importSourceHandler } from './sources.ts';
import { styleAnalysisHandler } from './style.ts';

export function createHandlers(): Map<string, JobHandler> {
  return new Map<string, JobHandler>([
    ['noop', noopHandler],
    ['source.import', importSourceHandler],
    ['source.download', downloadSourceHandler],
    ['clip.extract', extractClipHandler],
    ['shots.detect', detectShotsHandler],
    ['shots.prepare', prepareShotsHandler],
    ['shots.continuity', shotContinuityHandler],
    ['board.generate', generateBoardHandler],
    ['design.analyze', analyzeCastHandler],
    ['design.references', searchReferencesHandler],
    ['design.generate', generateDesignHandler],
    ['take.generate', generateTakeHandler],
    ['take.still', stillTakeHandler],
    ['render.compose', composeRenderHandler],
    ['shots.analyze', analyzeShotsHandler],
    ['project.style', styleAnalysisHandler],
    ['cast.identify', identifyCastHandler],
    ['cast.tidy', tidyCastHandler],
    ['shot.cast', shotCastHandler],
    ['take.plan', planTakeHandler],
  ]);
}
