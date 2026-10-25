import { type AniEvent, eventsSince, latestEventSeq, type Workspace } from '@anirecast/core';

type Listener = (event: AniEvent) => void;

/**
 * Tails the `events` table. Every state change, from the CLI, Codex or the daemon itself, lands there
 * in the same transaction, so this one poller is enough to drive SSE.
 */
export class EventsHub {
  private readonly listeners = new Set<Listener>();
  private readonly workspace: Workspace;
  private readonly pollMs: number;
  private cursor: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(workspace: Workspace, pollMs = 250) {
    this.workspace = workspace;
    this.pollMs = pollMs;
    this.cursor = latestEventSeq(workspace.db);
  }

  start(): void {
    const tick = (): void => {
      try {
        for (;;) {
          const batch = eventsSince(this.workspace.db, this.cursor, 500);
          for (const e of batch) {
            this.cursor = e.seq;
            for (const l of this.listeners) l(e);
          }
          if (batch.length < 500) break;
        }
      } catch {
        // A locked or busy database just delays delivery to the next tick.
      }
      this.timer = setTimeout(tick, this.pollMs);
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `seq`, for SSE clients reconnecting with Last-Event-ID. */
  backlog(seq: number): AniEvent[] {
    return eventsSince(this.workspace.db, seq, 1000);
  }
}
