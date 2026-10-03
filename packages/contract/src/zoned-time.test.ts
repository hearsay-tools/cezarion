import { describe, expect, it } from 'vitest';
import { isValidTimeZone, isoWeekday, localTimeZone, zonedParts, zonedWallTimeToUtc } from './zoned-time.ts';

describe('zoned time', () => {
  it('round-trips a plain wall time through an instant', () => {
    const at = zonedWallTimeToUtc(2026, 6, 15, 9, 30, 'Europe/Warsaw');
    expect(at).toBe(Date.UTC(2026, 5, 15, 7, 30));
    expect(zonedParts(at as number, 'Europe/Warsaw')).toMatchObject({
      year: 2026, month: 6, day: 15, hour: 9, minute: 30, weekday: 1,
    });
  });

  it('answers null for an unknown zone', () => {
    expect(zonedParts(0, 'Nowhere/Land')).toBeNull();
    expect(zonedWallTimeToUtc(2026, 1, 1, 0, 0, 'Nowhere/Land')).toBeNull();
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('Europe/Warsaw')).toBe(true);
    expect(isValidTimeZone('Nowhere/Land')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(localTimeZone())).toBe(true);
  });

  it('numbers ISO weekdays Monday to Sunday', () => {
    expect(isoWeekday(2026, 6, 15)).toBe(1);
    expect(isoWeekday(2026, 6, 21)).toBe(7);
  });
});
