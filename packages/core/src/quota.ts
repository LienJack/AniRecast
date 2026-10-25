import { AniError, isAniError, newId } from '@anirecast/shared';
import type { LocalConfig } from './config.ts';
import { all, type Db, one, run } from './db.ts';

export type RequestKind = 'image' | 'video_edit' | 'vision';
export type RequestOutcome = 'ok' | 'blocked' | 'rejected' | 'rate_limited' | 'error';

const DAY_MS = 86_400_000;

function zoneOffsetMs(at: number, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/** Start (epoch ms) of the quota day containing `now`: local midnight in `timeZone`, DST-aware. */
export function quotaDayStart(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const midnightUtc = Date.UTC(part('year'), part('month') - 1, part('day'));
  let start = midnightUtc - zoneOffsetMs(midnightUtc, timeZone);
  start = midnightUtc - zoneOffsetMs(start, timeZone);
  return start;
}

/** When the quota day containing `now` ends (the next local midnight, 23–25 h later around DST). */
export const quotaDayEnd = (now: number, timeZone: string): number =>
  quotaDayStart(quotaDayStart(now, timeZone) + DAY_MS + 3_600_000, timeZone);

/** How a failed provider call should be counted. Safety blocks and daily-quota refusals are told apart. */
export function requestOutcomeOf(error: unknown): { outcome: RequestOutcome; detail: string } {
  if (!isAniError(error)) return { outcome: 'error', detail: String(error).slice(0, 200) };
  const details = (error.details ?? {}) as { dailyQuota?: boolean; status?: number };
  const detail = error.message.slice(0, 200);
  if (details.dailyQuota) return { outcome: 'rate_limited', detail: `daily_quota: ${detail}` };
  if (details.status === 429) return { outcome: 'rate_limited', detail };
  if (error.code === 'provider_rejected')
    return { outcome: isSafetyBlock(error.message) ? 'blocked' : 'rejected', detail };
  return { outcome: 'error', detail };
}

/** Gemini's wording for a request its safety filter refused ("Request blocked due to safety violations"). */
export const isSafetyBlock = (message: string | null | undefined): boolean =>
  Boolean(message && /request blocked/i.test(message) && /safety/i.test(message));

export function recordProviderRequest(
  db: Db,
  input: {
    provider: string;
    model: string;
    kind: RequestKind;
    outcome: RequestOutcome;
    detail?: string | null;
    jobId?: string | null;
    projectId?: string | null;
    shotId?: string | null;
  },
  now: number = Date.now(),
): void {
  run(
    db,
    `INSERT INTO provider_requests (id, at, provider, model, kind, outcome, detail, job_id, project_id, shot_id)
     VALUES (:id, :at, :provider, :model, :kind, :outcome, :detail, :jobId, :projectId, :shotId)`,
    {
      id: newId('req', now),
      at: now,
      provider: input.provider,
      model: input.model,
      kind: input.kind,
      outcome: input.outcome,
      detail: input.detail ?? null,
      jobId: input.jobId ?? null,
      projectId: input.projectId ?? null,
      shotId: input.shotId ?? null,
    },
  );
}

export interface QuotaStatus {
  model: string;
  limit: number;
  /** Requests the model processed this quota day (ok, blocked or rejected); refusals for quota don't count. */
  used: number;
  /** Generation jobs for this model that are queued or running and will each send at least one request. */
  pending: number;
  remaining: number;
  /** The provider itself said the daily quota is used up, whatever the local count says. */
  exhausted: boolean;
  dayStart: number;
  resetsAt: number;
}

const COUNTED = `outcome IN ('ok', 'blocked', 'rejected') AND provider != 'fake'`;

/** Video-edit jobs still to send for `model` (take jobs carry the model on their take). */
function pendingVideoJobs(db: Db, model: string): number {
  return (
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM jobs j JOIN takes t ON t.id = json_extract(j.payload_json, '$.takeId')
       WHERE j.type = 'take.generate' AND j.status IN ('queued', 'running') AND t.model = :model`,
      { model },
    )?.n ?? 0
  );
}

export function quotaStatus(
  db: Db,
  config: LocalConfig,
  model: string,
  now: number = Date.now(),
): QuotaStatus {
  const tz = config.limits.quotaTimeZone;
  const dayStart = quotaDayStart(now, tz);
  const limit = config.limits.perDay[model] ?? Number.POSITIVE_INFINITY;
  const used =
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM provider_requests WHERE model = :model AND at >= :dayStart AND ${COUNTED}`,
      {
        model,
        dayStart,
      },
    )?.n ?? 0;
  const exhausted = Boolean(
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM provider_requests WHERE model = :model AND at >= :dayStart
         AND outcome = 'rate_limited' AND detail LIKE 'daily_quota:%'`,
      { model, dayStart },
    )?.n,
  );
  const pending = pendingVideoJobs(db, model);
  return {
    model,
    limit,
    used,
    pending,
    remaining: exhausted ? 0 : Math.max(0, limit - used - pending),
    exhausted,
    dayStart,
    resetsAt: quotaDayEnd(now, tz),
  };
}

/** Every limited model plus any model that sent requests today. */
export function quotaOverview(db: Db, config: LocalConfig, now: number = Date.now()): QuotaStatus[] {
  const dayStart = quotaDayStart(now, config.limits.quotaTimeZone);
  const seen = all<{ model: string }>(
    db,
    `SELECT DISTINCT model FROM provider_requests WHERE at >= :dayStart AND provider != 'fake'`,
    { dayStart },
  ).map((r) => r.model);
  return [...new Set([...Object.keys(config.limits.perDay), ...seen])].map((m) =>
    quotaStatus(db, config, m, now),
  );
}

const clock = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    at,
  );

/**
 * Refuses when `count` more requests to `model` would go past today's quota. `includePending` counts jobs
 * already queued (use it when queueing, not when a job is about to send its own request).
 */
export function assertQuota(
  db: Db,
  config: LocalConfig,
  model: string,
  count: number,
  opts: { includePending?: boolean; now?: number } = {},
): void {
  const q = quotaStatus(db, config, model, opts.now);
  const left = q.exhausted ? 0 : q.limit - q.used - (opts.includePending ? q.pending : 0);
  if (count <= left) return;
  const local = clock(q.resetsAt, Intl.DateTimeFormat().resolvedOptions().timeZone);
  throw new AniError(
    'provider_rejected',
    q.exhausted
      ? `The daily quota for ${model} is used up; it resets at ${local}`
      : `Only ${Math.max(0, left)} ${model} request(s) left today (${q.used} of ${q.limit} used, ${q.pending} queued); this needs ${count}`,
    {
      hint: `daily_quota: wait until ${local}, send fewer shots, or raise limits.perDay after upgrading the API tier.`,
      details: { dailyQuota: true, ...q },
    },
  );
}

/** Safety-filter refusals for a shot since its last take that came back (any tier); a success resets it. */
export function safetyBlockCount(db: Db, shotId: string): number {
  const since =
    one<{ at: number | null }>(
      db,
      `SELECT MAX(created_at) AS at FROM takes WHERE shot_id = :shotId AND status IN ('ready', 'approved', 'rejected', 'stale')`,
      { shotId },
    )?.at ?? 0;
  return all<{ error: string | null }>(
    db,
    `SELECT error FROM takes WHERE shot_id = :shotId AND status = 'failed' AND created_at > :since`,
    { shotId, since },
  ).filter((t) => isSafetyBlock(t.error)).length;
}

/** A shot blocked `maxSafetyBlocks` times is not sent again unless the caller insists. */
export function assertNotBlockedOut(db: Db, config: LocalConfig, shotId: string, retryBlocked = false): void {
  const blocks = safetyBlockCount(db, shotId);
  if (retryBlocked || blocks < config.limits.maxSafetyBlocks) return;
  throw new AniError('conflict', `The safety filter blocked this shot ${blocks} times`, {
    hint: 'safety_blocked: keep the original (anirecast review keep-original), change the board or prompt, or pass --retry-blocked.',
    details: { safetyBlocks: blocks, shotId },
  });
}
