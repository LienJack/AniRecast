import {
  claimNextJob,
  completeJob,
  failJob,
  getJob,
  type Job,
  type Lane,
  type LocalConfig,
  markCancelled,
  updateJobProgress,
  type Workspace,
} from '@anirecast/core';
import type { Provider } from '@anirecast/providers';
import { AniError, toEnvelopeError } from '@anirecast/shared';

/** Long-lived dependencies handed to every job (provider, config). */
export interface Services {
  config: LocalConfig;
  provider: Provider;
}

export interface JobContext {
  workspace: Workspace;
  job: Job;
  services: Services;
  /** Aborted when the job is cancelled or the daemon shuts down. */
  signal: AbortSignal;
  progress: (fraction: number, message?: string) => void;
  log: (message: string) => void;
}

export interface JobOutcome {
  result: unknown;
  costUsd?: number;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface RunnerOptions {
  workspace: Workspace;
  services: Services;
  handlers: Map<string, JobHandler>;
  concurrency: Record<Lane, number>;
  /** Job types with their own cap inside their lane (shot videos: one at a time). */
  typeLimits?: Record<string, number>;
  workerId: string;
  pollMs?: number;
  log?: (message: string) => void;
}

interface Running {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
}

/** Errors a handler can throw that are worth retrying automatically. */
const RETRYABLE = new Set(['transient', 'daemon_not_running']);

export class JobRunner {
  private readonly opts: Required<Omit<RunnerOptions, 'log'>> & { log: (m: string) => void };
  private readonly running = new Map<string, Running>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(options: RunnerOptions) {
    this.opts = { pollMs: 250, log: () => {}, typeLimits: {}, ...options };
  }

  start(): void {
    const tick = (): void => {
      if (this.stopping) return;
      try {
        this.checkCancellations();
        this.fill();
      } catch (error) {
        this.opts.log(`runner tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.timer = setTimeout(tick, this.opts.pollMs);
    };
    tick();
  }

  /** Stops claiming new work, aborts running jobs and waits for them to settle. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    for (const r of this.running.values())
      r.controller.abort(new AniError('transient', 'Daemon shutting down'));
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  get activeJobs(): Job[] {
    return [...this.running.values()].map((r) => r.job);
  }

  private countLane(lane: Lane): number {
    let n = 0;
    for (const r of this.running.values()) if (r.job.lane === lane) n++;
    return n;
  }

  private fill(): void {
    const { workspace, concurrency, workerId, typeLimits } = this.opts;
    for (const lane of Object.keys(concurrency) as Lane[]) {
      while (this.countLane(lane) < concurrency[lane]) {
        const full = Object.entries(typeLimits)
          .filter(
            ([type, max]) => [...this.running.values()].filter((r) => r.job.type === type).length >= max,
          )
          .map(([type]) => type);
        const job = claimNextJob(workspace.db, lane, workerId, Date.now(), full);
        if (!job) break;
        this.launch(job);
      }
    }
  }

  private checkCancellations(): void {
    for (const r of this.running.values()) {
      if (r.controller.signal.aborted) continue;
      if (getJob(this.opts.workspace.db, r.job.id).cancelRequested) {
        r.controller.abort(new AniError('usage', 'Cancelled by request'));
      }
    }
  }

  private launch(job: Job): void {
    const { workspace, handlers, log } = this.opts;
    const controller = new AbortController();
    const handler = handlers.get(job.type);
    let lastProgressAt = 0;
    const ctx: JobContext = {
      workspace,
      job,
      services: this.opts.services,
      signal: controller.signal,
      progress: (fraction, message) => {
        const now = Date.now();
        if (now - lastProgressAt < 200 && fraction < 1) return;
        lastProgressAt = now;
        updateJobProgress(workspace.db, job.id, fraction, message);
      },
      log: (message) => log(`[${job.type} ${job.id}] ${message}`),
    };
    const done = (async () => {
      try {
        if (!handler) throw new AniError('internal', `No handler registered for job type "${job.type}"`);
        const outcome = await handler(ctx);
        if (controller.signal.aborted && getJob(workspace.db, job.id).cancelRequested) {
          markCancelled(workspace.db, job.id);
        } else {
          completeJob(workspace.db, job.id, outcome.result, outcome.costUsd);
        }
      } catch (error) {
        if (controller.signal.aborted && getJob(workspace.db, job.id).cancelRequested) {
          markCancelled(workspace.db, job.id);
        } else if (this.stopping) {
          // Leave it `running`; recoverInterruptedJobs requeues it on the next start.
        } else {
          const envelope = toEnvelopeError(error);
          log(`[${job.type} ${job.id}] failed: ${envelope.code} ${envelope.message}`);
          failJob(workspace.db, job.id, envelope, { retryable: RETRYABLE.has(envelope.code) });
        }
      } finally {
        this.running.delete(job.id);
      }
    })();
    this.running.set(job.id, { job, controller, done });
  }
}

/** Resolves after `ms`, or rejects with the abort reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
