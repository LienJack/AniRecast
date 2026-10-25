import { type AniEvent, APP_VERSION, listJobs, type Workspace } from '@anirecast/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentDispatcher } from './codex/dispatcher.ts';
import type { EventsHub } from './events-hub.ts';
import type { JobRunner } from './runner.ts';

export interface ServerDeps {
  workspace: Workspace;
  hub: EventsHub;
  runner: JobRunner;
  startedAt: number;
  dispatcher?: AgentDispatcher | undefined;
}

/** HTTP API for the Web UI only. The CLI talks to the workspace database directly. */
export function createApp({ workspace, hub, runner, startedAt, dispatcher }: ServerDeps): Hono {
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      data: {
        version: APP_VERSION,
        pid: process.pid,
        startedAt,
        workspace: {
          root: workspace.root,
          id: workspace.manifest.workspaceId,
          name: workspace.manifest.name,
        },
        activeJobs: runner.activeJobs.map((j) => ({ id: j.id, type: j.type, lane: j.lane })),
        codex: dispatcher?.status ?? { enabled: false },
      },
    }),
  );

  app.get('/api/jobs', (c) => c.json({ ok: true, data: listJobs(workspace.db, { limit: 200 }) }));

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const since = Number(c.req.query('since') ?? c.req.header('Last-Event-ID') ?? Number.NaN);
      const send = (e: AniEvent) =>
        stream.writeSSE({ id: String(e.seq), event: 'event', data: JSON.stringify(e) }).catch(() => {});
      if (Number.isFinite(since)) for (const e of hub.backlog(since)) await send(e);
      const unsubscribe = hub.subscribe((e) => {
        void send(e);
      });
      const keepAlive = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {});
      }, 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      unsubscribe();
    }),
  );

  return app;
}
