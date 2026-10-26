import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createClip,
  createProject,
  createSource,
  getProject,
  getShot,
  initWorkspace,
  openWorkspace,
  queueStyleAnalysis,
  replaceShots,
  setKeyframes,
  updateShot,
  updateSource,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider, type VisionRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-style-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('art style and lighting analysis', () => {
  it("writes the project's style notes and the lighting of the shots that get generated", async () => {
    const root = path.join(tmp, 'ws');
    const ws = initWorkspace(root);
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 3_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 72 }, 'user');
    const shots = replaceShots(
      ws.db,
      clip.id,
      [0, 1, 2].map((i) => ({ start: i * 24, end: i * 24 + 23 })),
      'daemon',
    );
    mkdirSync(ws.abs('projects/op'), { recursive: true });
    for (const [i, s] of shots.entries()) {
      await ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x335577:size=320x180',
        '-frames:v',
        '1',
        ws.abs(`projects/op/kf${i}.jpg`),
      ]);
      setKeyframes(ws.db, s.id, [{ frame: s.startFrame + 12, role: 'mid', path: `projects/op/kf${i}.jpg` }]);
    }
    updateShot(ws.db, shots[0]!.id, { mode: 'replace' }, 'user');
    updateShot(ws.db, shots[1]!.id, { mode: 'keep' }, 'user');
    updateShot(ws.db, shots[2]!.id, { mode: 'clean', lighting: 'Already known.' }, 'user');
    ws.close();

    const asked: VisionRequest[] = [];
    const provider = new FakeProvider({
      vision: (req) => {
        asked.push(req);
        return req.prompt.includes('drawing style')
          ? { style: 'Thin dark lines, two-tone cel shading, soft pastel palette.' }
          : { lighting: 'Soft daylight from the upper left, cool shadows.' };
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
      const job = queueStyleAnalysis(cli, project.id, 'user');
      for (let i = 0; i < 300; i++) {
        const row = cli.db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id) as { status: string };
        if (row.status === 'succeeded' || row.status === 'failed') {
          expect(row.status).toBe('succeeded');
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(getProject(cli.db, project.id).settings.styleNotes).toBe(
        'Thin dark lines, two-tone cel shading, soft pastel palette.',
      );
      // Only the replace shot was missing lighting; the kept shot is not generated, the clean one had it.
      expect(getShot(cli.db, shots[0]!.id).lighting).toBe('Soft daylight from the upper left, cool shadows.');
      expect(getShot(cli.db, shots[1]!.id).lighting).toBeNull();
      expect(getShot(cli.db, shots[2]!.id).lighting).toBe('Already known.');
      expect(asked).toHaveLength(2);
      cli.close();
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
