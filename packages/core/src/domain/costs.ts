import { AniError, newId } from '@anirecast/shared';
import { all, type Db, one, run, toJson } from '../db.ts';

export interface CostEntry {
  jobId?: string | null;
  projectId?: string | null;
  provider: string;
  model: string;
  tier?: string | null;
  usage?: unknown;
  usd: number;
}

export function recordCost(db: Db, entry: CostEntry, now: number = Date.now()): void {
  run(
    db,
    `INSERT INTO cost_ledger (id, job_id, project_id, provider, model, tier, usage_json, usd, at)
     VALUES (:id, :jobId, :projectId, :provider, :model, :tier, :usage, :usd, :now)`,
    {
      id: newId('cost', now),
      jobId: entry.jobId ?? null,
      projectId: entry.projectId ?? null,
      provider: entry.provider,
      model: entry.model,
      tier: entry.tier ?? null,
      usage: toJson(entry.usage ?? {}),
      usd: entry.usd,
      now,
    },
  );
}

/** Real spend only; the fake provider records zero-cost rows that never count. */
export function totalSpend(db: Db, filter: { projectId?: string } = {}): number {
  const row = one<{ usd: number | null }>(
    db,
    `SELECT SUM(usd) AS usd FROM cost_ledger WHERE provider != 'fake' ${filter.projectId ? 'AND project_id = :projectId' : ''}`,
    filter.projectId ? { projectId: filter.projectId } : {},
  );
  return row?.usd ?? 0;
}

export function spendBreakdown(
  db: Db,
  projectId?: string,
): Array<{ model: string; tier: string | null; calls: number; usd: number }> {
  return all(
    db,
    `SELECT model, tier, COUNT(*) AS calls, SUM(usd) AS usd FROM cost_ledger
     WHERE provider != 'fake' ${projectId ? 'AND project_id = :projectId' : ''}
     GROUP BY model, tier ORDER BY usd DESC`,
    projectId ? { projectId } : {},
  );
}

/** Refuses a paid call whose estimate would push recorded spend past the cap. */
export function assertWithinBudget(db: Db, capUsd: number | null, estimateUsd: number): void {
  if (capUsd === null) return;
  const spent = totalSpend(db);
  if (spent + estimateUsd > capUsd) {
    throw new AniError(
      'budget_exceeded',
      `Budget cap USD ${capUsd.toFixed(2)} reached (spent ${spent.toFixed(2)}, this call ~${estimateUsd.toFixed(2)})`,
      {
        hint: 'Raise budget.capUsd in ~/.config/anirecast/config.json, or switch to the fake provider.',
        details: { spent, capUsd, estimateUsd },
      },
    );
  }
}
