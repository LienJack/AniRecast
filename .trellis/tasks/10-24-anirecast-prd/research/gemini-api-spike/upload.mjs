import fs from 'node:fs';
const key = process.env.GEMINI_API_KEY || process.env.GEMINI_OMNI_API_KEY;
const file = process.argv[2];
const buf = fs.readFileSync(file);
const base = 'https://generativelanguage.googleapis.com';
let r = await fetch(`${base}/upload/v1beta/files`, { method: 'POST', headers: {
  'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
  'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': 'video/mp4',
  'Content-Type': 'application/json' }, body: JSON.stringify({ file: { display_name: file } }) });
const up = r.headers.get('x-goog-upload-url');
if (!up) { console.error('start failed', r.status, await r.text()); process.exit(1); }
r = await fetch(up, { method: 'POST', headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: buf });
let f = (await r.json()).file;
while (f.state === 'PROCESSING') { await new Promise(s => setTimeout(s, 3000)); f = await (await fetch(`${base}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': key } })).json(); }
console.error('file state', f.state, f.mimeType, f.sizeBytes, 'expires', f.expirationTime);
process.stdout.write(f.uri);
