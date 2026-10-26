import {
  appendEvent,
  getHandoff,
  handoffKickoff,
  type LocalConfig,
  recordCodexUsage,
  setHandoffThread,
  type Workspace,
} from '@anirecast/core';
import { toEnvelopeError } from '@anirecast/shared';
import { type CodexCommand, codexTurnModel, resolveCodexCommand } from './binary.ts';
import type { AppServerClient, Notification } from './client.ts';
import { codexCommandMissing, desktopProjectId, SKILL_PATH, startCodexClient } from './dispatcher.ts';

const ACTOR = 'daemon';

export interface DiscussionOptions {
  workspace: Workspace;
  config: LocalConfig;
  log: (message: string) => void;
  /** Overrides binary resolution (tests point this at a mock app-server). */
  command?: CodexCommand | undefined;
  turnTimeoutMs?: number;
}

/**
 * Opens Codex discussions: a named thread in the Codex desktop app (filed under the workspace's project) and
 * one kickoff turn in which Codex reads the brief and proposes options. After that the thread is the human's:
 * the daemon never resumes it, and its app-server exits once no kickoff is running, so the desktop app is the
 * only process taking turns on the thread.
 */
export class CodexDiscussions {
  private client: AppServerClient | undefined;
  private running = 0;
  private readonly turnTimeoutMs: number;
  private readonly opts: DiscussionOptions;

  constructor(opts: DiscussionOptions) {
    this.opts = opts;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 10 * 60_000;
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client && !this.client.exited) return this.client;
    const command = this.opts.command ?? resolveCodexCommand(this.opts.config.codex.binPath);
    if (!command) throw codexCommandMissing();
    this.client = await startCodexClient(this.opts.workspace, command);
    return this.client;
  }

  private release(): void {
    this.running -= 1;
    if (this.running <= 0) {
      this.running = 0;
      this.client?.stop();
      this.client = undefined;
    }
  }

  private event(handoffId: string, projectId: string, kind: string, payload: Record<string, unknown>): void {
    appendEvent(this.opts.workspace.db, {
      actor: ACTOR,
      kind,
      entityType: 'handoff',
      entityId: handoffId,
      projectId,
      payload,
    });
  }

  /** Starts the thread and its kickoff turn; resolves once the thread exists, not when the turn ends. */
  async open(handoffId: string): Promise<{ threadId: string }> {
    const ws = this.opts.workspace;
    const h = getHandoff(ws.db, handoffId);
    if (h.threadId) return { threadId: h.threadId };
    const kickoff = handoffKickoff(ws, h);
    this.running += 1;
    let threadId: string | undefined;
    try {
      const client = await this.ensureClient();
      const projectId = await desktopProjectId(client, ws.root).catch(() => null);
      const started = await client.request<{ thread: { id: string; projectId?: string | null } }>(
        'thread/start',
        {
          cwd: ws.root,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          serviceName: 'anirecast',
          ...(this.opts.config.codex.model ? { model: this.opts.config.codex.model } : {}),
          ...(projectId ? { projectId } : {}),
        },
      );
      threadId = started.thread.id;
      await client.request('thread/name/set', { threadId, name: kickoff.threadName });
      if (projectId && started.thread.projectId !== projectId)
        await client.request('thread/metadata/update', { threadId, projectId }).catch(() => undefined);
      setHandoffThread(ws.db, h.id, threadId, ACTOR);
      const finished = this.waitForTurn(client, threadId);
      await client.request('turn/start', {
        threadId,
        ...codexTurnModel(this.opts.config.codex),
        cwd: ws.root,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [ws.root] },
        input: [
          { type: 'skill', name: 'anirecast', path: SKILL_PATH },
          ...kickoff.images.map((p) => ({ type: 'localImage', path: p })),
          { type: 'text', text: kickoff.text },
        ],
      });
      this.event(h.id, h.projectId, 'handoff.kickoff_started', { threadId });
      const id = threadId;
      void finished
        .then(({ status, usage }) => {
          if (usage) recordCodexUsage(ws.db, { taskId: null, threadId: id, tokens: usage });
          this.event(h.id, h.projectId, 'handoff.kickoff_finished', { threadId: id, turnStatus: status });
        })
        .catch((error) => this.opts.log(`discussion ${h.id}: ${toEnvelopeError(error).message}`))
        .finally(() => this.release());
      return { threadId };
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private waitForTurn(
    client: AppServerClient,
    threadId: string,
  ): Promise<{ status: string; usage: unknown }> {
    return new Promise((resolve) => {
      let usage: unknown = null;
      const timer = setTimeout(() => {
        off();
        void client.request('turn/interrupt', { threadId }).catch(() => undefined);
        resolve({ status: 'timeout', usage });
      }, this.turnTimeoutMs);
      timer.unref();
      const off = client.onNotification((n: Notification) => {
        const p = n.params as { threadId?: string; tokenUsage?: unknown; turn?: { status?: string } };
        if (p.threadId && p.threadId !== threadId) return;
        if (n.method === 'thread/tokenUsage/updated') usage = p.tokenUsage ?? n.params;
        else if (n.method === 'turn/completed') {
          clearTimeout(timer);
          off();
          resolve({ status: p.turn?.status ?? 'completed', usage });
        }
      });
    });
  }

  stop(): void {
    this.client?.stop();
    this.client = undefined;
  }
}
