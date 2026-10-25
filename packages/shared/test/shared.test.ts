import { describe, expect, it } from 'vitest';
import { AniError, exitCodeFor, newId, toEnvelopeError, ulid } from '../src/index.ts';

describe('ids', () => {
  it('produces sortable 26-char ULIDs', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  it('prefixes lowercase ids', () => {
    expect(newId('shot')).toMatch(/^shot_[0-9a-hjkmnp-tv-z]{26}$/);
  });
});

describe('envelope', () => {
  it('maps AniError to a structured error and exit code', () => {
    const err = new AniError('daemon_not_running', 'AniRecast 沒在執行', { hint: 'anirecast serve' });
    expect(toEnvelopeError(err)).toEqual({
      code: 'daemon_not_running',
      message: 'AniRecast 沒在執行',
      hint: 'anirecast serve',
    });
    expect(exitCodeFor('daemon_not_running')).toBe(3);
    expect(toEnvelopeError(new Error('boom'))).toEqual({ code: 'internal', message: 'boom' });
  });
});
