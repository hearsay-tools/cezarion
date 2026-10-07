import { describe, expect, it } from 'vitest';
import { workerDestroySchema } from './delegation.ts';

describe('worker destroy retry state (hearsay-tools/cezarion#879)', () => {
  const requestedAt = '2026-10-07T12:00:00.000Z', nextAt = '2026-10-07T13:07:00.000Z';
  const base = { requestedAt, phase: 'incomplete' as const, remaining: ['worktree' as const] };

  it('parses a destroy with retry state, with or without the attention flag', () => {
    expect(workerDestroySchema.parse({ ...base, retry: { attempts: 3, nextAt } })).toEqual({ ...base, retry: { attempts: 3, nextAt } });
    expect(workerDestroySchema.parse({ ...base, retry: { attempts: 10, nextAt, needsAttention: true } }).retry?.needsAttention).toBe(true);
    expect(workerDestroySchema.parse(base).retry).toBeUndefined();
  });

  it.each([
    ['a false attention flag', { attempts: 3, nextAt, needsAttention: false }],
    ['zero attempts', { attempts: 0, nextAt }],
    ['a fractional attempt', { attempts: 1.5, nextAt }],
    ['a time that is not ISO', { attempts: 1, nextAt: 'soon' }],
    ['an unknown key', { attempts: 1, nextAt, reason: 'held' }],
  ])('rejects %s', (_, retry) => {
    expect(workerDestroySchema.safeParse({ ...base, retry }).success).toBe(false);
  });
});
