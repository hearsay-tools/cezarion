import { describe, expect, it } from 'vitest';
import { DESTROY_ATTENTION_ATTEMPTS, DESTROY_BACKOFF, ORPHAN_BACKOFF, SCRATCH_BACKOFF, retryDelayMs } from './retry-backoff.ts';

describe('retry backoff (hearsay-tools/cezarion#879)', () => {
  const noJitter = () => 0;

  it('keeps the fast window exact: no jitter, no growth', () => {
    const forbidden = () => { throw new Error('the fast window must not jitter'); };
    for (const attempt of [0, 1, 2, 3, 4]) expect(retryDelayMs(attempt, DESTROY_BACKOFF, forbidden)).toBe(60_000);
  });

  it('doubles after the fast window up to the one-hour cap, and stays there', () => {
    expect([5, 6, 7, 8, 9, 10].map(attempt => retryDelayMs(attempt, DESTROY_BACKOFF, noJitter)))
      .toEqual([120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
    expect(retryDelayMs(50, DESTROY_BACKOFF, noJitter)).toBe(3_600_000);
    expect(SCRATCH_BACKOFF).toEqual(DESTROY_BACKOFF);
    expect(DESTROY_ATTENTION_ATTEMPTS).toBe(10);
  });

  it("keeps the orphan reprobe's 15-minute fast window, then backs off to the cap", () => {
    expect(retryDelayMs(59, ORPHAN_BACKOFF, noJitter)).toBe(15_000);
    expect(retryDelayMs(60, ORPHAN_BACKOFF, noJitter)).toBe(30_000);
    expect(retryDelayMs(61, ORPHAN_BACKOFF, noJitter)).toBe(60_000);
    expect(retryDelayMs(67, ORPHAN_BACKOFF, noJitter)).toBe(3_600_000);
  });

  it('jitter only stretches a delay, so a capped one is never under the cap', () => {
    const most = () => 0.999_999;
    const capped = retryDelayMs(10, DESTROY_BACKOFF, most);
    expect(capped).toBeGreaterThanOrEqual(3_600_000);
    expect(capped).toBeLessThan(3_960_000);
    const growing = retryDelayMs(5, DESTROY_BACKOFF, most);
    expect(growing).toBeGreaterThanOrEqual(120_000);
    expect(growing).toBeLessThan(132_000);
  });

  it('reads a negative or fractional attempt as its floor, never below zero', () => {
    expect(retryDelayMs(-3, DESTROY_BACKOFF, noJitter)).toBe(60_000);
    expect(retryDelayMs(5.7, DESTROY_BACKOFF, noJitter)).toBe(retryDelayMs(5, DESTROY_BACKOFF, noJitter));
  });
});
