import { spawn } from 'node:child_process';
import http from 'node:http';
setTimeout(() => { console.log('timeout'); process.exit(2); }, 300000).unref();
const srv = http.createServer((q, r) => { hits.push(q.url); r.end('anirecast-daemon-ok'); }); const hits = [];
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
const p = spawn(process.env.CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', id = 0; const waits = new Map(); let onNotify = () => {};
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } else if (m.method) onNotify(m); } });
const req = (method, params) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const must = r => { if (r.error) { console.log('ERROR', JSON.stringify(r.error)); process.exit(1); } return r.result; };
must(await req('initialize', { clientInfo: { name: 'anirecast', title: 'AniRecast', version: '0.0.1' } }));
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const cwd = process.argv[2];
const { thread } = must(await req('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', serviceName: 'anirecast' }));
must(await req('thread/name/set', { threadId: thread.id, name: 'AniRecast 沙箱連線測試（可刪除）' }));
async function turn(label, sandboxPolicy, n) {
  let cmdOut = []; const done = new Promise(r => { onNotify = m => {
    if (m.method === 'item/completed' && m.params?.item?.type === 'commandExecution') cmdOut.push({ exit: m.params.item.exitCode, out: String(m.params.item.aggregatedOutput ?? '').slice(0, 200) });
    if (m.method === 'turn/completed') r(m.params); }; });
  const before = hits.length;
  must(await req('turn/start', { threadId: thread.id, sandboxPolicy, input: [{ type: 'text', text: `Run exactly this one shell command and nothing else: curl -sS -m 5 http://127.0.0.1:${port}/probe-${n} ; then reply with only its stdout or error text.` }] }));
  const t = await done;
  console.log(label.padEnd(30), '| turn:', t.turn?.status, '| server hits:', hits.length - before, '| cmd:', JSON.stringify(cmdOut));
}
await turn('workspaceWrite, network off', { type: 'workspaceWrite', networkAccess: false, writableRoots: [cwd] }, 1);
await turn('workspaceWrite, network on', { type: 'workspaceWrite', networkAccess: true, writableRoots: [cwd] }, 2);
const del = await req('thread/delete', { threadId: thread.id });
console.log('test thread deleted:', !del.error);
p.kill(); srv.close(); process.exit(0);
