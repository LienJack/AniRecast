import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
setTimeout(() => { console.log('timeout'); process.exit(2); }, 300000).unref();
const cwd = process.argv[2];
const dbPath = `${cwd}/anirecast.db`; for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
// "daemon" side, outside the sandbox: WAL db with a jobs table, kept open
const db = new DatabaseSync(dbPath); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(id INTEGER PRIMARY KEY, type TEXT, status TEXT, by TEXT);");
const writer = `${cwd}/enqueue.mjs`;
fs.writeFileSync(writer, `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout=5000'); db.prepare("INSERT INTO jobs(type,status,by) VALUES ('board.generate','queued','sandboxed-cli')").run(); console.log('rows', db.prepare('SELECT count(*) n FROM jobs').get().n);`);
const p = spawn(process.env.CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', id = 0; const waits = new Map(); let onNotify = () => {};
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id != null && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } else if (m.method) onNotify(m); } });
const req = (method, params) => new Promise(r => { const i = ++id; waits.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const must = r => { if (r.error) { console.log('ERROR', JSON.stringify(r.error)); process.exit(1); } return r.result; };
must(await req('initialize', { clientInfo: { name: 'anirecast', title: 'AniRecast', version: '0.0.1' } }));
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
const { thread } = must(await req('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', serviceName: 'anirecast' }));
let cmdOut = []; const done = new Promise(r => { onNotify = m => {
  if (m.method === 'item/completed' && m.params?.item?.type === 'commandExecution') cmdOut.push({ exit: m.params.item.exitCode, out: String(m.params.item.aggregatedOutput ?? '').slice(0, 300) });
  if (m.method === 'turn/completed') r(m.params); }; });
must(await req('turn/start', { threadId: thread.id, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [cwd] }, input: [{ type: 'text', text: `Run exactly this one shell command and nothing else: node ${writer} ${dbPath} ; then reply with only its output.` }] }));
const t = await done;
const rows = db.prepare('SELECT * FROM jobs').all();
console.log('turn:', t.turn?.status, '| cmd:', JSON.stringify(cmdOut));
console.log('daemon sees rows:', JSON.stringify(rows));
console.log('test thread deleted:', !(await req('thread/delete', { threadId: thread.id })).error);
p.kill(); db.close(); process.exit(0);
