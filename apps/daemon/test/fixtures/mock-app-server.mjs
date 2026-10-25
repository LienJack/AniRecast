// Stand-in for `codex app-server`: speaks just enough JSON-RPC for the dispatcher and plays Codex by
// running the real anirecast CLI (from the thread's cwd, as a Codex thread) to finish the task.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CLI = path.resolve(import.meta.dirname, '../../../../packages/cli/src/main.ts');
const log = (entry) =>
  process.env.MOCK_LOG && appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(entry)}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
let threads = 0;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const { method, params = {} } = msg;
  log({
    method,
    params: { ...params, input: params.input?.map((i) => (i.type === 'text' ? { type: 'text' } : i)) },
  });
  switch (method) {
    case 'initialize':
      return send({ id: msg.id, result: { userAgent: 'mock-app-server' } });
    case 'project/list':
      return send({
        id: msg.id,
        result: {
          data: [{ id: 'proj_mock', name: 'Mock', roots: [{ path: process.env.MOCK_PROJECT_ROOT }] }],
          nextCursor: null,
        },
      });
    case 'thread/start':
      return send({
        id: msg.id,
        result: { thread: { id: `thr_mock_${++threads}`, projectId: params.projectId ?? null } },
      });
    case 'thread/resume':
    case 'thread/name/set':
    case 'thread/metadata/update':
      return send({ id: msg.id, result: {} });
    case 'turn/start': {
      send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
      const text = params.input.find((i) => i.type === 'text')?.text ?? '';
      const taskId = /任務 (task_[0-9a-z]+)/.exec(text)?.[1];
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: params.threadId, delta: `處理 ${taskId}` },
      });
      if (taskId && process.env.MOCK_SKIP_DONE !== '1') {
        const r = spawnSync(process.execPath, [CLI, 'tasks', 'done', taskId, '--note', 'mock note'], {
          cwd: params.cwd,
          env: { ...process.env, CODEX_THREAD_ID: params.threadId, CODEX_SANDBOX: 'seatbelt' },
          encoding: 'utf8',
        });
        log({ cli: JSON.parse(r.stdout || 'null'), status: r.status });
      }
      send({
        method: 'thread/tokenUsage/updated',
        params: { threadId: params.threadId, tokenUsage: { total: { totalTokens: 1234 } } },
      });
      send({
        method: 'turn/completed',
        params: { threadId: params.threadId, turn: { id: 'turn_1', status: 'completed' } },
      });
      return;
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: `mock does not implement ${method}` } });
  }
});
