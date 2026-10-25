import { spawn } from 'node:child_process';
setTimeout(() => { console.log('timeout'); process.exit(2); }, 60000).unref();
const [threadId, projectId] = process.argv.slice(2);
const p = spawn(process.env.CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', id = 0; const waits = new Map(); const notes = [];
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } else if (m.method) notes.push(m.method); } });
const req = (method, params) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const init = await req('initialize', { clientInfo: { name: 'anirecast', title: 'AniRecast', version: '0.0.1' }, capabilities: { experimentalApi: true } });
if (init.error) { console.log('init error', JSON.stringify(init.error)); process.exit(1); }
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const pl = await req('project/list', {});
console.log('project/list:', pl.error ? JSON.stringify(pl.error) : JSON.stringify((pl.result.data ?? pl.result.projects ?? pl.result).map?.(x => [x.id, x.name]) ?? pl.result).slice(0, 400));
const up = await req('thread/metadata/update', { threadId, projectId });
console.log('thread/metadata/update:', up.error ? 'ERROR ' + JSON.stringify(up.error) : 'ok ' + JSON.stringify(up.result?.thread?.projectId ?? up.result).slice(0, 200));
const ls = await req('thread/list', { projectId, limit: 20, useStateDbOnly: true });
console.log('thread/list in project:', ls.error ? JSON.stringify(ls.error) : JSON.stringify(ls.result.data.map(t => [t.id, t.name ?? t.preview?.slice(0, 20)])));
await new Promise(r => setTimeout(r, 500)); console.log('notifications:', [...new Set(notes)].join(', '));
p.kill(); process.exit(0);
