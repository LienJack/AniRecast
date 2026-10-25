// usage: node --env-file=<.env> interact.mjs <request.json> <outPrefix>
// Request JSON may reference local files as {"type":"image","file":"path"} -> inlined base64.
import fs from 'node:fs';
import path from 'node:path';
const key = process.env.GEMINI_API_KEY || process.env.GEMINI_OMNI_API_KEY;
const [reqPath, outPrefix] = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const mimeOf = f => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4' })[path.extname(f).toLowerCase()];
if (Array.isArray(req.input)) req.input = req.input.map(p => p.file ? { type: p.type, data: fs.readFileSync(p.file).toString('base64'), mime_type: mimeOf(p.file) } : p);
const base = 'https://generativelanguage.googleapis.com/v1beta';
const H = { 'x-goog-api-key': key, 'content-type': 'application/json' };
const t0 = Date.now();
let res = await fetch(`${base}/interactions`, { method: 'POST', headers: H, body: JSON.stringify(req) });
let j = await res.json();
console.log('create HTTP', res.status, 'status:', j.status, 'id:', j.id ? j.id.slice(0, 12) + '…' : '-');
while (res.ok && j.id && j.status && !['completed', 'failed', 'cancelled', 'incomplete'].includes(j.status)) {
  await new Promise(r => setTimeout(r, 5000));
  res = await fetch(`${base}/interactions/${j.id}`, { headers: H });
  j = await res.json();
  process.stdout.write(`.${j.status}`);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
let n = 0;
const saved = [];
const walk = (o) => {
  if (Array.isArray(o)) return o.map(walk);
  if (o && typeof o === 'object') {
    if (typeof o.data === 'string' && o.data.length > 1000) {
      const ext = (o.mime_type || '').includes('mp4') ? 'mp4' : (o.mime_type || '').includes('jpeg') ? 'jpg' : 'png';
      const f = `${outPrefix}-${n++}.${ext}`;
      fs.writeFileSync(f, Buffer.from(o.data, 'base64'));
      saved.push(f);
      return { ...o, data: `<${o.data.length} b64 chars -> ${f}>` };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  }
  return o;
};
const slim = walk(j);
fs.writeFileSync(`${outPrefix}.response.json`, JSON.stringify(slim, null, 2));
console.log(`\nHTTP ${res.status} after ${secs}s; saved:`, saved.join(', ') || 'none');
if (!res.ok || j.status === 'failed') console.log(JSON.stringify(slim).slice(0, 1500));
console.log('usage:', JSON.stringify(j.usage ?? null));
