import { assertQuota, type RequestKind, recordProviderRequest, requestOutcomeOf } from '@anirecast/core';
import type { JobContext } from '../runner.ts';

/**
 * Sends one provider request for a job. When today's quota for the model is used up it refuses before anything
 * leaves the machine; otherwise it records the outcome, including blocked and refused requests, which cost
 * nothing but still count against the daily quota.
 */
export async function metered<T>(
  ctx: JobContext,
  req: { model: string; kind: RequestKind; shotId?: string | null },
  call: () => Promise<T>,
): Promise<T> {
  const { workspace: ws, services, job } = ctx;
  const provider = services.provider.name;
  if (provider !== 'fake') assertQuota(ws.db, services.config, req.model, 1);
  const base = {
    provider,
    model: req.model,
    kind: req.kind,
    jobId: job.id,
    projectId: job.projectId,
    shotId: req.shotId ?? null,
  };
  try {
    const result = await call();
    recordProviderRequest(ws.db, { ...base, outcome: 'ok' });
    return result;
  } catch (error) {
    if (!ctx.signal.aborted) recordProviderRequest(ws.db, { ...base, ...requestOutcomeOf(error) });
    throw error;
  }
}
