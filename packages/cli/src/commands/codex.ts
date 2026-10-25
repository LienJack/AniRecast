import {
  actorFromEnv,
  applyHandoff,
  closeHandoff,
  createHandoff,
  getHandoff,
  getProject,
  type HandoffTarget,
  handoffPrompt,
  listHandoffs,
  loadConfig,
  readHandoffResultFile,
  submitHandoff,
} from '@anirecast/core';
import { AniError } from '@anirecast/shared';
import type { Command } from 'commander';
import { type GlobalOptions, withWorkspace } from '../context.ts';
import { command } from '../output.ts';

const TARGET_FLAGS = ['shot', 'board', 'take', 'design', 'persona', 'cast', 'task'] as const;

/** Asks the running daemon to open the discussion's Codex thread (the daemon owns the Codex connection). */
async function openThread(id: string): Promise<{ threadId: string | null; openError: string | null }> {
  const { host, port } = loadConfig().daemon;
  try {
    const res = await fetch(`http://${host}:${port}/api/codex/${encodeURIComponent(id)}/open`, {
      method: 'POST',
    });
    const body = (await res.json()) as {
      ok: boolean;
      data?: { threadId: string | null; openError: string | null };
    };
    return body.data ?? { threadId: null, openError: `daemon answered ${res.status}` };
  } catch {
    return {
      threadId: null,
      openError: 'AniRecast daemon is not running; paste the prompt into Codex instead',
    };
  }
}

export function registerCodex(program: Command): void {
  const globals = () => program.opts<GlobalOptions>();
  const codex = program
    .command('codex')
    .description(
      'Codex discussions (Codex 討論): take a hard problem to its own Codex thread, import the conclusion',
    );

  const exp = codex
    .command('export <project>')
    .description('Write a discussion brief for the project or one thing in it and print the prompt for Codex')
    .requiredOption('--topic <text>', 'what to discuss');
  for (const flag of TARGET_FLAGS) exp.option(`--${flag} <id>`, `discuss this ${flag}`);
  exp.option('--open', 'also open it as a thread in the Codex desktop app (needs the daemon)').action(
    command(
      async (
        projectRef: string,
        opts: Partial<Record<(typeof TARGET_FLAGS)[number], string>> & { topic: string; open?: boolean },
      ) => {
        const given = TARGET_FLAGS.filter((f) => opts[f]);
        if (given.length > 1) throw new AniError('usage', `Pick one of --${given.join(', --')}`);
        const targetType: HandoffTarget = given[0] ?? 'project';
        const created = await withWorkspace(globals(), (ws) => {
          const h = createHandoff(ws, {
            projectRef,
            targetType,
            targetId: given[0] ? (opts[given[0]] as string) : null,
            topic: opts.topic,
            actor: actorFromEnv(),
          });
          return { handoff: h, folder: ws.abs(h.dir), prompt: handoffPrompt(ws, h) };
        });
        return { ...created, ...(opts.open ? await openThread(created.handoff.id) : {}) };
      },
    ),
  );

  codex
    .command('list <project>')
    .action(
      command((projectRef: string) =>
        withWorkspace(globals(), (ws) => listHandoffs(ws.db, getProject(ws.db, projectRef).id)),
      ),
    );
  codex.command('show <discussion>').action(
    command((id: string) =>
      withWorkspace(globals(), (ws) => {
        const h = getHandoff(ws.db, id);
        return { handoff: h, folder: ws.abs(h.dir), prompt: handoffPrompt(ws, h) };
      }),
    ),
  );
  codex
    .command('submit <discussion>')
    .description(
      'Hand the conclusion back (default: result.json in the discussion folder); errors list every problem',
    )
    .option('--file <path>', 'read the result from this file instead')
    .action(
      command((id: string, opts: { file?: string }) =>
        withWorkspace(globals(), (ws) => {
          const h = getHandoff(ws.db, id);
          const done = submitHandoff(ws, id, readHandoffResultFile(ws, h, opts.file), actorFromEnv());
          return {
            handoff: done,
            next: 'The human reviews and imports it on the discussion page; tell them it is ready.',
          };
        }),
      ),
    );
  codex
    .command('import <discussion>')
    .description('Apply the submitted actions (all, or --only 1,3); only a person can import')
    .option('--only <numbers>', 'comma-separated action numbers, starting at 1')
    .action(
      command((id: string, opts: { only?: string }) =>
        withWorkspace(globals(), (ws) =>
          applyHandoff(ws, id, {
            ...(opts.only ? { indices: opts.only.split(',').map((n) => Number(n.trim()) - 1) } : {}),
            actor: actorFromEnv(),
          }),
        ),
      ),
    );
  codex
    .command('close <discussion>')
    .action(
      command((id: string) => withWorkspace(globals(), (ws) => closeHandoff(ws.db, id, actorFromEnv()))),
    );
}
