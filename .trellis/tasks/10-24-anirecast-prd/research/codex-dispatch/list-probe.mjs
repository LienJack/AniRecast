import { spawn } from 'node:child_process';
setTimeout(() => { console.log('timeout'); process.exit(2); }, 60000).unref();
const p = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', id = 0; const waits = new Map();
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } } catch {} } });
const req = (method, params) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const init = await req('initialize', { clientInfo: { name: 'anirecast_probe', title: 'AniRecast probe', version: '0.0.1' } });
if (init.error) { console.log('init error', JSON.stringify(init.error)); process.exit(1); }
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
async function count(label, extra) {
  const c = {}; let cursor = null, pages = 0;
  do { const r = await req('thread/list', { limit: 100, cursor, archived: false, useStateDbOnly: true, ...extra }); if (r.error) { console.log(label, 'error', JSON.stringify(r.error)); return; }
    for (const t of r.result.data) { const s = typeof t.source === 'object' ? Object.keys(t.source)[0] : t.source; c[s] = (c[s] || 0) + 1; }
    cursor = r.result.nextCursor; pages++; } while (cursor && pages < 20);
  console.log(label.padEnd(40), JSON.stringify(c));
}
await count('default (no sourceKinds):', {});
await count('explicit [cli,vscode,exec,appServer]:', { sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] });
p.kill(); process.exit(0);
