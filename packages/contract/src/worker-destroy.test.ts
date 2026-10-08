import { describe, expect, it } from 'vitest';
import { workerDestroySchema, workerDestroyViewSchema } from './delegation.ts';
import { runRecordSchema } from './runs.ts';

describe('worker destroy retry state (hearsay-tools/cezarion#879)', () => {
  const requestedAt = '2026-10-07T12:00:00.000Z', nextAt = '2026-10-07T13:07:00.000Z';
  const base = { requestedAt, phase: 'incomplete' as const, remaining: ['worktree' as const] };

  it('the stored destroy stays exactly what a pre-retry cezar parses: retry state is never inside it', () => {
    expect(workerDestroySchema.parse(base)).toEqual(base);
    expect(workerDestroySchema.safeParse({ ...base, retry: { attempts: 3, nextAt } }).success).toBe(false);
  });

  it('the run record carries the retry state, beside the strict delegation an older cezar parses', () => {
    const retry = { attempts: 10, nextAt, needsAttention: true };
    expect(runRecordSchema.shape.destroyRetry.parse(retry)).toEqual(retry);
    expect(runRecordSchema.shape.destroyRetry.parse(undefined)).toBeUndefined();
  });

  it('inspection shows it on the destroy, with or without the attention flag', () => {
    expect(workerDestroyViewSchema.parse({ ...base, retry: { attempts: 3, nextAt } })).toEqual({ ...base, retry: { attempts: 3, nextAt } });
    expect(workerDestroyViewSchema.parse({ ...base, retry: { attempts: 10, nextAt, needsAttention: true } }).retry?.needsAttention).toBe(true);
    expect(workerDestroyViewSchema.parse(base).retry).toBeUndefined();
  });

  it.each([
    ['a false attention flag', { attempts: 3, nextAt, needsAttention: false }],
    ['zero attempts', { attempts: 0, nextAt }],
    ['a fractional attempt', { attempts: 1.5, nextAt }],
    ['a time that is not ISO', { attempts: 1, nextAt: 'soon' }],
    ['an unknown key', { attempts: 1, nextAt, reason: 'held' }],
  ])('rejects %s', (_, retry) => {
    expect(workerDestroyViewSchema.safeParse({ ...base, retry }).success).toBe(false);
  });
});
