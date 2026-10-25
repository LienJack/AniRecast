import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertWithinBudget, initWorkspace, recordCost, spendBreakdown, totalSpend } from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('cost ledger', () => {
  it('sums real spend, ignores the fake provider and enforces the cap', () => {
    const ws = initWorkspace(path.join(tempDir(), 'ws'));
    recordCost(ws.db, { provider: 'gemini', model: 'gemini-omni-1.1-flash', tier: 'draft', usd: 0.44 });
    recordCost(ws.db, { provider: 'gemini', model: 'gemini-nano-banana-2.1', usd: 0.05 });
    recordCost(ws.db, { provider: 'fake', model: 'gemini-omni-1.1-flash', usd: 9 });
    expect(totalSpend(ws.db)).toBeCloseTo(0.49);
    expect(spendBreakdown(ws.db)[0]).toMatchObject({ model: 'gemini-omni-1.1-flash', calls: 1 });
    expect(() => assertWithinBudget(ws.db, 1, 0.4)).not.toThrow();
    expect(() => assertWithinBudget(ws.db, 1, 0.6)).toThrow(/Budget cap/);
    expect(() => assertWithinBudget(ws.db, null, 100)).not.toThrow();
    ws.close();
  });
});
