import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError, newId } from '@anirecast/shared';
import { all, type Db, fromJson, one, run, toJson, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { slugify, uniqueSlug } from '../naming.ts';
import type { Workspace } from '../workspace.ts';

export type PersonaView = 'front' | 'side' | 'back' | 'face' | 'full' | 'sheet' | 'other';
export const PERSONA_VIEWS: readonly PersonaView[] = [
  'front',
  'side',
  'back',
  'face',
  'full',
  'sheet',
  'other',
];
/** Nano Banana 2.1 takes at most 5 character images per request, so more references per persona are not useful. */
export const MAX_PERSONA_IMAGES = 5;

export interface PersonaImage {
  id: string;
  personaId: string;
  path: string;
  view: PersonaView;
  isPrimary: boolean;
  width: number | null;
  height: number | null;
  sha256: string;
}

/** What a library entry is: a character (persona to swap in), an item or a scene. */
export type AssetKind = 'character' | 'item' | 'scene';
export const ASSET_KINDS: readonly AssetKind[] = ['character', 'item', 'scene'];

export interface Persona {
  id: string;
  slug: string;
  kind: AssetKind;
  name: string;
  description: string;
  tags: string[];
  archived: boolean;
  images: PersonaImage[];
  createdAt: number;
  updatedAt: number;
}

interface PersonaRow {
  id: string;
  slug: string;
  kind: AssetKind;
  name: string;
  description: string;
  tags_json: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

interface ImageRow {
  id: string;
  persona_id: string;
  path: string;
  view: PersonaView;
  is_primary: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

export const personaDir = (slug: string): string => `library/personas/${slug}`;

function images(db: Db, personaId: string): PersonaImage[] {
  return all<ImageRow>(
    db,
    'SELECT * FROM persona_images WHERE persona_id = :personaId ORDER BY is_primary DESC, created_at',
    {
      personaId,
    },
  ).map((r) => ({
    id: r.id,
    personaId: r.persona_id,
    path: r.path,
    view: r.view,
    isPrimary: r.is_primary === 1,
    width: r.width,
    height: r.height,
    sha256: r.sha256,
  }));
}

const toPersona = (db: Db, r: PersonaRow): Persona => ({
  id: r.id,
  slug: r.slug,
  kind: r.kind,
  name: r.name,
  description: r.description,
  tags: fromJson(r.tags_json, []),
  archived: r.archived === 1,
  images: images(db, r.id),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getPersona(db: Db, ref: string): Persona {
  const row = one<PersonaRow>(db, 'SELECT * FROM personas WHERE id = :ref OR slug = :ref COLLATE NOCASE', {
    ref,
  });
  if (!row) throw new AniError('not_found', `Persona not found: ${ref}`);
  return toPersona(db, row);
}

export function listPersonas(
  db: Db,
  { includeArchived = false, kind }: { includeArchived?: boolean; kind?: AssetKind } = {},
): Persona[] {
  const where = [includeArchived ? '' : 'archived = 0', kind ? 'kind = :kind' : ''].filter(Boolean);
  return all<PersonaRow>(
    db,
    `SELECT * FROM personas ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`,
    kind ? { kind } : {},
  ).map((r) => toPersona(db, r));
}

/** Human-readable mirror next to the reference images (rebuildable from the database). */
function writeMirror(ws: Workspace, persona: Persona): void {
  const dir = ws.abs(personaDir(persona.slug));
  mkdirSync(dir, { recursive: true });
  const { images: imgs, ...rest } = persona;
  writeFileSync(
    path.join(dir, 'persona.json'),
    `${JSON.stringify({ ...rest, images: imgs.map(({ personaId: _p, ...i }) => i) }, null, 2)}\n`,
  );
}

export function createPersona(
  ws: Workspace,
  input: { name: string; description?: string; tags?: string[]; slug?: string; kind?: AssetKind },
  actor: string,
  now: number = Date.now(),
): Persona {
  const kind = input.kind ?? 'character';
  if (!ASSET_KINDS.includes(kind))
    throw new AniError('usage', `Kind must be one of ${ASSET_KINDS.join(', ')}`);
  const persona = tx(ws.db, () => {
    const taken = all<{ slug: string }>(ws.db, 'SELECT slug FROM personas').map((r) => r.slug);
    const slug = uniqueSlug(slugify(input.slug ?? input.name, 'persona'), taken);
    const id = newId('per', now);
    run(
      ws.db,
      `INSERT INTO personas (id, slug, kind, name, description, tags_json, created_at, updated_at)
       VALUES (:id, :slug, :kind, :name, :description, :tags, :now, :now)`,
      {
        id,
        slug,
        kind,
        name: input.name,
        description: input.description ?? '',
        tags: toJson(input.tags ?? []),
        now,
      },
    );
    appendEvent(ws.db, {
      actor,
      kind: 'persona.created',
      entityType: 'persona',
      entityId: id,
      payload: { name: input.name, slug, kind },
    });
    return getPersona(ws.db, id);
  });
  writeMirror(ws, persona);
  return persona;
}

export function updatePersona(
  ws: Workspace,
  ref: string,
  patch: { name?: string; description?: string; tags?: string[]; archived?: boolean },
  actor: string,
  now: number = Date.now(),
): Persona {
  const persona = tx(ws.db, () => {
    const p = getPersona(ws.db, ref);
    run(
      ws.db,
      `UPDATE personas SET name = :name, description = :description, tags_json = :tags, archived = :archived, updated_at = :now
       WHERE id = :id`,
      {
        id: p.id,
        name: patch.name ?? p.name,
        description: patch.description ?? p.description,
        tags: toJson(patch.tags ?? p.tags),
        archived: (patch.archived ?? p.archived) ? 1 : 0,
        now,
      },
    );
    appendEvent(ws.db, {
      actor,
      kind: 'persona.updated',
      entityType: 'persona',
      entityId: p.id,
      payload: { fields: Object.keys(patch) },
    });
    return getPersona(ws.db, p.id);
  });
  writeMirror(ws, persona);
  return persona;
}

/** Copies a reference image into the library. The first image becomes primary. */
export function addPersonaImage(
  ws: Workspace,
  ref: string,
  file: string,
  opts: { view?: PersonaView; primary?: boolean; width?: number | null; height?: number | null },
  actor: string,
  now: number = Date.now(),
): Persona {
  const p = getPersona(ws.db, ref);
  if (p.images.length >= MAX_PERSONA_IMAGES) {
    throw new AniError('conflict', `A persona can have at most ${MAX_PERSONA_IMAGES} reference images`);
  }
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
    throw new AniError('usage', `Unsupported image type: ${ext}`);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (p.images.some((i) => i.sha256 === sha256))
    throw new AniError('conflict', 'This image is already a reference of the persona');
  const id = newId('img', now);
  const rel = `${personaDir(p.slug)}/refs/${id}${ext === '.jpeg' ? '.jpg' : ext}`;
  mkdirSync(path.dirname(ws.abs(rel)), { recursive: true });
  copyFileSync(file, ws.abs(rel));
  const persona = tx(ws.db, () => {
    const makePrimary = opts.primary ?? p.images.length === 0;
    if (makePrimary)
      run(ws.db, 'UPDATE persona_images SET is_primary = 0 WHERE persona_id = :id', { id: p.id });
    run(
      ws.db,
      `INSERT INTO persona_images (id, persona_id, path, view, is_primary, width, height, sha256, created_at)
       VALUES (:id, :personaId, :path, :view, :primary, :width, :height, :sha256, :now)`,
      {
        id,
        personaId: p.id,
        path: rel,
        view: opts.view ?? 'other',
        primary: makePrimary ? 1 : 0,
        width: opts.width ?? null,
        height: opts.height ?? null,
        sha256,
        now,
      },
    );
    run(ws.db, 'UPDATE personas SET updated_at = :now WHERE id = :id', { id: p.id, now });
    appendEvent(ws.db, {
      actor,
      kind: 'persona.image_added',
      entityType: 'persona',
      entityId: p.id,
      payload: { imageId: id, view: opts.view ?? 'other' },
    });
    return getPersona(ws.db, p.id);
  });
  writeMirror(ws, persona);
  return persona;
}

export function setPrimaryImage(ws: Workspace, imageId: string, actor: string): Persona {
  const row = one<{ persona_id: string }>(
    ws.db,
    'SELECT persona_id FROM persona_images WHERE id = :imageId',
    { imageId },
  );
  if (!row) throw new AniError('not_found', `Image not found: ${imageId}`);
  const persona = tx(ws.db, () => {
    run(ws.db, 'UPDATE persona_images SET is_primary = (id = :imageId) WHERE persona_id = :personaId', {
      imageId,
      personaId: row.persona_id,
    });
    appendEvent(ws.db, {
      actor,
      kind: 'persona.updated',
      entityType: 'persona',
      entityId: row.persona_id,
      payload: { primaryImage: imageId },
    });
    return getPersona(ws.db, row.persona_id);
  });
  writeMirror(ws, persona);
  return persona;
}
