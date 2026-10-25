/**
 * Model ids name their backend: `fal:<endpoint>` (fal.ai), `jev:<model>` (the OpenAI-compatible JEV router),
 * anything else Gemini. Kept here because both the planner (core) and the adapters (providers) need it.
 */
export const isFalModel = (model: string): boolean => model.startsWith('fal:');

/** fal's Gemini Omni `edit` endpoint takes the video and a prompt only, no reference images. */
export const isTextOnlyVideoModel = (model: string): boolean =>
  isFalModel(model) && /gemini-omni/.test(model) && model.endsWith('/edit');
