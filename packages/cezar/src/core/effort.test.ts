import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, parseEffort } from '@open-mercato/cezar-contract/effort';

describe('parseEffort', () => {
  it('accepts every canonical level, including xhigh', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const level of EFFORT_LEVELS) {
      expect(parseEffort(level)).toBe(level);
      expect(parseEffort(level.toUpperCase())).toBe(level);
    }
  });

  it('treats empty, auto, and unknown as unset so the harness keeps its default', () => {
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort(null)).toBeUndefined();
    expect(parseEffort('')).toBeUndefined();
    expect(parseEffort('  ')).toBeUndefined();
    expect(parseEffort('auto')).toBeUndefined();
    expect(parseEffort('foo')).toBeUndefined();
  });
});
