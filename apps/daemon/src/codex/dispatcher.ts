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
import { type CodexCommand, codexTurnModel, resolveCodexCommand } from './binary.ts';
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

/** Starts `codex app-server` for the workspace; `anirecast` and `node` must resolve inside Codex's sandboxed shell. */
export async function startCodexClient(
  workspace: Workspace,
  command: CodexCommand,
): Promise<AppServerClient> {
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
    cwd: workspace.root,
  });
  await client.start();
  return client;
}

/** The Codex desktop project whose root is the workspace or one of its ancestors (experimental API). */
export async function desktopProjectId(client: AppServerClient, root: string): Promise<string | null> {
  const res = await client.request<{ data: Array<{ id: string; roots: Array<{ path: string }> }> }>(
    'project/list',
    {
      limit: 200,
    },
  );
  const match = res.data
    .flatMap((p) => p.roots.map((r) => ({ id: p.id, root: path.resolve(r.path) })))
    .filter((p) => root === p.root || root.startsWith(`${p.root}${path.sep}`))
    .sort((a, b) => b.root.length - a.root.length)[0];
  return match?.id ?? null;
}

export const codexCommandMissing = () =>
  new AniError('dependency_missing', 'Codex CLI not found', {
    hint: 'Install the Codex desktop app or CLI, or set codex.binPath.',
  });

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
    if (!command) throw codexCommandMissing();
    this.status.codex = { command: command.command, version: command.version, source: command.source };
    const client = await startCodexClient(this.opts.workspace, command);
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
      this.projectId = await desktopProjectId(client, root);
      if (!this.projectId)
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
    if (task.kind === 'shot_review') return `AniRecast · ${project.name} · 分鏡判斷`;
    if (task.kind === 'boards_review') return `AniRecast · ${project.name} · 分鏡圖總審`;
    if (task.kind === 'cast_review' || !task.shotId) return `AniRecast · ${project.name} · 角色辨識`;
    return `AniRecast · ${project.name} · 分鏡 ${getShot(this.opts.workspace.db, task.shotId).orderIndex + 1}`;
  }

  private async threadFor(client: AppServerClient, task: AgentTask): Promise<string> {
    const db = this.opts.workspace.db;
    const root = this.opts.workspace.root;
    const scope: ThreadScope =
      task.kind === 'shot_review' || task.kind === 'boards_review'
        ? 'project_shots'
        : task.kind === 'cast_review' || !task.shotId
          ? 'project_cast'
          : 'shot';
    const scopeId = scope === 'shot' ? (task.shotId as string) : task.projectId;
    const projectId = await this.resolveProjectId(client);
    const { model } = this.opts.config.codex;
    const common = {
      cwd: root,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ...(model ? { model } : {}),
    };
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
    const payload = task.payload as {
      targetType?: string;
      targetId?: string;
      contactSheets?: string[];
      unsure?: Array<{ sheet?: string | null }>;
      merged?: Array<{ sheets?: Array<string | null> }>;
    };
    // Shot review: the cut sheets (already absolute), unsure ones first.
    if (task.kind === 'shot_review') {
      const sheets = [
        ...(payload.unsure ?? []).map((u) => u.sheet),
        ...(payload.merged ?? []).flatMap((m) => m.sheets ?? []),
      ].filter((p): p is string => Boolean(p));
      return sheets.slice(0, 8);
    }
    const out: string[] = [];
    // What the human attached to the comment or to an answer comes first: it is what they want Codex to see.
    const said = task.payload as {
      annotations?: Array<{ type?: string; path?: string }>;
      answerImages?: string[];
    };
    for (const a of said.annotations ?? []) if (a?.type === 'image' && a.path) out.push(ws.abs(a.path));
    for (const p of said.answerImages ?? []) out.push(ws.abs(p));
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
    return out.slice(0, 10);
  }

  private instructions(task: AgentTask): string {
    if (task.kind === 'boards_review') {
      const slug = getProject(this.opts.workspace.db, task.projectId).slug;
      return [
        `AniRecast 任務 ${task.id}（分鏡圖總審），已經替你領取。這是「生成全部分鏡圖」這一批的最終審核。`,
        `1. 先執行 \`anirecast tasks show ${task.id}\`：payload.boards 列出每張分鏡圖（分鏡號、首幀／關鍵幀／尾幀、id、路徑），關鍵幀的 followUps 是 JEV 對首尾幀要不要畫的判斷。附上的總覽圖每列一個分鏡：原片關鍵幀｜關鍵幀分鏡圖｜首幀｜尾幀（深色格＝沒畫）。需要細看就開 boards 裡的路徑。`,
        '2. 逐鏡檢查：替換的角色像不像她的設定集；同一鏡三張的人物是否一致（臉、髮型、服裝、配色）；是否還原原畫面的動作、構圖、位置和光影；畫風是否像原片（線條、眼睛、賽璐璐陰影）；有沒有畫錯人、多畫、漏畫或畫出文字。',
        `3. 明顯有問題的才重畫，每張最多一次：\`anirecast board generate ${slug} --from <boardId> --extra "<具體要改什麼>" --wait\`，畫完看新圖確認。JEV 判斷不畫、但其實動作差很多的首尾幀，用 \`anirecast board generate ${slug} <shotId> --role first|last --wait\` 補（偵測說看不到人、但其實露出一部分時加 --force）。`,
        '4. 不要按「通過」，那是人類的決定。',
        `5. 完成時 \`anirecast tasks done ${task.id} --note "建議通過：#…；重畫了：#…（原因）；需要人看：#…（原因）"\`。`,
      ].join('\n');
    }
    return [
      `AniRecast 任務 ${task.id}（${task.kind === 'cast_review' ? '同一人識別判斷' : task.kind === 'shot_review' ? '分鏡切點判斷與最終檢查' : '評審意見'}），已經替你領取。`,
      `1. 先執行 \`anirecast tasks show ${task.id}\` 讀取完整內容（意見、目前版本、輸入檔路徑、建議步驟）。`,
      `2. 依 anirecast skill（${SKILL_PATH}）處理。只透過 anirecast CLI 操作，不要直接改 Workspace 裡的檔案；你沒有網路，模型呼叫由 AniRecast 服務代勞。用 --from 修正版本時會沿用原版本的檔位。`,
      `3. 完成時執行 \`anirecast tasks done ${task.id} --note "<一句話說明改了什麼>"${task.kind === 'review_feedback' ? ' --result <新版本 id>' : ''}\`。`,
      `4. 意見不明確或連續兩次被內容過濾擋下時，用 \`anirecast tasks ask ${task.id} --question "…"\` 問人類，然後結束。`,
      '5. 人類說某一段已經可以（例如「74 到 164 幀可以」）時，只重做其他幀：`anirecast take generate <項目> <鏡頭> --range a-b --keep <要保留的版本>`；切點放在 `anirecast shots cuts <鏡頭>` 找到的切鏡上。多人、運鏡、鏡頭裡有切鏡或打鬥的鏡頭，照 skill 的「Hard shots」：先看上一版的 prompt 和 params.director 漏了誰、用錨點分鏡圖、先 `take plan` 看指令再付費。',
      `6. 需要改 AniRecast 程式（你的 sandbox 只能寫 Workspace）或 CLI 做不到時，不要卡住、不要一直重做：\`anirecast tasks handoff ${task.id} --to claude --reason "…" --tried "…" --plan "…"\` 交給 Claude 接手，然後結束。`,
      '人類附上的圖片已經放在這則訊息裡（任務的 annotations 裡 type 為 image 的，以及 answerImages）；重新生成時用 --attach <路徑> 把需要的圖片交給模型。',
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
      ...codexTurnModel(this.opts.config.codex),
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
