import path from 'node:path';
import {
  type AssetKind,
  actorFromEnv,
  addPersonaImage,
  assignTracklet,
  createPersona,
  enqueueJob,
  getCastMember,
  getPersona,
  getProject,
  type LookPolicy,
  listCast,
  listPersonas,
  listTextOverlays,
  mapCast,
  markNotCharacter,
  mergeCast,
  type OverlayCategory,
  type PersonaView,
  projectOfShot,
  recomputeShotModes,
  renameCast,
  setLookPolicy,
  setOverlayRemoval,
  setPrimaryImage,
  setShotCastOverride,
  settleCast,
  splitCast,
  updatePersona,
  updatePersonaImage,
  type Workspace,
} from '@anirecast/core';
import { probe } from '@anirecast/media';
import { AniError } from '@anirecast/shared';
import type { Command } from 'commander';
import { type GlobalOptions, withWorkspace } from '../context.ts';
import { command } from '../output.ts';
import { unwrapJob, waitForJob } from '../wait.ts';

async function imageSize(file: string): Promise<{ width: number | null; height: number | null }> {
  try {
    const p = await probe(file);
    return { width: p.width, height: p.height };
  } catch {
    return { width: null, height: null };
  }
}

const decision = (opts: { reason?: string; confidence?: string }) => ({
  ...(opts.reason ? { reason: opts.reason } : {}),
  ...(opts.confidence ? { confidence: Number(opts.confidence) } : {}),
});

const settle = (ws: Workspace, projectId: string, staleShots: string[], reason: string) =>
  settleCast(ws, projectId, staleShots, reason, actorFromEnv());

export function registerCast(program: Command): void {
  const globals = () => program.opts<GlobalOptions>();

  const persona = program
    .command('persona')
    .description('Shared persona library (公共素材庫); anime-style references only');
  persona
    .command('add')
    .requiredOption('--name <name>', 'display name')
    .option('--description <text>', 'appearance, outfit, distinguishing features')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--ref <file...>', 'reference image(s); the first becomes primary (full-body outfit recommended)')
    .option('--view <view>', 'view of the first --ref: front|side|back|face|full|sheet|other', 'full')
    .option('--kind <kind>', 'character (default), item or scene', 'character')
    .action(
      command(
        (opts: {
          name: string;
          description?: string;
          tags?: string;
          ref?: string[];
          view: PersonaView;
          kind: AssetKind;
        }) =>
          withWorkspace(globals(), async (ws) => {
            let p = createPersona(
              ws,
              {
                name: opts.name,
                kind: opts.kind,
                ...(opts.description ? { description: opts.description } : {}),
                ...(opts.tags ? { tags: opts.tags.split(',').map((t) => t.trim()) } : {}),
              },
              actorFromEnv(),
            );
            for (const [i, file] of (opts.ref ?? []).entries()) {
              const abs = path.resolve(file);
              p = addPersonaImage(
                ws,
                p.id,
                abs,
                { view: i === 0 ? opts.view : 'other', ...(await imageSize(abs)) },
                actorFromEnv(),
              );
            }
            return p;
          }),
      ),
    );
  persona
    .command('list')
    .option('--archived', 'include archived')
    .option('--kind <kind>', 'only character, item or scene entries')
    .action(
      command((opts: { archived?: boolean; kind?: AssetKind }) =>
        withWorkspace(globals(), (ws) =>
          listPersonas(ws.db, {
            includeArchived: Boolean(opts.archived),
            ...(opts.kind ? { kind: opts.kind } : {}),
          }),
        ),
      ),
    );
  persona
    .command('show <persona>')
    .action(command((ref: string) => withWorkspace(globals(), (ws) => getPersona(ws.db, ref))));
  persona
    .command('edit <persona>')
    .option('--name <name>')
    .option('--description <text>')
    .option('--tags <tags>')
    .action(
      command((ref: string, opts: { name?: string; description?: string; tags?: string }) =>
        withWorkspace(globals(), (ws) =>
          updatePersona(
            ws,
            ref,
            {
              ...(opts.name ? { name: opts.name } : {}),
              ...(opts.description ? { description: opts.description } : {}),
              ...(opts.tags ? { tags: opts.tags.split(',').map((t) => t.trim()) } : {}),
            },
            actorFromEnv(),
          ),
        ),
      ),
    );
  persona
    .command('archive <persona>')
    .action(
      command((ref: string) =>
        withWorkspace(globals(), (ws) => updatePersona(ws, ref, { archived: true }, actorFromEnv())),
      ),
    );
  persona
    .command('image-add <persona> <file>')
    .option('--view <view>', 'front|side|back|face|full|sheet|other', 'other')
    .option('--primary', 'make it the primary reference')
    .option('--label <text>', 'what the image shows, e.g. "P03 表情範圍"; used to pick references')
    .action(
      command((ref: string, file: string, opts: { view: PersonaView; primary?: boolean; label?: string }) =>
        withWorkspace(globals(), async (ws) => {
          const abs = path.resolve(file);
          return addPersonaImage(
            ws,
            ref,
            abs,
            {
              view: opts.view,
              ...(opts.primary ? { primary: true } : {}),
              ...(opts.label ? { label: opts.label } : {}),
              ...(await imageSize(abs)),
            },
            actorFromEnv(),
          );
        }),
      ),
    );
  persona
    .command('image-update <imageId>')
    .description('Change the caption or view of a reference image')
    .option('--label <text>', 'caption')
    .option('--view <view>', 'front|side|back|face|full|sheet|other')
    .action(
      command((id: string, opts: { label?: string; view?: PersonaView }) =>
        withWorkspace(globals(), (ws) =>
          updatePersonaImage(
            ws,
            id,
            {
              ...(opts.label !== undefined ? { label: opts.label } : {}),
              ...(opts.view ? { view: opts.view } : {}),
            },
            actorFromEnv(),
          ),
        ),
      ),
    );
  persona
    .command('set-primary <imageId>')
    .action(
      command((id: string) => withWorkspace(globals(), (ws) => setPrimaryImage(ws, id, actorFromEnv()))),
    );

  const cast = program
    .command('cast')
    .description('Project cast table and same-person identification (角色表)');
  cast
    .command('list <project>')
    .action(
      command((ref: string) => withWorkspace(globals(), (ws) => listCast(ws.db, getProject(ws.db, ref).id))),
    );
  cast
    .command('show <cast>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => getCastMember(ws.db, id))));
  cast
    .command('analyze <project>')
    .description('Re-run same-person identification (new shots only; --redetect for every shot)')
    .option('--redetect', 'detect characters again in every shot (decided appearances are kept)')
    .option('--wait')
    .action(
      command((ref: string, opts: { redetect?: boolean; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const project = getProject(ws.db, ref);
          const job = enqueueJob(ws.db, {
            type: 'cast.identify',
            lane: 'media',
            projectId: project.id,
            payload: { projectId: project.id, redetect: Boolean(opts.redetect) },
            requestedBy: actorFromEnv(),
          });
          return opts.wait ? unwrapJob(await waitForJob(ws, job.id)) : job;
        }),
      ),
    );
  cast
    .command('map <cast>')
    .description('Replace this character with a persona everywhere it appears, or keep the original')
    .option('--persona <persona>', 'persona id or slug')
    .option('--keep', 'do not replace this character')
    .action(
      command((castId: string, opts: { persona?: string; keep?: boolean }) =>
        withWorkspace(globals(), (ws) => {
          if (Boolean(opts.persona) === Boolean(opts.keep))
            throw new AniError('usage', 'Pass exactly one of --persona or --keep');
          const { cast: c, affectedShotIds } = mapCast(
            ws.db,
            castId,
            opts.keep ? null : (opts.persona ?? null),
            actorFromEnv(),
          );
          return { cast: c, ...settle(ws, c.projectId, affectedShotIds, 'persona mapping changed') };
        }),
      ),
    );
  cast
    .command('rename <cast> <label>')
    .action(
      command((id: string, label: string) =>
        withWorkspace(globals(), (ws) => renameCast(ws.db, id, label, actorFromEnv())),
      ),
    );
  cast
    .command('merge <keep> <drop>')
    .description('Same person: fold <drop> into <keep>')
    .option('--reason <text>', 'why (shown in the cast page; required for Codex)')
    .option('--confidence <0..1>')
    .action(
      command((keep: string, drop: string, opts: { reason?: string; confidence?: string }) =>
        withWorkspace(globals(), (ws) => {
          const before = getCastMember(ws.db, drop).shotIds;
          const merged = mergeCast(ws.db, keep, drop, actorFromEnv(), decision(opts));
          return { cast: merged, ...settle(ws, merged.projectId, before, 'cast merged') };
        }),
      ),
    );
  cast
    .command('split <cast>')
    .description('Different people: move the given appearances to a new cast member')
    .requiredOption('--tracklets <ids>', 'comma-separated tracklet ids')
    .requiredOption('--label <label>', 'label of the new cast member')
    .option('--reason <text>')
    .option('--confidence <0..1>')
    .action(
      command(
        (castId: string, opts: { tracklets: string; label: string; reason?: string; confidence?: string }) =>
          withWorkspace(globals(), (ws) => {
            const ids = opts.tracklets.split(',').map((s) => s.trim());
            const created = splitCast(ws.db, castId, ids, opts.label, actorFromEnv(), decision(opts));
            return { cast: created, ...settle(ws, created.projectId, created.shotIds, 'cast split') };
          }),
      ),
    );
  cast
    .command('assign <tracklet>')
    .description('Move one appearance to another cast member (user moves lock; Codex cannot undo them)')
    .requiredOption('--to <cast>', 'target cast member id')
    .option('--reason <text>')
    .option('--confidence <0..1>')
    .action(
      command((trackletId: string, opts: { to: string; reason?: string; confidence?: string }) =>
        withWorkspace(globals(), (ws) => {
          const t = assignTracklet(ws.db, trackletId, opts.to, actorFromEnv(), decision(opts));
          return {
            tracklet: t,
            ...settle(ws, getCastMember(ws.db, opts.to).projectId, [t.shotId], 'appearance reassigned'),
          };
        }),
      ),
    );
  cast
    .command('not-character <tracklet>')
    .description('Mark a detection as not a character (false positive)')
    .option('--reason <text>')
    .action(
      command((trackletId: string, opts: { reason?: string }) =>
        withWorkspace(globals(), (ws) => {
          const t = markNotCharacter(ws.db, trackletId, actorFromEnv(), decision(opts));
          return {
            tracklet: t,
            ...settle(ws, projectOfShot(ws.db, t.shotId).id, [t.shotId], 'detection dismissed'),
          };
        }),
      ),
    );
  cast
    .command('look-policy <look> <policy>')
    .description('persona: wear the persona outfit and hairstyle (default); follow_source: keep this look')
    .action(
      command((lookId: string, policy: LookPolicy) =>
        withWorkspace(globals(), (ws) => {
          if (policy !== 'persona' && policy !== 'follow_source')
            throw new AniError('usage', 'Policy must be persona or follow_source');
          return setLookPolicy(ws.db, lookId, policy, actorFromEnv());
        }),
      ),
    );
  cast
    .command('override <shot> <cast>')
    .description('Per-shot exception to the project-wide mapping')
    .option('--persona <persona>', 'use this persona in this shot')
    .option('--keep', 'keep the original character in this shot')
    .option('--clear', 'remove the exception')
    .action(
      command((shotId: string, castId: string, opts: { persona?: string; keep?: boolean; clear?: boolean }) =>
        withWorkspace(globals(), (ws) => {
          const override = opts.clear
            ? null
            : {
                personaId: opts.persona ? getPersona(ws.db, opts.persona).id : null,
                keep: Boolean(opts.keep),
              };
          setShotCastOverride(ws.db, shotId, castId, override, actorFromEnv());
          return settle(ws, projectOfShot(ws.db, shotId).id, [shotId], 'per-shot override changed');
        }),
      ),
    );

  const shots = program.commands.find((c) => c.name() === 'shots');
  if (!shots) throw new Error('register media commands before cast commands');
  shots
    .command('overlays <shot>')
    .description('Detected overlaid text of a shot')
    .action(command((shotId: string) => withWorkspace(globals(), (ws) => listTextOverlays(ws.db, shotId))));
  shots
    .command('overlay <overlayId>')
    .description('Change whether an overlay is removed, or fix its category')
    .option('--remove <bool>', 'true|false')
    .option('--category <category>', 'staff_credit|title_or_other|in_scene')
    .action(
      command((overlayId: string, opts: { remove?: string; category?: OverlayCategory }) =>
        withWorkspace(globals(), (ws) => {
          const o = setOverlayRemoval(
            ws.db,
            overlayId,
            {
              ...(opts.remove ? { remove: opts.remove === 'true' } : {}),
              ...(opts.category ? { category: opts.category } : {}),
            },
            actorFromEnv(),
          );
          return {
            overlay: o,
            ...settle(ws, projectOfShot(ws.db, o.shotId).id, [o.shotId], 'overlay decision changed'),
          };
        }),
      ),
    );
  shots
    .command('analyze <project>')
    .description('Flash pass: overlaid text (credits), character attributes and descriptions')
    .option('--wait')
    .action(
      command((ref: string, opts: { wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const project = getProject(ws.db, ref);
          const job = enqueueJob(ws.db, {
            type: 'shots.analyze',
            lane: 'generate',
            projectId: project.id,
            payload: { projectId: project.id },
            requestedBy: actorFromEnv(),
          });
          return opts.wait ? unwrapJob(await waitForJob(ws, job.id)) : job;
        }),
      ),
    );
  shots
    .command('modes <project>')
    .description('Recompute automatic shot modes (replace / clean / keep)')
    .action(
      command((ref: string) =>
        withWorkspace(globals(), (ws) =>
          recomputeShotModes(ws.db, getProject(ws.db, ref).id, actorFromEnv()),
        ),
      ),
    );
}
