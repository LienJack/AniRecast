import { type ChildProcess, spawn } from 'node:child_process';
import { AniError } from '@anirecast/shared';

export interface Notification {
  method: string;
  params: Record<string, unknown>;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

/** Minimal JSON-RPC client for `codex app-server` over stdio. */
export class AppServerClient {
  private child: ChildProcess | undefined;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(n: Notification) => void>();
  private stderrTail = '';
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string | undefined;
  exited = false;

  constructor(options: { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }) {
    this.command = options.command;
    this.args = options.args;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
  }

  async start(clientName = 'anirecast'): Promise<Record<string, unknown>> {
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      ...(this.cwd ? { cwd: this.cwd } : {}),
    });
    this.child = child;
    child.stdout?.setEncoding('utf8').on('data', (d: string) => this.onData(d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.on('exit', (code) => {
      this.exited = true;
      for (const p of this.pending.values())
        p.reject(
          new AniError('transient', `codex app-server exited (${code}) during ${p.method}`, {
            details: { stderr: this.stderrTail },
          }),
        );
      this.pending.clear();
    });
    child.on('error', (error) => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
    const init = (await this.request('initialize', {
      clientInfo: { name: clientName, title: 'AniRecast', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })) as Record<string, unknown>;
    this.notify('initialized');
    return init;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i = this.buffer.indexOf('\n');
    while (i >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.onMessage(line);
      i = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server → client request (approvals, user input). AniRecast turns run with approvalPolicy=never,
      // so anything arriving here is unexpected: decline rather than hang the turn.
      this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `AniRecast does not handle ${msg.method}` },
      });
      return;
    }
    if (msg.id !== undefined && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(
          new AniError('provider_rejected', `codex ${p.method}: ${msg.error.message ?? 'error'}`, {
            details: msg.error,
          }),
        );
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const l of this.listeners) l({ method: msg.method, params: msg.params ?? {} });
  }

  private write(obj: unknown): void {
    if (!this.child?.stdin || this.exited) throw new AniError('transient', 'codex app-server is not running');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  onNotification(listener: (n: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.child && !this.exited) this.child.kill('SIGTERM');
  }

  get lastStderr(): string {
    return this.stderrTail;
  }
}
