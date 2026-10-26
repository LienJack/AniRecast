import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createCastMember,
  createClip,
  createProject,
  createSource,
  createTracklet,
  initWorkspace,
  listReferences,
  openWorkspace,
  queueReferenceSearch,
  replaceShots,
  run,
  setKeyframes,
  updateSource,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider, type VisionRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { addReferenceFromUrl } from '../src/handlers/references.ts';
import { startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-refs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const picture = (file: string, size: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', file]);

describe('searching official design art', () => {
  it('scrapes the pages the search names, keeps official art of this character, and records the source', async () => {
    // A stand-in for the official site: a character page with a model sheet, an unrelated picture and an icon.
    const site = path.join(tmp, 'site');
    mkdirSync(site, { recursive: true });
    await picture(path.join(site, 'model.png'), '400x800');
    await picture(path.join(site, 'banner.png'), '600x400');
    await picture(path.join(site, 'icon.png'), '48x48');
    const server: Server = createServer((req, res) => {
      if (req.url === '/character/chisato') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(
          '<html><head><meta property="og:image" content="/img/banner.png"></head><body>' +
            '<img src="/img/model.png"><img data-src="/img/icon.png"></body></html>',
        );
      }
      const name = req.url?.replace('/img/', '') ?? '';
      try {
        res.setHeader('content-type', 'image/png');
        res.end(readFileSync(path.join(site, name)));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const root = path.join(tmp, 'ws');
    const ws = initWorkspace(root);
    const src = createSource(ws.db, { title: 'Lycoris Recoil OP' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 2_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 48 }, 'user');
    const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 47 }], 'daemon');
    mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
    await picture(ws.abs('projects/op/kf.jpg'), '320x180');
    setKeyframes(ws.db, shot!.id, [{ frame: 24, role: 'mid', path: 'projects/op/kf.jpg' }]);
    const chisato = createCastMember(ws.db, { projectId: project.id, label: '千束' }, 'daemon');
    const t = createTracklet(ws.db, { shotId: shot!.id, castMemberId: chisato.id });
    await picture(ws.abs('projects/op/crops/h.jpg'), '160x160');
    await picture(ws.abs('projects/op/crops/b.jpg'), '200x400');
    run(
      ws.db,
      `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json, head_crop_path, body_crop_path)
       VALUES ('det_1', :t, 24, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]', 'projects/op/crops/h.jpg', 'projects/op/crops/b.jpg')`,
      { t: t.id },
    );
    ws.close();

    const visions: VisionRequest[] = [];
    const provider = new FakeProvider({
      webSearch: () => ({
        text: `Official character page: ${base}/character/chisato — model sheet of Chisato Nishikigi.`,
        sources: [],
      }),
      vision: (req) => {
        visions.push(req);
        // Image 1 is her crop from the clip; 2 and 3 come from the web, in page order (banner, model).
        return {
          images: [
            { image: 2, sameCharacter: false, official: false, score: 0.1, kind: 'other' },
            {
              image: 3,
              sameCharacter: true,
              official: true,
              score: 0.92,
              kind: 'turnaround',
              note: 'model sheet',
            },
          ],
        };
      },
    });
    const daemon = await startDaemon({
      root,
      port: 0,
      config: { ...TEST_CONFIG, provider: 'fake' },
      provider,
      dispatch: false,
      log: () => {},
    });
    try {
      const cli = openWorkspace(root, { role: 'cli' });
      const job = queueReferenceSearch(cli, project.id, chisato.id, 'user');
      for (let i = 0; i < 300; i++) {
        const row = cli.db.prepare('SELECT status, error_json FROM jobs WHERE id = ?').get(job.id) as {
          status: string;
          error_json: string | null;
        };
        if (row.status === 'succeeded' || row.status === 'failed') {
          expect(row.error_json).toBeNull();
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // The icon was too small to download; the banner was judged not official art of her.
      expect(visions[0]?.images).toHaveLength(3);
      const refs = listReferences(cli.db, chisato.id);
      expect(refs.map((r) => [r.status, r.sourceUrl, r.pageUrl, r.label])).toEqual([
        ['candidate', `${base}/img/model.png`, `${base}/character/chisato`, 'turnaround：model sheet'],
      ]);
      // A URL the human pastes is taken as chosen.
      const pasted = await addReferenceFromUrl(cli, chisato.id, `${base}/img/banner.png`, 'user');
      expect(pasted).toMatchObject({ status: 'accepted', sourceUrl: `${base}/img/banner.png` });
      cli.close();
    } finally {
      await daemon.stop();
      server.close();
    }
  }, 60_000);
});
