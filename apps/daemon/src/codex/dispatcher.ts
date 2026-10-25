import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentTask,
  appendEvent,
  askUser,
  claimAgentTask,
  findCodexThread,
  getAgentTask,
  getBoard,
  getProject,
  getShot,
  getTake,
  type LocalConfig,
  listAgentTasks,
  listKeyframes,
  recordCodexUsage,
  releaseAgentTask,
  saveCodexThread,
  type ThreadScope,
  type Workspace,
} from '@anirecast/core';
import { AniError, toEnvelopeError } from '@anirecast/shared';
import { type CodexCommand, resolveCodexCommand } from './binary.ts';
import { AppServerClient, type Notification } from './client.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const SKILL_PATH = path.join(REPO_ROOT, 'skills', 'anirecast', 'SKILL.md');

export interface DispatcherStatus {
  enabled: boolean;
  codex: { command: string; version: string; source: string } | null;
  projectId: string | null;
  busyTaskId: string | null;
  lastError: string | null;
  rateLimits: unknown;
}

export interface DispatcherOptions {
  workspace: Workspace;
  config: LocalConfig;
  log: (message: string) => void;
  /** Overrides binary resolution (tests point this at a mock app-server). */
  command?: CodexCommand;
  pollMs?: number;
  turnTimeoutMs?: number;
}

const ACTOR = 'dispatcher';

/** Hands open agent tasks to Codex through `codex app-server`, one turn at a time (design §8.4). */
export class AgentDispatcher {
  private readonly opts: Required<Omit<DispatcherOptions, 'command'>> & { command: CodexCommand | undefined };
  private client: AppServerClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private busy = false;
  private backoffUntil = 0;
  private projectId: string | null | undefined;
  readonly status: DispatcherStatus = {
    enabled: true,
    codex: null,
    projectId: null,
    busyTaskId: null,
    lastError: null,
    rateLimits: null,
  };

  constructor(options: DispatcherOptions) {
    this.opts = { pollMs: 2_000, turnTimeoutMs: 20 * 60_000, ...options, command: options.command };
  }

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollMs);
      });
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.client?.stop();
  }

  private event(kind: string, task: AgentTask | null, payload: Record<string, unknown>): void {
    appendEvent(this.opts.workspace.db, {
      actor: ACTOR,
      kind,
      entityType: 'agent_task',
      entityId: task?.id ?? null,
      projectId: task?.projectId ?? null,
      payload: { ...payload, shotId: task?.shotId ?? null },
    });
  }

  private async tick(): Promise<void> {
    if (this.busy || Date.now() < this.backoffUntil) return;
    const db = this.opts.workspace.db;
    const claimedShots = new Set(listAgentTasks(db, { status: 'claimed' }).map((t) => t.shotId));
    const next = listAgentTasks(db, { status: 'open' }).find((t) => !t.shotId || !claimedShots.has(t.shotId));
    if (!next) return;
    this.busy = true;
    let task: AgentTask | undefined;
    try {
      task = claimAgentTask(db, next.id, ACTOR);
      this.status.busyTaskId = task.id;
      await this.runTask(task);
      this.status.lastError = null;
    } catch (error) {
      const e = toEnvelopeError(error);
      this.status.lastError = `${e.code}: ${e.message}`;
      this.opts.log(`dispatch failed: ${this.status.lastError}`);
      if (task && getAgentTask(db, task.id).status === 'claimed') releaseAgentTask(db, task.id, ACTOR);
      this.event('agent.error', task ?? null, { error: e });
      this.backoffUntil = Date.now() + (e.code === 'dependency_missing' ? 5 * 60_000 : 60_000);
      if (this.client?.exited) this.client = undefined;
    } finally {
      this.busy = false;
      this.status.busyTaskId = null;
    }
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client && !this.client.exited) return this.client;
    const command = this.opts.command ?? resolveCodexCommand(this.opts.config.codex.binPath);
    if (!command) {
      throw new AniError('dependency_missing', 'Codex CLI not found', {
        hint: 'Install the Codex desktop app or CLI, or set codex.binPath.',
      });
    }
    this.status.codex = { command: command.command, version: command.version, source: command.source };
    // `anirecast` and `node` must resolve inside Codex's sandboxed shell.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [path.join(REPO_ROOT, 'bin'), path.dirname(process.execPath), process.env.PATH ?? ''].join(
        path.delimiter,
      ),
    };
    delete env.CODEX_SANDBOX;
    const client = new AppServerClient({
      command: command.command,
      args: command.args,
      env,
      cwd: this.opts.workspace.root,
    });
    await client.start();
    client.onNotification((n) => {
      if (n.method === 'account/rateLimits/updated') this.status.rateLimits = n.params;
    });
    this.client = client;
    this.projectId = undefined;
    return client;
  }

  /** The desktop project whose root is the workspace or one of its ancestors (experimental API). */
  private async resolveProjectId(client: AppServerClient): Promise<string | null> {
    if (this.projectId !== undefined) return this.projectId;
    const root = this.opts.workspace.root;
    try {
      const res = await client.request<{ data: Array<{ id: string; roots: Array<{ path: string }> }> }>(
        'project/list',
        { limit: 200 },
      );
      const match = res.data
        .flatMap((p) => p.roots.map((r) => ({ id: p.id, root: path.resolve(r.path) })))
        .filter((p) => root === p.root || root.startsWith(`${p.root}${path.sep}`))
        .sort((a, b) => b.root.length - a.root.length)[0];
      this.projectId = match?.id ?? null;
      if (!match)
        this.event('agent.warning', null, {
          message:
            'Workspace is not under any Codex desktop project; threads will appear under Recent instead.',
          root,
        });
    } catch (error) {
      this.projectId = null;
      this.event('agent.warning', null, {
        message: 'Codex project API unavailable; threads will not be filed under a project.',
        error: toEnvelopeError(error),
      });
    }
    this.status.projectId = this.projectId;
    return this.projectId;
  }

  private threadName(task: AgentTask): string {
    const project = getProject(this.opts.workspace.db, task.projectId);
    if (task.kind === 'cast_review' || !task.shotId) return `AniRecast · ${project.name} · 角色辨識`;
    return `AniRecast · ${project.name} · 分鏡 ${getShot(this.opts.workspace.db, task.shotId).orderIndex + 1}`;
  }

  private async threadFor(client: AppServerClient, task: AgentTask): Promise<string> {
    const db = this.opts.workspace.db;
    const root = this.opts.workspace.root;
    const scope: ThreadScope = task.kind === 'cast_review' || !task.shotId ? 'project_cast' : 'shot';
    const scopeId = scope === 'shot' ? (task.shotId as string) : task.projectId;
    const projectId = await this.resolveProjectId(client);
    const common = { cwd: root, approvalPolicy: 'never', sandbox: 'workspace-write' };
    const existing = findCodexThread(db, scope, scopeId);
    if (existing) {
      try {
        await client.request('thread/resume', { threadId: existing, ...common });
        return existing;
      } catch {
        // Deleted or unknown on this machine: start a fresh thread.
      }
    }
    const started = await client.request<{ thread: { id: string; projectId?: string | null } }>(
      'thread/start',
      {
        ...common,
        serviceName: 'anirecast',
        ...(projectId ? { projectId } : {}),
      },
    );
    const threadId = started.thread.id;
    await client.request('thread/name/set', { threadId, name: this.threadName(task) });
    if (projectId && started.thread.projectId !== projectId) {
      await client.request('thread/metadata/update', { threadId, projectId }).catch(() => undefined);
    }
    saveCodexThread(db, scope, scopeId, threadId);
    return threadId;
  }

  /** Images worth showing Codex up front; it can open anything else from the paths in `tasks show`. */
  private images(task: AgentTask): string[] {
    const ws = this.opts.workspace;
    const payload = task.payload as { targetType?: string; targetId?: string; contactSheets?: string[] };
    const out: string[] = [];
    if (payload.contactSheets) out.push(...payload.contactSheets.map((p) => ws.abs(p)));
    if (task.shotId) {
      const shot = getShot(ws.db, task.shotId);
      const frames = listKeyframes(ws.db, shot.id);
      const rep = frames.reduce<(typeof frames)[number] | undefined>(
        (best, k) =>
          !best || Math.abs(k.frame - shot.repFrame) < Math.abs(best.frame - shot.repFrame) ? k : best,
        undefined,
      );
      if (rep) out.push(ws.abs(rep.path));
    }
    if (payload.targetType === 'board' && payload.targetId) {
      const b = getBoard(ws.db, payload.targetId);
      if (b.path) out.push(ws.abs(b.path));
    }
    if (payload.targetType === 'take' && payload.targetId) {
      const t = getTake(ws.db, payload.targetId);
      if (t.boardId) {
        const b = getBoard(ws.db, t.boardId);
        if (b.path) out.push(ws.abs(b.path));
      }
    }
    return out.slice(0, 6);
  }

  private instructions(task: AgentTask): string {
    return [
      `AniRecast 任務 ${task.id}（${task.kind === 'cast_review' ? '同一人識別判斷' : '評審意見'}），已經替你領取。`,
      `1. 先執行 \`anirecast tasks show ${task.id}\` 讀取完整內容（意見、目前版本、輸入檔路徑、建議步驟）。`,
      '2. 依 anirecast skill 處理。只透過 anirecast CLI 操作，不要直接改 Workspace 裡的檔案；你沒有網路，模型呼叫由 AniRecast 服務代勞。',
      `3. 完成時執行 \`anirecast tasks done ${task.id} --note "<一句話說明改了什麼>"${task.kind === 'review_feedback' ? ' --result <新版本 id>' : ''}\`。`,
      `4. 意見不明確或連續兩次被內容過濾擋下時，用 \`anirecast tasks ask ${task.id} --question "…"\` 問人類，然後結束。`,
      '不要替人類按「通過」。',
    ].join('\n');
  }

  private async runTask(task: AgentTask): Promise<void> {
    const ws = this.opts.workspace;
    const client = await this.ensureClient();
    const threadId = await this.threadFor(client, task);
    this.event('agent.started', task, { threadId });
    let message = '';
    let lastFlush = 0;
    let usage: unknown = null;
    const flush = (force = false) => {
      if (!message || (!force && Date.now() - lastFlush < 1_000)) return;
      lastFlush = Date.now();
      this.event('agent.progress', task, { threadId, text: message.slice(-2000) });
    };
    const done = new Promise<{ status: string }>((resolve) => {
      const off = client.onNotification((n: Notification) => {
        const p = n.params as {
          threadId?: string;
          delta?: string;
          item?: { type?: string; command?: string; exitCode?: number; text?: string };
          turn?: { status?: string };
          tokenUsage?: unknown;
        };
        if (p.threadId && p.threadId !== threadId) return;
        if (n.method === 'item/agentMessage/delta' && p.delta) {
          message += p.delta;
          flush();
        } else if (n.method === 'item/completed' && p.item?.type === 'commandExecution') {
          this.event('agent.command', task, {
            threadId,
            command: p.item.command ?? null,
            exitCode: p.item.exitCode ?? null,
          });
        } else if (n.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.text) {
          message = p.item.text;
        } else if (n.method === 'thread/tokenUsage/updated') {
          usage = p.tokenUsage ?? n.params;
        } else if (n.method === 'turn/completed') {
          off();
          resolve({ status: p.turn?.status ?? 'completed' });
        }
      });
    });
    const timeout = new Promise<{ status: string }>((resolve) =>
      setTimeout(() => resolve({ status: 'timeout' }), this.opts.turnTimeoutMs).unref(),
    );
    await client.request('turn/start', {
      threadId,
      cwd: ws.root,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [ws.root] },
      input: [
        { type: 'skill', name: 'anirecast', path: SKILL_PATH },
        ...this.images(task).map((p) => ({ type: 'localImage', path: p })),
        { type: 'text', text: this.instructions(task) },
      ],
    });
    const outcome = await Promise.race([done, timeout]);
    if (outcome.status === 'timeout')
      await client.request('turn/interrupt', { threadId }).catch(() => undefined);
    flush(true);
    if (usage) recordCodexUsage(ws.db, { taskId: task.id, threadId, tokens: usage });
    this.event('agent.finished', task, { threadId, turnStatus: outcome.status });
    const after = getAgentTask(ws.db, task.id);
    if (after.status === 'claimed') {
      askUser(
        ws.db,
        task.id,
        `Codex 結束了這一輪（${outcome.status}）但沒有標記完成。最後的回覆：${message.slice(-600) || '（沒有）'}`,
        ACTOR,
      );
    }
  }
}
