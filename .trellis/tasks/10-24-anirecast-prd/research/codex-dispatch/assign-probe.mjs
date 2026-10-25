import { spawn } from 'node:child_process';
import fs from 'node:fs';
setTimeout(() => { console.log('timeout'); process.exit(2); }, 240000).unref();
const GS = process.env.HOME + '/.codex/.codex-global-state.json';
const state = id => { const j = JSON.parse(fs.readFileSync(GS, 'utf8')); return { assigned: (j['thread-project-assignments'] || {})[id] ?? null, projectless: (j['projectless-thread-ids'] || []).includes(id), rootHint: (j['thread-workspace-root-hints'] || {})[id] ?? null }; };
const p = spawn(process.env.CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', id = 0; const waits = new Map(); let onNotify = () => {};
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } else if (m.method) onNotify(m); } });
const req = (method, params) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const must = r => { if (r.error) { console.log('ERROR', JSON.stringify(r.error)); process.exit(1); } return r.result; };
must(await req('initialize', { clientInfo: { name: 'anirecast', title: 'AniRecast', version: '0.0.1' } }));
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const { thread } = must(await req('thread/start', { cwd: process.argv[2], approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'anirecast', threadSource: 'user' }));
must(await req('thread/name/set', { threadId: thread.id, name: 'AniRecast 專案歸屬測試（可刪除）' }));
const done = new Promise(r => { onNotify = m => { if (m.method === 'turn/completed') r(m.params); }; });
must(await req('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '這是 AniRecast 專案歸屬測試。不要執行任何指令，只回覆一行：「AniRecast 專案歸屬測試 OK」。' }] }));
const t = await done;
console.log('thread', thread.id, '| turn:', t.turn?.status, '| projectId(app-server):', JSON.stringify(thread.projectId ?? null));
p.kill();
for (let s = 0; s <= 60; s += 10) { console.log(`t+${s}s`, JSON.stringify(state(thread.id))); if (s < 60) await new Promise(r => setTimeout(r, 10000)); }
process.exit(0);
