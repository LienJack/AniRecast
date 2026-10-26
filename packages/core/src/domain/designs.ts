import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { type CastMember, listCast } from './cast.ts';
import { getCastAnalysis } from './cast-analysis.ts';
import type { InputRef, Review, Verdict, VersionStatus } from './generation.ts';
import { getReview, listReviews } from './generation.ts';
import { getPersona } from './personas.ts';
import { getProject, type Project, projectDir } from './projects.ts';
import { listReferences } from './references.ts';

/**
 * A binding (an original character of the clip → the library character replacing her) redesigned for the
 * project: the library character redrawn the way this animation draws the original, with the expressions and
 * poses the original has in the clip. Three sheets per binding, each versioned and reviewed like boards;
 * approved sheets replace the library references in boards and takes for that character.
 */
export type DesignKind = 'turnaround' | 'expressions' | 'poses';
/**
 * `original`: the original character's own model sheet (from official art and the clip), the template for
 * `replacement`: the library character redrawn in her place.
 */
export type DesignSubject = 'original' | 'replacement';
export const DESIGN_KINDS: readonly DesignKind[] = ['turnaround', 'expressions', 'poses'];

export interface Design {
  id: string;
  projectId: string;
  /** The original character this design replaces (null for designs made before bindings). */
  castMemberId: string | null;
  /** The library character drawn (null for the original character's own sheets). */
  personaId: string | null;
  subject: DesignSubject;
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
  cast_member_id: string | null;
  persona_id: string | null;
  subject: DesignSubject | null;
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
  castMemberId: r.cast_member_id,
  personaId: r.persona_id,
  subject: r.subject ?? 'replacement',
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

export interface Binding {
  castMemberId: string;
  personaId: string;
}

/** The approved sheet of one binding (the original character and the library character now replacing her). */
export function approvedDesign(
  db: Db,
  projectId: string,
  binding: Binding,
  kind: DesignKind,
): Design | undefined {
  const r = one<Row>(
    db,
    `SELECT * FROM designs WHERE project_id = :projectId AND cast_member_id = :castId AND persona_id = :personaId
       AND subject = 'replacement' AND kind = :kind AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    { projectId, castId: binding.castMemberId, personaId: binding.personaId, kind },
  );
  return r && toDesign(r);
}

/** The approved sheet of the original character herself (the template for her replacement's sheet). */
export function approvedOriginal(db: Db, castId: string, kind: DesignKind): Design | undefined {
  const r = one<Row>(
    db,
    `SELECT * FROM designs WHERE cast_member_id = :castId AND subject = 'original' AND kind = :kind
       AND status = 'approved' ORDER BY version DESC LIMIT 1`,
    { castId, kind },
  );
  return r && toDesign(r);
}

/** Where an original character's own sheets live: projects/<slug>/designs/original-<cast>/. */
export const originalDesignDir = (project: Pick<Project, 'slug'>, castId: string): string =>
  `${projectDir(project)}/designs/original-${castId}`;

/** Original characters of the project bound to a library character, oldest first. */
export function projectBindings(db: Db, projectId: string): Binding[] {
  return all<{ id: string; persona_id: string }>(
    db,
    `SELECT id, persona_id FROM cast_members WHERE project_id = :projectId AND status = 'active'
       AND persona_id IS NOT NULL ORDER BY created_at`,
    { projectId },
  ).map((r) => ({ castMemberId: r.id, personaId: r.persona_id }));
}

/**
 * A cast member id, or (for older callers and Codex) a library character: the binding(s) that use it. A design
 * id resolves to its own binding.
 */
export function resolveBindings(db: Db, projectId: string, ref: string): Binding[] {
  const cast = one<{ id: string; persona_id: string | null; project_id: string }>(
    db,
    `SELECT id, persona_id, project_id FROM cast_members WHERE id = :ref OR (project_id = :projectId AND label = :ref)`,
    { ref, projectId },
  );
  if (cast) {
    if (cast.project_id !== projectId) throw new AniError('usage', `${ref} belongs to another project`);
    if (!cast.persona_id)
      throw new AniError('conflict', 'This character is not bound to a library character yet', {
        hint: 'Bind it first (角色設計 or `anirecast cast map`).',
      });
    return [{ castMemberId: cast.id, personaId: cast.persona_id }];
  }
  const persona = getPersona(db, ref);
  const bound = projectBindings(db, projectId).filter((b) => b.personaId === persona.id);
  if (!bound.length)
    throw new AniError('conflict', `No original character in this project is bound to ${persona.name}`);
  return bound;
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
    castMemberId: string | null;
    personaId: string | null;
    subject?: DesignSubject;
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
        // Replacement sheets count per library character (one folder each); originals per original character.
        input.subject === 'original'
          ? `SELECT MAX(version) AS v FROM designs WHERE cast_member_id = :c AND subject = 'original' AND kind = :k`
          : 'SELECT MAX(version) AS v FROM designs WHERE project_id = :p AND persona_id = :q AND kind = :k',
        input.subject === 'original'
          ? { c: input.castMemberId, k: input.kind }
          : { p: input.projectId, q: input.personaId, k: input.kind },
      )?.v ?? 0) + 1;
    const id = newId('dsg', now);
    run(
      db,
      `INSERT INTO designs (id, project_id, cast_member_id, persona_id, subject, kind, version, status, prompt, model, params_json, inputs_json, parent_id, created_by, created_at)
       VALUES (:id, :projectId, :castId, :personaId, :subject, :kind, :version, 'queued', :prompt, :model, :params, :inputs, :parentId, :createdBy, :now)`,
      {
        id,
        projectId: input.projectId,
        castId: input.castMemberId,
        personaId: input.personaId,
        subject: input.subject ?? 'replacement',
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
      payload: {
        personaId: input.personaId,
        castMemberId: input.castMemberId,
        subject: input.subject ?? 'replacement',
        kind: input.kind,
        version,
      },
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
        `UPDATE designs SET status = 'ready' WHERE project_id = :p AND persona_id IS :q AND kind = :k
           AND cast_member_id IS :c AND subject = :s AND status = 'approved' AND id != :id`,
        { p: d.projectId, q: d.personaId, k: d.kind, c: d.castMemberId, s: d.subject, id: d.id },
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

/**
 * The design step of a project: every bound original character with its library character, the project note,
 * the analysis of the original and the latest / approved version of each sheet; and the characters not bound.
 */
export function designOverview(db: Db, projectId: string) {
  getProject(db, projectId);
  const active = listCast(db, projectId);
  const castInfo = (c: CastMember) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    thumbPath: c.thumbPath,
    shotCount: c.shotIds.length,
    lookPolicy: c.looks[0]?.lookPolicy ?? ('persona' as const),
  });
  const bindings = active
    .filter((c) => c.personaId)
    .map((c) => {
      const persona = getPersona(db, c.personaId as string);
      const designs = all<Row>(
        db,
        `SELECT * FROM designs WHERE project_id = :projectId AND cast_member_id = :castId AND persona_id = :personaId
         AND subject = 'replacement' ORDER BY kind, version`,
        { projectId, castId: c.id, personaId: persona.id },
      ).map((r) => ({ ...toDesign(r), reviews: listReviews(db, r.id) }));
      const originals = all<Row>(
        db,
        `SELECT * FROM designs WHERE cast_member_id = :castId AND subject = 'original' ORDER BY kind, version`,
        { castId: c.id },
      ).map((r) => ({ ...toDesign(r), reviews: listReviews(db, r.id) }));
      const sheetsOf = (list: typeof designs) =>
        DESIGN_KINDS.map((kind) => {
          const versions = list.filter((d) => d.kind === kind);
          return {
            kind,
            latest: versions.at(-1) ?? null,
            approved: versions.filter((d) => d.status === 'approved').at(-1) ?? null,
            versions,
          };
        });
      return {
        cast: castInfo(c),
        persona,
        note: designNote(db, projectId, persona.id),
        analysis: getCastAnalysis(db, c.id),
        /** 官方設定集: reference images and the original character's own sheets. */
        original: { references: listReferences(db, c.id), sheets: sheetsOf(originals) },
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
  const unbound = active.filter((c) => !c.personaId && c.shotIds.length > 0).map(castInfo);
  return { bindings, unbound };
}
