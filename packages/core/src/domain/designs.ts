import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { InputRef, Review, Verdict, VersionStatus } from './generation.ts';
import { getReview, listReviews } from './generation.ts';
import { getPersona } from './personas.ts';
import { getProject, type Project, projectDir } from './projects.ts';

/**
 * A library character redrawn for one project in that animation's style. Three sheets per character, each
 * versioned and reviewed like boards; approved sheets replace the library references in boards and takes.
 */
export type DesignKind = 'turnaround' | 'expressions' | 'poses';
export const DESIGN_KINDS: readonly DesignKind[] = ['turnaround', 'expressions', 'poses'];

export interface Design {
  id: string;
  projectId: string;
  personaId: string;
  kind: DesignKind;
  version: number;
  status: VersionStatus;
  path: string | null;
  prompt: string;
  model: string;
  params: Record<string, unknown>;
  inputs: InputRef[];
  parentId: string | null;
  remote: Record<string, unknown>;
  error: string | null;
  costUsd: number;
  createdBy: string;
  createdAt: number;
}

interface Row {
  id: string;
  project_id: string;
  persona_id: string;
  kind: DesignKind;
  version: number;
  status: VersionStatus;
  path: string | null;
  prompt: string;
  model: string;
  params_json: string;
  inputs_json: string;
  parent_id: string | null;
  remote_json: string;
  error: string | null;
  cost_usd: number;
  created_by: string;
  created_at: number;
}

const toDesign = (r: Row): Design => ({
  id: r.id,
  projectId: r.project_id,
  personaId: r.persona_id,
  kind: r.kind,
  version: r.version,
  status: r.status,
  path: r.path,
  prompt: r.prompt,
  model: r.model,
  params: fromJson(r.params_json, {}),
  inputs: fromJson(r.inputs_json, []),
  parentId: r.parent_id,
  remote: fromJson(r.remote_json, {}),
  error: r.error,
  costUsd: r.cost_usd,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Where a project's design sheets live: projects/<slug>/designs/<persona-slug>/<kind>-v001.png. */
export const designDir = (project: Pick<Project, 'slug'>, personaSlug: string): string =>
  `${projectDir(project)}/designs/${personaSlug}`;

export function getDesign(db: Db, id: string): Design {
  const r = one<Row>(db, 'SELECT * FROM designs WHERE id = :id', { id });
  if (!r) throw new AniError('not_found', `Design not found: ${id}`);
  return toDesign(r);
}

export function listDesigns(db: Db, projectId: string, personaId?: string): Design[] {
  return all<Row>(
    db,
    `SELECT * FROM designs WHERE project_id = :projectId ${personaId ? 'AND persona_id = :personaId' : ''}
     ORDER BY persona_id, kind, version`,
    { projectId, ...(personaId ? { personaId } : {}) },
  ).map(toDesign);
}

export function approvedDesign(
  db: Db,
  projectId: string,
  personaId: string,
  kind: DesignKind,
): Design | undefined {
  const r = one<Row>(
    db,
    `SELECT * FROM designs WHERE project_id = :projectId AND persona_id = :personaId AND kind = :kind
       AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    { projectId, personaId, kind },
  );
  return r && toDesign(r);
}

/** Library characters this project swaps in: mapped cast members and per-shot overrides. */
export function projectPersonaIds(db: Db, projectId: string): string[] {
  return all<{ persona_id: string }>(
    db,
    `SELECT DISTINCT persona_id FROM cast_members WHERE project_id = :projectId AND persona_id IS NOT NULL
     UNION
     SELECT DISTINCT o.persona_id FROM shot_cast_overrides o JOIN cast_members c ON c.id = o.cast_member_id
       WHERE c.project_id = :projectId AND o.persona_id IS NOT NULL`,
    { projectId },
  ).map((r) => r.persona_id);
}

export function designNote(db: Db, projectId: string, personaId: string): string {
  return (
    one<{ note: string }>(
      db,
      'SELECT note FROM project_personas WHERE project_id = :projectId AND persona_id = :personaId',
      { projectId, personaId },
    )?.note ?? ''
  );
}

export function setDesignNote(
  db: Db,
  projectId: string,
  personaId: string,
  note: string,
  actor: string,
  now: number = Date.now(),
): string {
  run(
    db,
    `INSERT INTO project_personas (project_id, persona_id, note, updated_at) VALUES (:projectId, :personaId, :note, :now)
     ON CONFLICT (project_id, persona_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
    { projectId, personaId, note, now },
  );
  appendEvent(db, {
    actor,
    kind: 'design.note',
    entityType: 'persona',
    entityId: personaId,
    projectId,
    payload: { note },
  });
  return note;
}

export function createDesign(
  db: Db,
  input: {
    projectId: string;
    personaId: string;
    kind: DesignKind;
    prompt: string;
    model: string;
    params?: Record<string, unknown>;
    inputs?: InputRef[];
    parentId?: string | null;
    createdBy: string;
  },
  now: number = Date.now(),
): Design {
  if (!DESIGN_KINDS.includes(input.kind))
    throw new AniError('usage', `Design kind must be one of ${DESIGN_KINDS.join(', ')}`);
  return tx(db, () => {
    const version =
      (one<{ v: number | null }>(
        db,
        'SELECT MAX(version) AS v FROM designs WHERE project_id = :p AND persona_id = :q AND kind = :k',
        { p: input.projectId, q: input.personaId, k: input.kind },
      )?.v ?? 0) + 1;
    const id = newId('dsg', now);
    run(
      db,
      `INSERT INTO designs (id, project_id, persona_id, kind, version, status, prompt, model, params_json, inputs_json, parent_id, created_by, created_at)
       VALUES (:id, :projectId, :personaId, :kind, :version, 'queued', :prompt, :model, :params, :inputs, :parentId, :createdBy, :now)`,
      {
        id,
        projectId: input.projectId,
        personaId: input.personaId,
        kind: input.kind,
        version,
        prompt: input.prompt,
        model: input.model,
        params: toJson(input.params ?? {}),
        inputs: toJson(input.inputs ?? []),
        parentId: input.parentId ?? null,
        createdBy: input.createdBy,
        now,
      },
    );
    appendEvent(db, {
      actor: input.createdBy,
      kind: 'design.created',
      entityType: 'design',
      entityId: id,
      projectId: input.projectId,
      payload: { personaId: input.personaId, kind: input.kind, version },
    });
    return getDesign(db, id);
  });
}

export interface DesignPatch {
  status?: VersionStatus;
  path?: string;
  remote?: Record<string, unknown>;
  error?: string | null;
  costUsd?: number;
}

export function updateDesign(db: Db, id: string, patch: DesignPatch, actor: string): Design {
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id };
  const set = (column: string, key: string, value: string | number | null) => {
    sets.push(`${column} = :${key}`);
    params[key] = value;
  };
  if (patch.status !== undefined) set('status', 'status', patch.status);
  if (patch.path !== undefined) set('path', 'path', patch.path);
  if (patch.remote !== undefined) set('remote_json', 'remote', toJson(patch.remote));
  if (patch.error !== undefined) set('error', 'error', patch.error);
  if (patch.costUsd !== undefined) set('cost_usd', 'cost', patch.costUsd);
  if (sets.length) run(db, `UPDATE designs SET ${sets.join(', ')} WHERE id = :id`, params);
  const d = getDesign(db, id);
  appendEvent(db, {
    actor,
    kind: 'design.updated',
    entityType: 'design',
    entityId: id,
    projectId: d.projectId,
    payload: { status: d.status, kind: d.kind, personaId: d.personaId },
  });
  return d;
}

/**
 * Approve (the human only; one approved version per character and sheet), request changes (rejects it; the
 * caller hands the comment to Codex) or just record a regenerate request.
 */
export function reviewDesign(
  db: Db,
  input: { designId: string; verdict: Verdict; comment?: string | null; createdBy: string },
  now: number = Date.now(),
): Review {
  return tx(db, () => {
    const d = getDesign(db, input.designId);
    if (input.verdict === 'keep_original') throw new AniError('usage', 'A design has no original to keep');
    if (input.verdict === 'approve') {
      if (!['ready', 'approved', 'stale'].includes(d.status))
        throw new AniError('conflict', `Only a finished design can be approved (this one is ${d.status})`);
      if (input.createdBy.startsWith('codex:'))
        throw new AniError('conflict', 'Approval is a human decision; Codex can recommend but not approve');
      run(
        db,
        `UPDATE designs SET status = 'ready' WHERE project_id = :p AND persona_id = :q AND kind = :k
           AND status = 'approved' AND id != :id`,
        { p: d.projectId, q: d.personaId, k: d.kind, id: d.id },
      );
      run(db, `UPDATE designs SET status = 'approved' WHERE id = :id`, { id: d.id });
    } else if (input.verdict === 'changes') {
      if (!input.comment?.trim()) throw new AniError('usage', 'Requesting changes needs a comment');
      run(db, `UPDATE designs SET status = 'rejected' WHERE id = :id`, { id: d.id });
    }
    const id = newId('rev', now);
    run(
      db,
      `INSERT INTO reviews (id, target_type, target_id, verdict, comment, annotations_json, created_by, created_at)
       VALUES (:id, 'design', :targetId, :verdict, :comment, '[]', :createdBy, :now)`,
      {
        id,
        targetId: d.id,
        verdict: input.verdict,
        comment: input.comment ?? null,
        createdBy: input.createdBy,
        now,
      },
    );
    appendEvent(db, {
      actor: input.createdBy,
      kind: 'review.created',
      entityType: 'design',
      entityId: d.id,
      projectId: d.projectId,
      payload: { reviewId: id, verdict: input.verdict, personaId: d.personaId, kind: d.kind },
    });
    return getReview(db, id);
  });
}

/** Per character: its note and the latest and approved version of each sheet. */
export function designOverview(db: Db, projectId: string) {
  getProject(db, projectId);
  return projectPersonaIds(db, projectId).map((personaId) => {
    const persona = getPersona(db, personaId);
    const designs = listDesigns(db, projectId, personaId).map((d) => ({
      ...d,
      reviews: listReviews(db, d.id),
    }));
    return {
      persona,
      note: designNote(db, projectId, personaId),
      sheets: DESIGN_KINDS.map((kind) => {
        const versions = designs.filter((d) => d.kind === kind);
        return {
          kind,
          latest: versions.at(-1) ?? null,
          approved: versions.filter((d) => d.status === 'approved').at(-1) ?? null,
          versions,
        };
      }),
    };
  });
}
