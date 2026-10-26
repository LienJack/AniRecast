import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AniError, newId } from '@anirecast/shared';
import { all, type Db, one, run } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { Workspace } from '../workspace.ts';
import { getCastMember } from './cast.ts';
import { getProject, projectDir } from './projects.ts';

/**
 * 官方設定集: reference images of an original character — official design art found on the web by the search
 * job, or pasted / uploaded by the human. Each keeps where it came from; only accepted ones feed the original
 * character's sheets. Nothing is "official" until a person accepts it.
 */
export type ReferenceStatus = 'candidate' | 'accepted' | 'rejected';

export interface CastReference {
  id: string;
  castMemberId: string;
  projectId: string;
  path: string;
  sha256: string;
  /** The image's own URL, and the page it was found on. */
  sourceUrl: string | null;
  pageUrl: string | null;
  /** What it shows ("turnaround", "expressions", "full body: café uniform" …). */
  label: string;
  /** How sure the vision check was that this is official design art of this character (0–1). */
  score: number | null;
  note: string;
  status: ReferenceStatus;
  createdBy: string;
  createdAt: number;
}

interface Row {
  id: string;
  cast_member_id: string;
  project_id: string;
  path: string;
  sha256: string;
  source_url: string | null;
  page_url: string | null;
  label: string;
  score: number | null;
  note: string;
  status: ReferenceStatus;
  created_by: string;
  created_at: number;
}

const toRef = (r: Row): CastReference => ({
  id: r.id,
  castMemberId: r.cast_member_id,
  projectId: r.project_id,
  path: r.path,
  sha256: r.sha256,
  sourceUrl: r.source_url,
  pageUrl: r.page_url,
  label: r.label,
  score: r.score,
  note: r.note,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export function listReferences(db: Db, castId: string): CastReference[] {
  return all<Row>(
    db,
    `SELECT * FROM cast_references WHERE cast_member_id = :castId
     ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, score DESC, created_at`,
    { castId },
  ).map(toRef);
}

export function getReference(db: Db, id: string): CastReference {
  const r = one<Row>(db, 'SELECT * FROM cast_references WHERE id = :id', { id });
  if (!r) throw new AniError('not_found', `Reference not found: ${id}`);
  return toRef(r);
}

const EXT: Record<string, string> = { '.png': '.png', '.jpg': '.jpg', '.jpeg': '.jpg', '.webp': '.webp' };

/** Copies an image into projects/<slug>/official/<cast>/ and records it (the same image twice is refused). */
export function addReference(
  ws: Workspace,
  castId: string,
  file: string,
  meta: {
    sourceUrl?: string | null;
    pageUrl?: string | null;
    label?: string;
    score?: number | null;
    note?: string;
    status?: ReferenceStatus;
    ext?: string;
  },
  actor: string,
  now: number = Date.now(),
): CastReference {
  const cast = getCastMember(ws.db, castId);
  const project = getProject(ws.db, cast.projectId);
  const ext = EXT[(meta.ext ?? path.extname(file)).toLowerCase()];
  if (!ext) throw new AniError('usage', 'Only PNG, JPEG or WebP images can be references');
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const dup = one<{ id: string }>(
    ws.db,
    'SELECT id FROM cast_references WHERE cast_member_id = :castId AND sha256 = :sha256',
    { castId, sha256 },
  );
  if (dup)
    throw new AniError('conflict', 'This image is already a reference of the character', {
      details: { id: dup.id },
    });
  const id = newId('ref', now);
  const rel = `${projectDir(project)}/official/${castId}/${id}${ext}`;
  mkdirSync(path.dirname(ws.abs(rel)), { recursive: true });
  copyFileSync(file, ws.abs(rel));
  run(
    ws.db,
    `INSERT INTO cast_references (id, cast_member_id, project_id, path, sha256, source_url, page_url, label, score, note, status, created_by, created_at)
     VALUES (:id, :castId, :projectId, :path, :sha256, :sourceUrl, :pageUrl, :label, :score, :note, :status, :actor, :now)`,
    {
      id,
      castId,
      projectId: project.id,
      path: rel,
      sha256,
      sourceUrl: meta.sourceUrl ?? null,
      pageUrl: meta.pageUrl ?? null,
      label: meta.label?.trim() ?? '',
      score: meta.score ?? null,
      note: meta.note?.trim() ?? '',
      status: meta.status ?? 'candidate',
      actor,
      now,
    },
  );
  appendEvent(ws.db, {
    actor,
    kind: 'cast.reference_added',
    entityType: 'cast',
    entityId: castId,
    projectId: project.id,
    payload: { id, sourceUrl: meta.sourceUrl ?? null, status: meta.status ?? 'candidate' },
  });
  return getReference(ws.db, id);
}

/** Accept, reject or reset a reference; label edits ride along. */
export function updateReference(
  db: Db,
  id: string,
  patch: { status?: ReferenceStatus; label?: string },
  actor: string,
): CastReference {
  const r = getReference(db, id);
  if (patch.status && !['candidate', 'accepted', 'rejected'].includes(patch.status))
    throw new AniError('usage', 'Status must be candidate, accepted or rejected');
  if (patch.status)
    run(db, 'UPDATE cast_references SET status = :status WHERE id = :id', { id, status: patch.status });
  if (patch.label !== undefined)
    run(db, 'UPDATE cast_references SET label = :label WHERE id = :id', { id, label: patch.label.trim() });
  appendEvent(db, {
    actor,
    kind: 'cast.reference_updated',
    entityType: 'cast',
    entityId: r.castMemberId,
    projectId: r.projectId,
    payload: { id, ...patch },
  });
  return getReference(db, id);
}
