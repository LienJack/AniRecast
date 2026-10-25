import {
  assertDaemonAlive,
  daemonStatus,
  getJob,
  type Job,
  TERMINAL_STATUSES,
  type Workspace,
} from '@anirecast/core';
import { AniError } from '@anirecast/shared';
import { note } from './output.ts';

/** Polls the job row until it finishes, echoing progress to stderr. Requires a live daemon. */
export async function waitForJob(
  ws: Workspace,
  jobId: string,
  { pollMs = 300, quiet = false } = {},
): Promise<Job> {
  assertDaemonAlive(ws.db);
  let lastLine = '';
  for (;;) {
    const job = getJob(ws.db, jobId);
    if (!quiet) {
      const line = `${job.type} ${job.status} ${Math.round(job.progress * 100)}%${job.message ? ` ${job.message}` : ''}`;
      if (line !== lastLine) note(line);
      lastLine = line;
    }
    if (TERMINAL_STATUSES.includes(job.status)) return job;
    if (!daemonStatus(ws.db).alive) {
      throw new AniError('daemon_not_running', `AniRecast 服務在等待中停止了，任務 ${jobId} 仍在佇列`, {
        hint: 'Restart it with `anirecast serve`; the job resumes automatically.',
      });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Throws the job's own error when it did not succeed, so `--wait` failures surface as CLI errors. */
export function unwrapJob(job: Job): Job {
  if (job.status === 'succeeded') return job;
  throw new AniError(job.error?.code ?? 'internal', job.error?.message ?? `Job ${job.id} ${job.status}`, {
    details: { job },
    ...(job.error?.hint ? { hint: job.error.hint } : {}),
  });
}
