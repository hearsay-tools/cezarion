import { describe, expect, it } from 'vitest';
import { defined } from './defined.ts';

describe('defined wire fields', () => {
  it('omits only undefined values and keeps falsy JSON values', () => {
    const value = defined({ absent: undefined, empty: '', zero: 0, off: false, nullable: null });
    expect(value).toEqual({ empty: '', zero: 0, off: false, nullable: null });
    expect(Object.hasOwn(value, 'absent')).toBe(false);
  });

  it('keeps nested values and leaves the input unchanged', () => {
    const nested = { value: 'kept' };
    const input = { absent: undefined, nested };
    const result = defined(input);
    expect(result.nested).toBe(nested);
    expect(Object.hasOwn(input, 'absent')).toBe(true);
  });
});
