import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPersonaImage,
  createCastMember,
  createClip,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  designOverview,
  initWorkspace,
  mapCast,
  openWorkspace,
  queueCastAnalysis,
  recomputeShotModes,
  replaceShots,
  run,
  setKeyframes,
  updateSource,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider, type ImageGenRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-design-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const still = (file: string, color: string, size = '320x480') =>
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=${size}`, '-frames:v', '1', file]);

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('original character analysis → redesign', () => {
  it('analyses the original, then draws her expressions from one reference grid', async () => {
    const root = path.join(tmp, 'ws');
    const ws = initWorkspace(root);
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 2_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 48 }, 'user');
    const shots = replaceShots(
      ws.db,
      clip.id,
      [
        { start: 0, end: 23 },
        { start: 24, end: 47 },
      ],
      'daemon',
    );
    mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
    const girl = createCastMember(ws.db, { projectId: project.id, label: 'girl' }, 'daemon');
    for (const [i, shot] of shots.entries()) {
      await still(ws.abs(`projects/op/kf${i}.jpg`), '0x335577', '640x360');
      setKeyframes(ws.db, shot.id, [
        { frame: shot.startFrame + 12, role: 'mid', path: `projects/op/kf${i}.jpg` },
      ]);
      await still(ws.abs(`projects/op/crops/h${i}.jpg`), i ? '0xaa3333' : '0x33aa33', '160x160');
      await still(ws.abs(`projects/op/crops/b${i}.jpg`), i ? '0xaa6666' : '0x66aa66');
      const t = createTracklet(ws.db, { shotId: shot.id, castMemberId: girl.id });
      run(
        ws.db,
        `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json, head_crop_path, body_crop_path)
         VALUES (:id, :t, :frame, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]', :h, :b)`,
        {
          id: `det_${i}`,
          t: t.id,
          frame: shot.startFrame + 12,
          h: `projects/op/crops/h${i}.jpg`,
          b: `projects/op/crops/b${i}.jpg`,
        },
      );
    }
    const ref = path.join(tmp, 'persona.png');
    await still(ref, '0x30a0a0', '512x768');
    const persona = createPersona(ws, { name: 'Claude' }, 'user');
    addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
    mapCast(ws.db, girl.id, persona.id, 'user');
    recomputeShotModes(ws.db, project.id);
    ws.close();

    const images: ImageGenRequest[] = [];
    const fake = new FakeProvider({
      vision: () => ({
        style: 'thin lines, two-tone shading',
        body: '7 heads tall',
        outfit: 'navy uniform',
        expressions: [
          { label: 'glare', description: 'narrowed eyes', appearance: 1 },
          { label: 'smile', appearance: 2 },
        ],
        poses: [{ label: 'running', appearance: 2 }],
      }),
    });
    const provider = Object.assign(Object.create(fake) as FakeProvider, {
      generateImage: (req: ImageGenRequest) => {
        images.push(req);
        return fake.generateImage(req);
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
      queueCastAnalysis(cli, project.id, girl.id, 'user', { thenKinds: ['expressions'] });
      const sheet = await waitFor(() => {
        const b = designOverview(cli.db, project.id).bindings[0];
        const s = b?.sheets.find((x) => x.kind === 'expressions')?.latest;
        return s && (s.status === 'ready' || s.status === 'failed') ? { b, s } : undefined;
      });
      expect(sheet.b.analysis?.data?.expressions.map((e) => e.label)).toEqual(['glare', 'smile']);
      expect(sheet.s.status).toBe('ready');
      expect(sheet.s.inputs.map((i) => i.role)).toEqual([`persona:${persona.id}`, 'tile:1', 'tile:2']);
      // The image model sees the library reference and one grid of the original's two expressions.
      expect(images.at(-1)?.images.map((i) => path.basename(i.path))).toEqual([
        expect.stringMatching(/\.png$/),
        'expressions-v001-reference.jpg',
      ]);
      const stem = (sheet.s.path as string).replace(/\.\w+$/, '');
      expect(existsSync(cli.abs(`${stem}-reference.jpg`))).toBe(true);
      const provenance = JSON.parse(readFileSync(cli.abs(`${stem}.json`), 'utf8'));
      expect(provenance).toMatchObject({ castMemberId: girl.id, referenceGrid: `${stem}-reference.jpg` });
      cli.close();
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
