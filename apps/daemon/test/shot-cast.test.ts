import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCastMember,
  createClip,
  createProject,
  createSource,
  createTracklet,
  getCastMember,
  getTracklet,
  initWorkspace,
  latestShotCastCheck,
  listCast,
  openWorkspace,
  queueShotCast,
  replaceShots,
  run,
  setKeyframes,
  updateSource,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider, type VisionRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-shot-cast-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const picture = (file: string, size: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${size}`, '-frames:v', '1', file]);

describe('找出這一鏡的角色', () => {
  it("assigns what the vision model sees, leaves the human's decisions alone and reports the rest", async () => {
    const root = path.join(tmp, 'ws');
    const ws = initWorkspace(root);
    const src = createSource(ws.db, { title: 'Lycoris Recoil OP' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 4_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 96 }, 'user');
    const [door, other] = replaceShots(
      ws.db,
      clip.id,
      [
        { start: 0, end: 47 },
        { start: 48, end: 95 },
      ],
      'daemon',
    );
    mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
    for (const s of [door!, other!]) {
      await picture(ws.abs(`projects/op/${s.id}.jpg`), '320x180');
      setKeyframes(ws.db, s.id, [{ frame: s.startFrame + 12, role: 'mid', path: `projects/op/${s.id}.jpg` }]);
    }
    let n = 0;
    const person = async (
      shotId: string,
      castMemberId: string | null,
      assignedBy: 'auto' | 'codex' | 'user',
    ) => {
      const t = createTracklet(ws.db, { shotId, castMemberId, assignedBy }, Date.now() + n);
      n++;
      await picture(ws.abs(`projects/op/crops/h${n}.jpg`), '160x160');
      await picture(ws.abs(`projects/op/crops/b${n}.jpg`), '200x400');
      run(
        ws.db,
        `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json, head_crop_path, body_crop_path)
         VALUES (:id, :t, 12, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]', :h, :b)`,
        { id: `det_${n}`, t: t.id, h: `projects/op/crops/h${n}.jpg`, b: `projects/op/crops/b${n}.jpg` },
      );
      return t;
    };
    const chisato = createCastMember(ws.db, { projectId: project.id, label: '千束' }, 'daemon');
    const takina = createCastMember(ws.db, { projectId: project.id, label: '瀧奈' }, 'daemon');
    await person(other!.id, chisato.id, 'auto');
    await person(other!.id, takina.id, 'auto');
    // The shot at the door: one person the human assigned, one Codex dismissed, one never identified.
    const locked = await person(door!.id, chisato.id, 'user');
    const dismissed = await person(door!.id, null, 'codex');
    const stranger = await person(door!.id, null, 'auto');
    const another = await person(door!.id, null, 'auto');
    ws.close();

    const asked: VisionRequest[] = [];
    const provider = new FakeProvider({
      vision: (req) => {
        asked.push(req);
        // Known characters come most-seen first: 1 = 千束 (two shots), 2 = 瀧奈.
        return {
          people: [
            { person: 1, kind: 'character', character: 2, confidence: 0.7, reason: '黑長髮' },
            { person: 2, kind: 'character', character: 1, confidence: 0.92, reason: '金色短髮、紅色制服' },
            { person: 3, kind: 'new', label: '黑衣男子', confidence: 0.8, reason: '不在角色表裡' },
            { person: 4, kind: 'new', label: '黑衣男子', confidence: 0.9, reason: '同一個人' },
          ],
          missed: [{ character: 2, reason: '背景裡還有瀧奈' }],
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
      const job = queueShotCast(cli, door!.id, 'user');
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
      // Frame, four people, two known characters.
      expect(asked[0]?.images).toHaveLength(7);
      // The human's decision stands; the model's other opinion is only reported.
      expect(getTracklet(cli.db, locked.id)).toMatchObject({ castMemberId: chisato.id, assignedBy: 'user' });
      // Codex had dismissed 千束 at the door: the model brings her back, unlocked for the human to confirm.
      expect(getTracklet(cli.db, dismissed.id)).toMatchObject({
        castMemberId: chisato.id,
        assignedBy: 'codex',
      });
      // Someone not in the cast becomes one new character, however many times the model names them.
      const created = listCast(cli.db, project.id).filter((c) => c.label === '黑衣男子');
      expect(created).toHaveLength(1);
      expect(getTracklet(cli.db, stranger.id)).toMatchObject({
        castMemberId: created[0]?.id,
        assignedBy: 'codex',
      });
      expect(getTracklet(cli.db, another.id).castMemberId).toBe(created[0]?.id);
      expect(getCastMember(cli.db, takina.id).shotIds).toEqual([other!.id]);
      const check = latestShotCastCheck(cli, door!.id);
      expect(check?.result?.people.map((p) => [p.kind, p.label, p.applied, p.locked])).toEqual([
        ['character', '瀧奈', false, true],
        ['character', '千束', true, false],
        ['new', '黑衣男子', true, false],
        ['new', '黑衣男子', true, false],
      ]);
      expect(check?.result?.missed).toEqual([{ castId: takina.id, label: '瀧奈', reason: '背景裡還有瀧奈' }]);
      cli.close();
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
