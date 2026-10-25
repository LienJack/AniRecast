import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
setTimeout(() => { console.log('timeout'); process.exit(2); }, 300000).unref();
const cwd = process.argv[2];
const socks = { 'socket in writable root': `${cwd}/d.sock`, 'socket in ~/.config (not writable)': `${os.homedir()}/.config/anirecast-probe.sock` };
const hits = []; const servers = [];
for (const p of Object.values(socks)) { try { fs.unlinkSync(p); } catch {} const s = http.createServer((q, r) => { hits.push(p); r.end('anirecast-daemon-ok'); }); await new Promise(r => s.listen(p, r)); servers.push([s, p]); }
const p = spawn(process.env.CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', id = 0; const waits = new Map(); let onNotify = () => {};
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } else if (m.method) onNotify(m); } });
const req = (method, params) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const must = r => { if (r.error) { console.log('ERROR', JSON.stringify(r.error)); process.exit(1); } return r.result; };
must(await req('initialize', { clientInfo: { name: 'anirecast', title: 'AniRecast', version: '0.0.1' } }));
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const { thread } = must(await req('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', serviceName: 'anirecast' }));
for (const [label, sock] of Object.entries(socks)) {
  let cmdOut = []; const done = new Promise(r => { onNotify = m => {
    if (m.method === 'item/completed' && m.params?.item?.type === 'commandExecution') cmdOut.push({ exit: m.params.item.exitCode, out: String(m.params.item.aggregatedOutput ?? '').slice(0, 160) });
    if (m.method === 'turn/completed') r(m.params); }; });
  const before = hits.length;
  must(await req('turn/start', { threadId: thread.id, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [cwd] }, input: [{ type: 'text', text: `Run exactly this one shell command and nothing else: curl -sS -m 5 --unix-socket '${sock}' http://localhost/probe ; then reply with only its stdout or error text.` }] }));
  const t = await done;
  console.log(label.padEnd(36), '| network off | hits:', hits.length - before, '| cmd:', JSON.stringify(cmdOut));
}
console.log('test thread deleted:', !(await req('thread/delete', { threadId: thread.id })).error);
p.kill(); for (const [s, path] of servers) { s.close(); try { fs.unlinkSync(path); } catch {} } process.exit(0);
