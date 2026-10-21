import { describe, expect, it } from 'vitest';
import { nextLineEntry } from './line-order.ts';

/** The line order (spec 2026-10-17-unified-waits § Slots and the line, hearsay-tools/cezarion#1236):
 *  wakes of started runs first, by when they joined; then runs that have not started, in queue order. */
describe('nextLineEntry', () => {
  const pick = (queue: string[], wakes: Record<string, number>, blocked: string[] = []) =>
    nextLineEntry(queue, (id) => wakes[id], (id) => !blocked.includes(id));

  it('takes a wake before an unstarted run that queued earlier', () => {
    expect(pick(['task', 'wake'], { wake: 50 })).toBe(1);
  });

  it('orders wakes by when they joined, not by queue position', () => {
    expect(pick(['task', 'late', 'early'], { late: 20, early: 10 })).toBe(2);
  });

  it('keeps unstarted runs first come first served', () => {
    expect(pick(['first', 'second'], {})).toBe(0);
  });

  it('skips a blocked wake for the next wake, then for an unstarted run', () => {
    expect(pick(['task', 'held', 'next'], { held: 1, next: 2 }, ['held'])).toBe(2);
    expect(pick(['task', 'held'], { held: 1 }, ['held'])).toBe(0);
  });

  it('answers -1 when every entry is blocked', () => {
    expect(pick(['a', 'b'], { b: 1 }, ['a', 'b'])).toBe(-1);
    expect(pick([], {})).toBe(-1);
  });
});
