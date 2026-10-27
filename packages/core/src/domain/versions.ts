import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { all, type Db, run, tx } from '../db.ts';
import { appendEvent } from '../events.ts';
import type { Workspace } from '../workspace.ts';
import { getDesign } from './designs.ts';
import { getBoard, getTake, listBoards, listTakes } from './generation.ts';
import { getProject } from './projects.ts';
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
  /** Only the shot videos (old drafts before remaking at 1080p): the storyboard frames stay. */
  opts: { takesOnly?: boolean } = {},
): { boards: number; takes: number; trash: string | null } {
  if (actor.startsWith('codex:'))
    throw new AniError('conflict', "Deleting versions is the human's decision", {
      hint: 'Ask the human, or split/merge with --force (versions turn stale and stay).',
    });
  const shot = getShot(ws.db, shotId);
  const project = projectOfShot(ws.db, shotId);
  const boards = opts.takesOnly ? [] : listBoards(ws.db, shotId);
  const takes = listTakes(ws.db, shotId);
  if (!boards.length && !takes.length) return { boards: 0, takes: 0, trash: null };
  if ([...boards, ...takes].some((v) => v.status === 'queued' || v.status === 'generating'))
    throw new AniError('conflict', 'A version of this shot is still being generated', {
      hint: 'Wait for it or cancel its job, then delete.',
    });
  const trash = `trash/versions/${project.slug}/${shot.id}-${now}${opts.takesOnly ? '-takes' : ''}`;
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
    if (!opts.takesOnly) run(ws.db, 'DELETE FROM boards WHERE shot_id = :shotId', { shotId });
    appendEvent(ws.db, {
      actor,
      kind: 'shot.versions_deleted',
      entityType: 'shot',
      entityId: shotId,
      projectId: project.id,
      payload: { boards: boards.length, takes: takes.length, trash, takesOnly: Boolean(opts.takesOnly) },
    });
  });
  return { boards: boards.length, takes: takes.length, trash };
}

/**
 * Deletes a project's failed and cancelled versions — storyboard frames, takes and design sheets that never became
 * anything usable — so version strips show only real work. Every other version stays. Files they left (a part-made
 * take, provenance) go to `trash/versions/<project>/failed-<time>/` with `versions.json` (the deleted records);
 * reviews of them go and open agent tasks about them are cancelled. A person's decision, like discarding a shot's
 * versions. `dryRun` only counts.
 */
export function pruneFailedVersions(
  ws: Workspace,
  projectRef: string,
  actor: string,
  now: number = Date.now(),
  opts: { dryRun?: boolean } = {},
): { boards: number; takes: number; designs: number; trash: string | null } {
  if (actor.startsWith('codex:'))
    throw new AniError('conflict', "Deleting versions is the human's decision", { hint: 'Ask the human.' });
  const project = getProject(ws.db, projectRef);
  const failed = (table: 'boards' | 'takes') =>
    all<{ id: string }>(
      ws.db,
      `SELECT v.id FROM ${table} v JOIN shots s ON s.id = v.shot_id JOIN clips c ON c.id = s.clip_id
       WHERE c.project_id = :projectId AND v.status = 'failed' ORDER BY v.created_at`,
      { projectId: project.id },
    ).map((r) => r.id);
  const boards = failed('boards').map((id) => getBoard(ws.db, id));
  const takes = failed('takes').map((id) => getTake(ws.db, id));
  const designs = all<{ id: string }>(
    ws.db,
    `SELECT id FROM designs WHERE project_id = :projectId AND status = 'failed' ORDER BY created_at`,
    { projectId: project.id },
  ).map((r) => getDesign(ws.db, r.id));
  const counts = { boards: boards.length, takes: takes.length, designs: designs.length };
  if (opts.dryRun || !(boards.length + takes.length + designs.length)) return { ...counts, trash: null };
  const trash = `trash/versions/${project.slug}/failed-${now}`;
  mkdirSync(ws.abs(trash), { recursive: true });
  const moved: string[] = [];
  for (const v of [...boards, ...takes, ...designs]) {
    if (!v.path) continue;
    for (const rel of [v.path, v.path.replace(/\.\w+$/, '.json')]) {
      if (!existsSync(ws.abs(rel))) continue;
      const to = path.join(ws.abs(trash), rel);
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(ws.abs(rel), to);
      moved.push(rel);
    }
  }
  writeFileSync(
    path.join(ws.abs(trash), 'versions.json'),
    `${JSON.stringify({ project: project.slug, deletedAt: new Date(now).toISOString(), actor, boards, takes, designs, files: moved }, null, 2)}\n`,
  );
  const b = placeholders(
    'b',
    boards.map((v) => v.id),
  );
  const t = placeholders(
    't',
    takes.map((v) => v.id),
  );
  const d = placeholders(
    'd',
    designs.map((v) => v.id),
  );
  const every = placeholders(
    'v',
    [...boards, ...takes, ...designs].map((v) => v.id),
  );
  tx(ws.db, () => {
    run(ws.db, `UPDATE takes SET parent_id = NULL WHERE parent_id IN (${t.list})`, t.params);
    run(ws.db, `UPDATE takes SET board_id = NULL WHERE board_id IN (${b.list})`, b.params);
    run(ws.db, `UPDATE boards SET parent_id = NULL WHERE parent_id IN (${b.list})`, b.params);
    run(ws.db, `UPDATE designs SET parent_id = NULL WHERE parent_id IN (${d.list})`, d.params);
    run(
      ws.db,
      `UPDATE agent_tasks SET review_id = NULL WHERE review_id IN (SELECT id FROM reviews WHERE target_id IN (${every.list}))`,
      every.params,
    );
    run(ws.db, `DELETE FROM reviews WHERE target_id IN (${every.list})`, every.params);
    run(
      ws.db,
      `UPDATE agent_tasks SET status = 'cancelled', updated_at = :now
       WHERE status IN ('open', 'claimed', 'needs_user') AND json_extract(payload_json, '$.targetId') IN (${every.list})`,
      { ...every.params, now },
    );
    run(ws.db, `DELETE FROM takes WHERE id IN (${t.list})`, t.params);
    run(ws.db, `DELETE FROM boards WHERE id IN (${b.list})`, b.params);
    run(ws.db, `DELETE FROM designs WHERE id IN (${d.list})`, d.params);
    appendEvent(ws.db, {
      actor,
      kind: 'project.failed_versions_deleted',
      entityType: 'project',
      entityId: project.id,
      projectId: project.id,
      payload: { ...counts, trash },
    });
  });
  return { ...counts, trash };
}
