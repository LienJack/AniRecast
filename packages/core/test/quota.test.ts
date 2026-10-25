import path from 'node:path';
import { AniError } from '@anirecast/shared';
import { describe, expect, it } from 'vitest';
import {
  assertNotBlockedOut,
  assertQuota,
  createClip,
  createProject,
  createSource,
  DEFAULT_CONFIG,
  initWorkspace,
  quotaDayEnd,
  quotaDayStart,
  quotaStatus,
  recordProviderRequest,
  replaceShots,
  requestOutcomeOf,
  run,
  safetyBlockCount,
  updateSource,
  type Workspace,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

const OMNI = 'gemini-omni-1.1-flash';
const PT = 'America/Los_Angeles';
const at = (iso: string) => Date.parse(iso);
const config = () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.limits.perDay[OMNI] = 5;
  return c;
};

function workspaceWithShot(): { ws: Workspace; shotId: string } {
  const ws = initWorkspace(path.join(tempDir(), 'ws'));
  const src = createSource(ws.db, { title: 'op' }, 'user');
  updateSource(
    ws.db,
    src.id,
    { status: 'ready', fpsNum: 24, fpsDen: 1, durationMs: 1_000, width: 640, height: 360, filePath: 'x.mp4' },
    'daemon',
  );
  const project = createProject(ws.db, { name: 'OP', sourceId: src.id }, 'user');
  const clip = createClip(ws.db, { projectRef: project.id, inFrame: 0, outFrame: 24 }, 'user');
  const [shot] = replaceShots(ws.db, clip.id, [{ start: 0, end: 23 }], 'daemon');
  return { ws, shotId: shot!.id };
}

describe('quota day', () => {
  it('starts at midnight Pacific and follows daylight saving', () => {
    // 07:08 PDT on 25 Oct 2026 belongs to the day that began at 07:00 UTC.
    expect(quotaDayStart(at('2026-10-25T14:08:00Z'), PT)).toBe(at('2026-10-25T07:00:00Z'));
    expect(quotaDayEnd(at('2026-10-25T14:08:00Z'), PT)).toBe(at('2026-10-26T07:00:00Z'));
    // 1 Nov 2026 is 25 hours long: PDT midnight to PST midnight.
    expect(quotaDayStart(at('2026-11-01T20:00:00Z'), PT)).toBe(at('2026-11-01T07:00:00Z'));
    expect(quotaDayEnd(at('2026-11-01T20:00:00Z'), PT)).toBe(at('2026-11-02T08:00:00Z'));
  });
});

describe('daily request quota', () => {
  it('counts processed requests of the day, blocked ones included, and stops before the limit', () => {
    const { ws } = workspaceWithShot();
    const now = at('2026-10-25T14:00:00Z');
    const send = (
      outcome: Parameters<typeof recordProviderRequest>[1]['outcome'],
      when = now,
      detail?: string,
    ) =>
      recordProviderRequest(
        ws.db,
        { provider: 'gemini', model: OMNI, kind: 'video_edit', outcome, ...(detail ? { detail } : {}) },
        when,
      );
    send('ok', at('2026-10-24T20:00:00Z')); // yesterday, Pacific time
    send('ok');
    send('blocked');
    send('blocked');
    send('rate_limited'); // refused for the per-minute limit: never processed
    recordProviderRequest(ws.db, { provider: 'fake', model: OMNI, kind: 'video_edit', outcome: 'ok' }, now);

    expect(quotaStatus(ws.db, config(), OMNI, now)).toMatchObject({
      used: 3,
      remaining: 2,
      exhausted: false,
    });
    expect(() => assertQuota(ws.db, config(), OMNI, 2, { now })).not.toThrow();
    expect(() => assertQuota(ws.db, config(), OMNI, 3, { now })).toThrow(/Only 2 .* left today/);

    // Once the provider itself says the day's quota is gone, nothing more is sent until the reset.
    send('rate_limited', now, 'daily_quota: limit: 100 requests per day');
    expect(quotaStatus(ws.db, config(), OMNI, now)).toMatchObject({ remaining: 0, exhausted: true });
    expect(() => assertQuota(ws.db, config(), OMNI, 1, { now })).toThrow(/used up/);
    expect(() => assertQuota(ws.db, config(), OMNI, 1, { now: at('2026-10-26T07:30:00Z') })).not.toThrow();
    ws.close();
  });

  it('classifies failed calls the way the quota needs them', () => {
    const safety = new AniError(
      'provider_rejected',
      'Video edit: Request blocked due to safety violations (harmful content).',
    );
    expect(requestOutcomeOf(safety).outcome).toBe('blocked');
    expect(
      requestOutcomeOf(
        new AniError('provider_rejected', 'x', { details: { status: 429, dailyQuota: true } }),
      ),
    ).toMatchObject({ outcome: 'rate_limited', detail: expect.stringMatching(/^daily_quota:/) });
    expect(
      requestOutcomeOf(new AniError('transient', 'slow down', { details: { status: 429 } })).outcome,
    ).toBe('rate_limited');
    expect(requestOutcomeOf(new AniError('provider_rejected', 'bad argument')).outcome).toBe('rejected');
    expect(requestOutcomeOf(new Error('socket hang up')).outcome).toBe('error');
  });
});

describe('safety block cap', () => {
  it('stops a shot after repeated blocks, until a take comes back', () => {
    const { ws, shotId } = workspaceWithShot();
    const take = (version: number, status: string, error: string | null, createdAt: number) =>
      run(
        ws.db,
        `INSERT INTO takes (id, shot_id, version, tier, status, prompt, model, error, created_by, created_at)
         VALUES (:id, :shotId, :version, 'draft', :status, 'p', :model, :error, 'user', :createdAt)`,
        { id: `t${version}`, shotId, version, status, model: OMNI, error, createdAt },
      );
    const blocked = 'Video edit: Request blocked due to safety violations (harmful content).';
    take(1, 'failed', blocked, 1);
    take(2, 'failed', 'Cancelled', 2);
    expect(safetyBlockCount(ws.db, shotId)).toBe(1);
    take(3, 'failed', blocked, 3);
    expect(() => assertNotBlockedOut(ws.db, config(), shotId)).toThrow(/blocked this shot 2 times/);
    expect(() => assertNotBlockedOut(ws.db, config(), shotId, true)).not.toThrow();
    take(4, 'ready', null, 4);
    expect(safetyBlockCount(ws.db, shotId)).toBe(0);
    ws.close();
  });
});
