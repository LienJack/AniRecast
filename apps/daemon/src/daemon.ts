import os from 'node:os';
import {
  APP_VERSION,
  acquireDaemonLock,
  appendEvent,
  clearHeartbeat,
  getApiKey,
  HEARTBEAT_INTERVAL_MS,
  type LocalConfig,
  loadConfig,
  openWorkspace,
  recoverInterruptedJobs,
  refreshDaemonLock,
  releaseDaemonLock,
  type Workspace,
  writeHeartbeat,
} from '@anirecast/core';
import { createProvider, type Provider } from '@anirecast/providers';
import { AniError } from '@anirecast/shared';
import { type ServerType, serve } from '@hono/node-server';
import type { CodexCommand } from './codex/binary.ts';
import { CodexDiscussions } from './codex/discussions.ts';
import { AgentDispatcher } from './codex/dispatcher.ts';
import { EventsHub } from './events-hub.ts';
import { createHandlers } from './handlers/index.ts';
import { type JobHandler, JobRunner } from './runner.ts';
import { createApp } from './server.ts';

export interface StartOptions {
  root: string;
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  config?: LocalConfig;
  handlers?: Map<string, JobHandler>;
  /** Overrides config/env provider selection (tests inject a configured fake). */
  provider?: Provider;
  /** Codex auto-dispatch: defaults to config.codex.autoDispatch; tests pass false or a mock command. */
  dispatch?: boolean | { command: CodexCommand };
  log?: (message: string) => void;
}

/** `ANIRECAST_PROVIDER=fake` forces the offline provider regardless of config. */
export function resolveProvider(config: LocalConfig, env: NodeJS.ProcessEnv = process.env): Provider {
  const kind =
    env.ANIRECAST_PROVIDER === 'fake' || env.ANIRECAST_PROVIDER === 'gemini'
      ? env.ANIRECAST_PROVIDER
      : config.provider;
  if (kind === 'fake') return createProvider('fake');
  // Each backend works as soon as its key is there; a model whose key is missing fails with a setup hint.
  const apiKey = getApiKey('gemini', env);
  const fal = getApiKey('fal', env);
  const jev = getApiKey('jev', env);
  return createProvider('gemini', {
    ...(apiKey ? { apiKey } : {}),
    ...(fal ? { fal } : {}),
    ...(jev ? { jev: { apiKey: jev, baseUrl: env.JEV_URL ?? config.providers.jev.baseUrl } } : {}),
  });
}

export interface DaemonHandle {
  workspace: Workspace;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

/** Workspaces served by this process; the lock file alone cannot tell two daemons in one process apart. */
const serving = new Set<string>();

export async function startDaemon(options: StartOptions): Promise<DaemonHandle> {
  const config = options.config ?? loadConfig();
  const log = options.log ?? ((m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`));
  const workspace = openWorkspace(options.root, { role: 'daemon' });
  if (serving.has(workspace.root)) {
    workspace.close();
    throw new AniError('workspace_locked', `This process is already serving ${workspace.root}`);
  }
  let lock: ReturnType<typeof acquireDaemonLock>;
  try {
    lock = acquireDaemonLock(workspace.root);
  } catch (error) {
    workspace.close();
    throw error;
  }
  serving.add(workspace.root);
  const startedAt = Date.now();
  const recovered = recoverInterruptedJobs(workspace.db);
  if (recovered > 0) log(`requeued ${recovered} job(s) interrupted by a previous daemon`);

  const beat = () => {
    writeHeartbeat(workspace.db, { host: os.hostname(), pid: process.pid, version: APP_VERSION, startedAt });
    refreshDaemonLock(workspace.root, lock);
  };
  beat();
  const heartbeatTimer = setInterval(() => {
    try {
      beat();
    } catch (error) {
      log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  const services = { config, provider: options.provider ?? resolveProvider(config) };
  log(`provider: ${services.provider.name}`);
  const runner = new JobRunner({
    workspace,
    services,
    handlers: options.handlers ?? createHandlers(),
    concurrency: {
      // Room for both: `generate` image jobs and `video` shot videos side by side.
      generate: config.concurrency.generate + (config.concurrency.video ?? 1),
      media: config.concurrency.media,
      io: config.concurrency.io,
      agent: 1,
    },
    // Shot videos (partial takes included) up to `video` at once; storyboard frames and design sheets up to
    // `generate` each, so three videos never starve the images.
    typeLimits: {
      'take.generate': config.concurrency.video ?? 1,
      'board.generate': config.concurrency.generate,
      'design.generate': config.concurrency.generate,
    },
    workerId: `${os.hostname()}:${process.pid}`,
    log,
  });
  const hub = new EventsHub(workspace);
  hub.start();
  runner.start();

  const dispatchEnabled =
    options.dispatch === undefined ? config.codex.autoDispatch : options.dispatch !== false;
  const dispatcher = dispatchEnabled
    ? new AgentDispatcher({
        workspace,
        config,
        log,
        ...(typeof options.dispatch === 'object' ? { command: options.dispatch.command, pollMs: 200 } : {}),
      })
    : undefined;
  dispatcher?.start();
  log(`codex auto-dispatch: ${dispatcher ? 'on' : 'off'}`);
  // Discussions work whether or not auto-dispatch is on: the human asks for each one.
  const discussions = new CodexDiscussions({
    workspace,
    config,
    log,
    command: typeof options.dispatch === 'object' ? options.dispatch.command : undefined,
  });

  const app = createApp({
    workspace,
    hub,
    runner,
    startedAt,
    dispatcher,
    discussions,
    onSwitchWorkspace: () => {
      log('workspace switched; restarting');
      void stop().then(() => process.exit(0));
    },
  });
  const host = options.host ?? config.daemon.host;
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: host, port: options.port ?? config.daemon.port }, () =>
      resolve(s),
    );
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? config.daemon.port);
  appendEvent(workspace.db, {
    actor: 'daemon',
    kind: 'daemon.started',
    entityType: 'daemon',
    payload: { pid: process.pid, port },
  });
  log(`AniRecast daemon serving ${workspace.root} on http://${host}:${port}`);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    dispatcher?.stop();
    discussions.stop();
    await runner.stop();
    hub.stop();
    // Live-update (SSE) connections never end on their own: without dropping them, close() waits forever,
    // launchd kills the process and requests fail until it does. Stop listening, drop every connection.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref())]);
    appendEvent(workspace.db, {
      actor: 'daemon',
      kind: 'daemon.stopped',
      entityType: 'daemon',
      payload: { pid: process.pid },
    });
    clearHeartbeat(workspace.db, process.pid);
    workspace.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    releaseDaemonLock(workspace.root);
    serving.delete(workspace.root);
    workspace.close();
  };
  return { workspace, port, url: `http://${host}:${port}`, stop };
}
