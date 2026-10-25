import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPersonaImage,
  assignTracklet,
  createCastMember,
  createClip,
  createLook,
  createPersona,
  createProject,
  createSource,
  createTracklet,
  enqueueJob,
  getCastMember,
  initWorkspace,
  listAgentTasks,
  listLooks,
  mapCast,
  openWorkspace,
  replaceShots,
  run,
  updateSource,
} from '@anirecast/core';
import { ffmpeg } from '@anirecast/media';
import { FakeProvider, type VisionRequest } from '@anirecast/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.ts';
import { TEST_CONFIG } from './helpers.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'anirecast-tidy-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const still = (file: string, color: string) =>
  ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=160x200`, '-frames:v', '1', file]);

describe('tidying the cast with the JEV judge', () => {
  it('merges the same person and the same outfit, and hands outsiders to Codex', async () => {
    const root = path.join(tmp, 'ws');
    const ws = initWorkspace(root);
    const src = createSource(ws.db, { title: 'op' }, 'user');
    updateSource(ws.db, src.id, { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 4_000 }, 'daemon');
    const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
    const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 96 }, 'user');
    const shots = replaceShots(
      ws.db,
      clip.id,
      [0, 1, 2, 3].map((i) => ({ start: i * 24, end: i * 24 + 23 })),
      'daemon',
    );
    mkdirSync(ws.abs('projects/op/crops'), { recursive: true });
    const takina = createCastMember(ws.db, { projectId: project.id, label: '瀧奈' }, 'daemon');
    const extra = createCastMember(ws.db, { projectId: project.id, label: '角色 5' }, 'daemon');
    const uniform = createLook(ws.db, { castMemberId: takina.id, label: '造型 1' });
    const uniformBack = createLook(ws.db, { castMemberId: takina.id, label: '造型 2' });
    const mixed = createLook(ws.db, { castMemberId: takina.id, label: '造型 4' });
    const add = async (castId: string, lookId: string | null, shot: number, color: string) => {
      const t = createTracklet(ws.db, { shotId: shots[shot]!.id, castMemberId: castId, lookId });
      for (const part of ['head', 'body'])
        await still(ws.abs(`projects/op/crops/${t.id}-${part}.jpg`), color);
      run(
        ws.db,
        `INSERT INTO detections (id, tracklet_id, frame, head_bbox_json, body_bbox_json, head_crop_path, body_crop_path)
         VALUES (:id, :t, :f, '[0.4,0.1,0.5,0.3]', '[0.3,0.1,0.6,0.9]', :h, :b)`,
        {
          id: `det_${t.id}`,
          t: t.id,
          f: shot * 24 + 12,
          h: `projects/op/crops/${t.id}-head.jpg`,
          b: `projects/op/crops/${t.id}-body.jpg`,
        },
      );
      return t;
    };
    await add(takina.id, uniform.id, 0, '0x202040');
    await add(takina.id, uniformBack.id, 1, '0x202050');
    const stranger = await add(takina.id, mixed.id, 2, '0x806040');
    const locked = await add(extra.id, null, 3, '0x202044');
    // A decision the human made stays theirs.
    assignTracklet(ws.db, locked.id, extra.id, 'user');
    const ref = path.join(tmp, 'p.png');
    await still(ref, '0x30a0a0');
    const persona = createPersona(ws, { name: 'Claude' }, 'user');
    addPersonaImage(ws, persona.id, ref, { view: 'full' }, 'user');
    mapCast(ws.db, takina.id, persona.id, 'user');
    ws.close();

    const asked: VisionRequest[] = [];
    const provider = new FakeProvider({
      vision: (req) => {
        asked.push(req);
        return req.prompt.includes('same person?')
          ? { groups: [{ characters: [1, 2], confidence: 0.95, reason: 'same face and hair' }] }
          : {
              groups: [{ looks: [1, 2], label: '制服', confidence: 0.9, reason: 'same uniform from behind' }],
              strangers: [{ look: 3, cell: 1, confidence: 0.8, reason: 'brown hair, another girl' }],
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
      const job = enqueueJob(cli.db, {
        type: 'cast.tidy',
        lane: 'generate',
        projectId: project.id,
        payload: { projectId: project.id },
        requestedBy: 'user',
      });
      for (let i = 0; i < 300; i++) {
        const row = cli.db
          .prepare('SELECT status, result_json, error_json FROM jobs WHERE id = ?')
          .get(job.id) as {
          status: string;
          error_json: string | null;
        };
        if (row.status === 'succeeded' || row.status === 'failed') {
          expect(row.error_json ?? null).toBeNull();
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // The locked appearance kept "角色 5" from being merged away; the case goes to Codex instead.
      expect(getCastMember(cli.db, extra.id).status).toBe('active');
      const looks = listLooks(cli.db, takina.id);
      expect(looks.map((l) => l.label).sort()).toEqual(['制服', '造型 4']);
      const task = listAgentTasks(cli.db, { projectId: project.id }).find((t) => t.kind === 'cast_review');
      const cases = (task?.payload as { cases: Array<{ type: string; trackletIds?: string[] }> }).cases;
      expect(cases.map((c) => c.type).sort()).toEqual(['maybe_mixed', 'maybe_same']);
      expect(cases.find((c) => c.type === 'maybe_mixed')?.trackletIds).toEqual([stranger.id]);
      expect(asked).toHaveLength(2);
      cli.close();
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
