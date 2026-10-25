import { AniError, newId } from '@anirecast/shared';
import { type Db, one, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import { getProject, type Project, projectCacheDir, projectDir } from './projects.ts';
import { getSource } from './sources.ts';

export type ClipStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface Clip {
  id: string;
  projectId: string;
  version: number;
  /** Source frame range [inFrame, outFrame). */
  inFrame: number;
  outFrame: number;
  fpsNum: number;
  fpsDen: number;
  width: number;
  height: number;
  frameCount: number;
  filePath: string | null;
  audioPath: string | null;
  proxyPath: string | null;
  status: ClipStatus;
  isActive: boolean;
  createdAt: number;
}

interface ClipRow {
  id: string;
  project_id: string;
  version: number;
  in_frame: number;
  out_frame: number;
  fps_num: number;
  fps_den: number;
  width: number;
  height: number;
  frame_count: number;
  file_path: string | null;
  audio_path: string | null;
  proxy_path: string | null;
  status: ClipStatus;
  is_active: number;
  created_at: number;
}

const toClip = (r: ClipRow): Clip => ({
  id: r.id,
  projectId: r.project_id,
  version: r.version,
  inFrame: r.in_frame,
  outFrame: r.out_frame,
  fpsNum: r.fps_num,
  fpsDen: r.fps_den,
  width: r.width,
  height: r.height,
  frameCount: r.frame_count,
  filePath: r.file_path,
  audioPath: r.audio_path,
  proxyPath: r.proxy_path,
  status: r.status,
  isActive: r.is_active === 1,
  createdAt: r.created_at,
});

const pad = (n: number) => String(n).padStart(3, '0');
export const clipDir = (p: Pick<Project, 'slug'>, version: number): string =>
  `${projectDir(p)}/clip/v${pad(version)}`;

export function getClip(db: Db, id: string): Clip {
  const row = one<ClipRow>(db, 'SELECT * FROM clips WHERE id = :id', { id });
  if (!row) throw new AniError('not_found', `Clip not found: ${id}`);
  return toClip(row);
}

export function findActiveClip(db: Db, projectId: string): Clip | undefined {
  const row = one<ClipRow>(db, 'SELECT * FROM clips WHERE project_id = :projectId AND is_active = 1', {
    projectId,
  });
  return row && toClip(row);
}

export function getActiveClip(db: Db, projectId: string): Clip {
  const clip = findActiveClip(db, projectId);
  if (!clip)
    throw new AniError('not_found', 'This project has no clip yet', {
      hint: 'Set one with `anirecast clip set`.',
    });
  return clip;
}

/** True once any shot of the clip has a board or a take; re-cutting then needs --force. */
export function clipHasGeneration(db: Db, clipId: string): boolean {
  const row = one<{ n: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM boards b JOIN shots s ON s.id = b.shot_id WHERE s.clip_id = :clipId)
          + (SELECT COUNT(*) FROM takes t JOIN shots s ON s.id = t.shot_id WHERE s.clip_id = :clipId) AS n`,
    { clipId },
  );
  return (row?.n ?? 0) > 0;
}

export function createClip(
  db: Db,
  input: { projectRef: string; inFrame: number; outFrame: number },
  actor: string,
  { force = false }: { force?: boolean } = {},
  now: number = Date.now(),
): Clip {
  return tx(db, () => {
    const project = getProject(db, input.projectRef);
    const source = getSource(db, project.sourceId);
    if (source.status !== 'ready' || !source.fpsNum || !source.fpsDen || !source.durationMs) {
      throw new AniError('conflict', 'Source is not ready');
    }
    const sourceFrames = Math.floor((source.durationMs / 1000) * (source.fpsNum / source.fpsDen));
    if (input.inFrame < 0 || input.outFrame <= input.inFrame || input.inFrame >= sourceFrames) {
      throw new AniError(
        'usage',
        `Clip range must satisfy 0 <= in < out (source has ${sourceFrames} frames)`,
      );
    }
    const outFrame = Math.min(input.outFrame, sourceFrames);
    const previous = findActiveClip(db, project.id);
    if (previous && clipHasGeneration(db, previous.id) && !force) {
      throw new AniError('conflict', 'The current clip already has generated boards or takes', {
        hint: 'Re-run with --force; the old clip, shots and versions stay as history.',
      });
    }
    const version =
      (one<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM clips WHERE project_id = :p', {
        p: project.id,
      })?.v ?? 0) + 1;
    if (previous) run(db, 'UPDATE clips SET is_active = 0 WHERE id = :id', { id: previous.id });
    const id = newId('clip', now);
    const dir = clipDir(project, version);
    run(
      db,
      `INSERT INTO clips (id, project_id, version, in_frame, out_frame, fps_num, fps_den, width, height, frame_count,
         file_path, audio_path, proxy_path, status, is_active, created_at)
       VALUES (:id, :projectId, :version, :inFrame, :outFrame, :fpsNum, :fpsDen, :width, :height, :frameCount,
         :filePath, :audioPath, :proxyPath, 'pending', 1, :now)`,
      {
        id,
        projectId: project.id,
        version,
        inFrame: input.inFrame,
        outFrame,
        fpsNum: source.fpsNum,
        fpsDen: source.fpsDen,
        width: source.width ?? 0,
        height: source.height ?? 0,
        frameCount: outFrame - input.inFrame,
        filePath: `${dir}/clip.mp4`,
        audioPath: `${dir}/audio.wav`,
        proxyPath: `${projectCacheDir(project)}/clip-v${pad(version)}.proxy.mp4`,
        now,
      },
    );
    const clip = getClip(db, id);
    appendEvent(db, {
      actor,
      kind: 'clip.created',
      entityType: 'clip',
      entityId: id,
      projectId: project.id,
      payload: { version, inFrame: clip.inFrame, outFrame: clip.outFrame, replaced: previous?.id ?? null },
    });
    return clip;
  });
}

export function setClipStatus(db: Db, id: string, status: ClipStatus, actor: string): Clip {
  return tx(db, () => {
    run(db, 'UPDATE clips SET status = :status WHERE id = :id', { id, status });
    const clip = getClip(db, id);
    appendEvent(db, {
      actor,
      kind: 'clip.updated',
      entityType: 'clip',
      entityId: id,
      projectId: clip.projectId,
      payload: { status },
    });
    return clip;
  });
}
