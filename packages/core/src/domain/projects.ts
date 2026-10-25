import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { slugify, uniqueSlug } from '../naming.ts';
import { getSource } from './sources.ts';

export type GenerationTier = 'draft' | 'preview' | 'final';
export const TIERS: readonly GenerationTier[] = ['draft', 'preview', 'final'];

export interface Project {
  id: string;
  slug: string;
  name: string;
  sourceId: string;
  status: 'active' | 'archived';
  generationTier: GenerationTier;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  source_id: string;
  status: 'active' | 'archived';
  generation_tier: GenerationTier;
  settings_json: string;
  created_at: number;
  updated_at: number;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  sourceId: r.source_id,
  status: r.status,
  generationTier: r.generation_tier,
  settings: fromJson(r.settings_json, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const projectDir = (p: Pick<Project, 'slug'>): string => `projects/${p.slug}`;
export const projectCacheDir = (p: Pick<Project, 'slug'>): string => `cache/projects/${p.slug}`;

/** Accepts a project id or slug (case-insensitive). */
export function getProject(db: Db, ref: string): Project {
  const row = one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = :ref OR slug = :ref COLLATE NOCASE', {
    ref,
  });
  if (!row) throw new AniError('not_found', `Project not found: ${ref}`);
  return toProject(row);
}

export function listProjects(db: Db): Project[] {
  return all<ProjectRow>(db, 'SELECT * FROM projects ORDER BY created_at DESC').map(toProject);
}

export function createProject(
  db: Db,
  input: { name: string; sourceId: string; slug?: string },
  actor: string,
  now: number = Date.now(),
): Project {
  return tx(db, () => {
    const source = getSource(db, input.sourceId);
    if (source.status !== 'ready') {
      throw new AniError('conflict', `Source is not ready yet (${source.status})`, {
        hint: 'Wait for the download/import job.',
      });
    }
    const taken = all<{ slug: string }>(db, 'SELECT slug FROM projects').map((r) => r.slug);
    const slug = uniqueSlug(slugify(input.slug ?? input.name, 'project'), taken);
    const id = newId('prj', now);
    run(
      db,
      `INSERT INTO projects (id, slug, name, source_id, created_at, updated_at)
       VALUES (:id, :slug, :name, :sourceId, :now, :now)`,
      { id, slug, name: input.name, sourceId: input.sourceId, now },
    );
    const project = getProject(db, id);
    appendEvent(db, {
      actor,
      kind: 'project.created',
      entityType: 'project',
      entityId: id,
      projectId: id,
      payload: { name: input.name, slug },
    });
    return project;
  });
}

export function setGenerationTier(
  db: Db,
  ref: string,
  tier: GenerationTier,
  actor: string,
  now: number = Date.now(),
): Project {
  if (!TIERS.includes(tier)) throw new AniError('usage', `Tier must be one of ${TIERS.join(', ')}`);
  return tx(db, () => {
    const project = getProject(db, ref);
    run(db, 'UPDATE projects SET generation_tier = :tier, updated_at = :now WHERE id = :id', {
      id: project.id,
      tier,
      now,
    });
    appendEvent(db, {
      actor,
      kind: 'project.tier_changed',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      payload: { tier },
    });
    return getProject(db, project.id);
  });
}
