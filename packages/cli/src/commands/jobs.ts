import {
  actorFromEnv,
  enqueueJob,
  eventsSince,
  getJob,
  type JobStatus,
  type Lane,
  latestEventSeq,
  listJobs,
  requestCancel,
  retryJob,
  setJobsPaused,
  TERMINAL_STATUSES,
} from '@anirecast/core';
import type { Command } from 'commander';
import { type GlobalOptions, withWorkspace } from '../context.ts';
import { command } from '../output.ts';
import { unwrapJob, waitForJob } from '../wait.ts';

export function registerJobs(program: Command): void {
  const jobs = program.command('jobs').description('Background jobs run by the AniRecast daemon');
  const globals = () => program.opts<GlobalOptions>();

  jobs
    .command('pause')
    .description('全部暫停: the daemon starts no new job (queued ones wait, running ones finish)')
    .option('--reason <text>')
    .action(
      command((opts: { reason?: string }) =>
        withWorkspace(globals(), (ws) => setJobsPaused(ws, true, actorFromEnv(), opts.reason)),
      ),
    );
  jobs
    .command('resume')
    .description('Let the daemon start jobs again')
    .action(command(() => withWorkspace(globals(), (ws) => setJobsPaused(ws, false, actorFromEnv()))));
  jobs
    .command('list')
    .option('--status <status>', 'queued|running|succeeded|failed|cancelled')
    .option('--lane <lane>', 'generate|media|agent|io')
    .option('--project <id>', 'project id')
    .option('--limit <n>', 'max rows', '50')
    .action(
      command((opts: { status?: JobStatus; lane?: Lane; project?: string; limit: string }) =>
        withWorkspace(globals(), (ws) =>
          listJobs(ws.db, {
            ...(opts.status ? { status: opts.status } : {}),
            ...(opts.lane ? { lane: opts.lane } : {}),
            ...(opts.project ? { projectId: opts.project } : {}),
            limit: Number(opts.limit),
          }),
        ),
      ),
    );

  jobs
    .command('show <id>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => getJob(ws.db, id))));

  jobs
    .command('cancel <id>')
    .action(
      command((id: string) => withWorkspace(globals(), (ws) => requestCancel(ws.db, id, actorFromEnv()))),
    );

  jobs
    .command('retry <id>')
    .action(command((id: string) => withWorkspace(globals(), (ws) => retryJob(ws.db, id, actorFromEnv()))));

  jobs
    .command('wait <id>')
    .description('Block until the job finishes; prints the final job')
    .action(
      command((id: string) => withWorkspace(globals(), async (ws) => unwrapJob(await waitForJob(ws, id)))),
    );

  jobs
    .command('watch')
    .description('Stream job events as JSON lines until interrupted (or until --until-idle)')
    .option('--jsonl', 'one JSON event per line on stdout (default)')
    .option('--until-idle', 'exit once no job is queued or running')
    .action(async (opts: { untilIdle?: boolean }) => {
      await withWorkspace(globals(), async (ws) => {
        let cursor = latestEventSeq(ws.db);
        for (;;) {
          for (const e of eventsSince(ws.db, cursor)) {
            cursor = e.seq;
            if (e.entityType === 'job') process.stdout.write(`${JSON.stringify(e)}\n`);
          }
          if (opts.untilIdle) {
            const active = listJobs(ws.db, { limit: 500 }).some((j) => !TERMINAL_STATUSES.includes(j.status));
            if (!active) return;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      });
    });

  jobs
    .command('noop')
    .description('Enqueue a diagnostic job that sleeps (checks that the daemon is processing work)')
    .option('--ms <ms>', 'sleep duration', '200')
    .option('--wait', 'wait for completion')
    .action(
      command((opts: { ms: string; wait?: boolean }) =>
        withWorkspace(globals(), async (ws) => {
          const job = enqueueJob(ws.db, {
            type: 'noop',
            lane: 'io',
            payload: { ms: Number(opts.ms) },
            requestedBy: actorFromEnv(),
          });
          return opts.wait ? unwrapJob(await waitForJob(ws, job.id)) : job;
        }),
      ),
    );
}
