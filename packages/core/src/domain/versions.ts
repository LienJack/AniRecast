import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { type Db, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { Workspace } from '../workspace.ts';
import { listBoards, listTakes } from './generation.ts';
import { getShot, projectOfShot } from './shots.ts';

const placeholders = (prefix: string, ids: string[]) => {
  const params: Record<string, string> = {};
  const names = ids.map((id, i) => {
    params[`${prefix}${i}`] = id;
    return `:${prefix}${i}`;
  });
  return { list: names.join(', ') || 'NULL', params };
};

/** How many storyboard frames and takes a shot has (any status). */
export function shotVersionCount(db: Db, shotId: string): { boards: number; takes: number } {
  return { boards: listBoards(db, shotId).length, takes: listTakes(db, shotId).length };
}

/**
 * Deletes every storyboard frame and take of a shot so it can be split or merged freely. The files move to
 * `trash/versions/<project>/<shot>-<time>/` together with `versions.json` (the deleted records), so nothing is
 * lost for good; reviews of those versions go, open agent tasks about them are cancelled. A person's decision:
 * Codex cannot do it, and nothing may still be generating.
 */
export function discardShotVersions(
  ws: Workspace,
  shotId: string,
  actor: string,
  now: number = Date.now(),
): { boards: number; takes: number; trash: string | null } {
  if (actor.startsWith('codex:'))
    throw new AniError('conflict', "Deleting versions is the human's decision", {
      hint: 'Ask the human, or split/merge with --force (versions turn stale and stay).',
    });
  const shot = getShot(ws.db, shotId);
  const project = projectOfShot(ws.db, shotId);
  const boards = listBoards(ws.db, shotId);
  const takes = listTakes(ws.db, shotId);
  if (!boards.length && !takes.length) return { boards: 0, takes: 0, trash: null };
  if ([...boards, ...takes].some((v) => v.status === 'queued' || v.status === 'generating'))
    throw new AniError('conflict', 'A version of this shot is still being generated', {
      hint: 'Wait for it or cancel its job, then delete.',
    });
  const trash = `trash/versions/${project.slug}/${shot.id}-${now}`;
  mkdirSync(ws.abs(trash), { recursive: true });
  // Files: each version, its provenance JSON next to it, and a take's review compare clip.
  const files = new Set<string>();
  for (const v of [...boards, ...takes]) {
    if (!v.path) continue;
    files.add(v.path);
    files.add(v.path.replace(/\.\w+$/, '.json'));
  }
  const moved: string[] = [];
  for (const rel of files) {
    if (!existsSync(ws.abs(rel))) continue;
    const to = path.join(ws.abs(trash), rel);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(ws.abs(rel), to);
    moved.push(rel);
  }
  writeFileSync(
    path.join(ws.abs(trash), 'versions.json'),
    `${JSON.stringify({ shotId: shot.id, project: project.slug, deletedAt: new Date(now).toISOString(), actor, boards, takes, files: moved }, null, 2)}\n`,
  );
  const boardIds = boards.map((b) => b.id);
  const takeIds = takes.map((t) => t.id);
  const b = placeholders('b', boardIds);
  const t = placeholders('t', takeIds);
  const all = placeholders('v', [...boardIds, ...takeIds]);
  tx(ws.db, () => {
    // Other shots' versions may point at these (after earlier merges): drop the links, keep the versions.
    run(ws.db, `UPDATE takes SET parent_id = NULL WHERE parent_id IN (${t.list})`, t.params);
    run(ws.db, `UPDATE takes SET board_id = NULL WHERE board_id IN (${b.list})`, b.params);
    run(ws.db, `UPDATE boards SET parent_id = NULL WHERE parent_id IN (${b.list})`, b.params);
    // Tasks born from those reviews keep their history but lose the link (the reviews go).
    run(
      ws.db,
      `UPDATE agent_tasks SET review_id = NULL WHERE review_id IN (SELECT id FROM reviews WHERE target_id IN (${all.list}))`,
      all.params,
    );
    run(ws.db, `DELETE FROM reviews WHERE target_id IN (${all.list})`, all.params);
    run(
      ws.db,
      `UPDATE agent_tasks SET status = 'cancelled', updated_at = :now
       WHERE status IN ('open', 'claimed', 'needs_user') AND json_extract(payload_json, '$.targetId') IN (${all.list})`,
      { ...all.params, now },
    );
    run(ws.db, 'DELETE FROM takes WHERE shot_id = :shotId', { shotId });
    run(ws.db, 'DELETE FROM boards WHERE shot_id = :shotId', { shotId });
    appendEvent(ws.db, {
      actor,
      kind: 'shot.versions_deleted',
      entityType: 'shot',
      entityId: shotId,
      projectId: project.id,
      payload: { boards: boards.length, takes: takes.length, trash },
    });
  });
  return { boards: boards.length, takes: takes.length, trash };
}
