import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createProject, createSource, openWorkspace, updateSource } from '@anirecast/core';
import { describe, expect, it } from 'vitest';
import { setupWorkspace } from './helpers.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('web API', () => {
  it('serves workspace files with ranges and refuses escapes', async () => {
    const t = await setupWorkspace();
    mkdirSync(path.join(t.root, 'cache'), { recursive: true });
    writeFileSync(path.join(t.root, 'cache', 'blob.bin'), Buffer.from([...Array(100).keys()]));
    const res = await fetch(`${t.daemon.url}/api/files/cache/blob.bin`, {
      headers: { Range: 'bytes=10-19' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect((await fetch(`${t.daemon.url}/api/files/cache/missing.bin`)).status).toBe(404);
    expect((await fetch(`${t.daemon.url}/api/files/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
  });

  it('wraps results and errors in the CLI envelope with HTTP status codes', async () => {
    const t = await setupWorkspace();
    const ws = openWorkspace(t.root, { role: 'cli' });
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 4_000 }, 'daemon');
    createProject(ws.db, { name: 'API Test', sourceId: src.id }, 'user');
    ws.close();

    const overview = await (await fetch(`${t.daemon.url}/api/projects/api-test`)).json();
    expect(overview).toMatchObject({
      ok: true,
      data: { project: { slug: 'api-test' }, clip: null, shots: [] },
    });

    const missing = await fetch(`${t.daemon.url}/api/shots/shot_nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const bad = await fetch(`${t.daemon.url}/api/sources`, {
      method: 'POST',
      body: JSON.stringify({ url: 'ftp://x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
  });

  it('creates a persona and accepts a multipart reference upload', async () => {
    const t = await setupWorkspace();
    const created = await (
      await fetch(`${t.daemon.url}/api/personas`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Silver', description: 'bob' }),
        headers: { 'content-type': 'application/json' },
      })
    ).json();
    expect(created).toMatchObject({ ok: true, data: { slug: 'silver' } });
    const form = new FormData();
    form.set('file', new File([PNG], 'ref.png', { type: 'image/png' }));
    form.set('view', 'full');
    const uploaded = (await (
      await fetch(`${t.daemon.url}/api/personas/silver/images`, { method: 'POST', body: form })
    ).json()) as { data: { images: Array<{ path: string; view: string; isPrimary: boolean }> } };
    expect(uploaded.data.images).toHaveLength(1);
    expect(uploaded.data.images[0]).toMatchObject({ view: 'full', isPrimary: true });
    const file = await fetch(`${t.daemon.url}/api/files/${uploaded.data.images[0]!.path}`);
    expect(file.headers.get('content-type')).toBe('image/png');
  });
});
