import { AniError, IMAGE_MODELS, VIDEO_MODELS } from '@anirecast/shared';
import { loadConfig } from '../config.ts';
import type { Db } from '../db.ts';
import { getProject, updateProjectSettings } from './projects.ts';

export interface ProjectModels {
  /** Storyboard frames. */
  image: string;
  /** Character design sheets. */
  design: string;
  /** Shot videos (video-to-video edits). */
  video: string;
}

/** The models a project generates with: its own choice, else the workspace defaults from the config. */
export function projectModels(db: Db, projectRef: string): ProjectModels {
  const defaults = loadConfig().models;
  const chosen = (getProject(db, projectRef).settings.models ?? {}) as Partial<ProjectModels>;
  return {
    image: chosen.image ?? defaults.image,
    design: chosen.design ?? defaults.design,
    video: chosen.video ?? defaults.video,
  };
}

/** Chooses the project's models; only models in the catalogue (a null clears back to the default). */
export function setProjectModels(
  db: Db,
  projectRef: string,
  patch: { [K in keyof ProjectModels]?: string | null },
  actor: string,
): ProjectModels {
  const project = getProject(db, projectRef);
  const images = IMAGE_MODELS.map((m) => m.id);
  const videos = VIDEO_MODELS.map((m) => m.id);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const allowed = key === 'video' ? videos : key === 'image' || key === 'design' ? images : null;
    if (!allowed) throw new AniError('usage', `Unknown model slot: ${key}`);
    if (!allowed.includes(value))
      throw new AniError(
        'usage',
        `${value} is not a selectable ${key === 'video' ? 'video' : 'image'} model`,
        {
          hint: `One of: ${allowed.join(', ')}`,
        },
      );
  }
  const current = (project.settings.models ?? {}) as Partial<ProjectModels>;
  const next: Partial<ProjectModels> = { ...current };
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof ProjectModels, string | null | undefined]
  >) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  updateProjectSettings(db, project.id, { models: Object.keys(next).length ? next : null }, actor);
  return projectModels(db, project.id);
}

export type { ImageModelSpec, VideoModelSpec } from '@anirecast/shared';
