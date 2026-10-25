const key = process.env.GEMINI_API_KEY || process.env.GEMINI_OMNI_API_KEY;
if (!key) { console.error('no key in env'); process.exit(1); }
let url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
console.log('HTTP', res.status);
const j = await res.json();
if (!res.ok) { console.log(JSON.stringify(j.error ?? j).slice(0, 500)); process.exit(1); }
const names = (j.models ?? []).map(m => `${m.name.replace('models/','')}  [${(m.supportedGenerationMethods||[]).join(',')}]`);
const want = /omni|banana|image|veo|flash|pro/i;
console.log(names.filter(n => want.test(n)).join('\n'));
console.log('total models:', names.length, 'nextPage:', !!j.nextPageToken);
