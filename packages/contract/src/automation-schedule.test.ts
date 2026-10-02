import { describe, expect, it } from 'vitest';
import {
  cronOf,
  nextOccurrence,
  normalizeSchedule,
  occurrencesBetween,
  parseCron,
  scheduleLabel,
  type AutomationSchedule,
} from './automation-schedule.ts';

const SHAPES: AutomationSchedule[] = [
  { type: 'daily', hour: 4, minute: 0 },
  { type: 'weekdays', hour: 7, minute: 30 },
  { type: 'weekly', hour: 2, minute: 0, day: 2 },
  { type: 'hours', every: 6 },
];

describe('scheduleLabel', () => {
  it('words each shape', () => {
    expect(scheduleLabel({ type: 'daily', hour: 4 })).toBe('every day at 04:00');
    expect(scheduleLabel({ type: 'weekdays', hour: 7, minute: 30 })).toBe('weekdays at 07:30');
    expect(scheduleLabel({ type: 'hours', every: 6 })).toBe('every 6 hours');
    expect(scheduleLabel({ type: 'hours', every: 1 })).toBe('every hour');
    expect(scheduleLabel({ type: 'weekly', hour: 2, day: 2 })).toBe('Tuesdays at 02:00');
  });
});

describe('cron round trip', () => {
  it.each(SHAPES)('parseCron(cronOf(%j)) is the normalized shape', (shape) => {
    expect(normalizeSchedule(parseCron(cronOf(shape)) as AutomationSchedule)).toEqual(normalizeSchedule(shape));
  });

  it('refuses anything outside the four shapes', () => {
    expect(parseCron('*/5 * * * *')).toBeNull();
  });
});

describe('occurrencesBetween', () => {
  it('skips the weekend for weekdays', () => {
    const from = Date.UTC(2026, 5, 13); // Sat
    const to = Date.UTC(2026, 5, 16); // Tue 00:00
    expect(occurrencesBetween({ type: 'weekdays', hour: 9 }, from, to, 'UTC')).toEqual([Date.UTC(2026, 5, 15, 9)]);
  });

  it('fires a daily 02:30 exactly once per day across the Warsaw spring-forward gap', () => {
    const out = occurrencesBetween(
      { type: 'daily', hour: 2, minute: 30 },
      Date.UTC(2026, 2, 28),
      Date.UTC(2026, 2, 31),
      'Europe/Warsaw',
    );
    expect(out).toHaveLength(3);
    expect(new Set(out.map((at) => Math.floor(at / 86_400_000))).size).toBe(3);
  });

  it('fires a daily 02:30 exactly once on the Warsaw fall-back day', () => {
    const out = occurrencesBetween(
      { type: 'daily', hour: 2, minute: 30 },
      Date.UTC(2026, 9, 25, -2),
      Date.UTC(2026, 9, 26, -2),
      'Europe/Warsaw',
    );
    expect(out).toHaveLength(1);
  });

  it('yields four slots for every-6-hours on a 25-hour fall-back day', () => {
    // 2026-11-01 in New York: midnight local = 04:00Z, next midnight = 05:00Z (25 hours).
    const out = occurrencesBetween(
      { type: 'hours', every: 6 },
      Date.UTC(2026, 10, 1, 4),
      Date.UTC(2026, 10, 2, 5),
      'America/New_York',
    );
    expect(out).toHaveLength(4);
  });

  it('answers an empty list for an unknown zone', () => {
    expect(occurrencesBetween({ type: 'daily' }, 0, 86_400_000 * 3, 'Nowhere/Land')).toEqual([]);
  });
});

describe('nextOccurrence', () => {
  it('is strictly after the instant given', () => {
    const at = Date.UTC(2026, 5, 15, 4, 0);
    const next = nextOccurrence({ type: 'daily', hour: 4 }, at, 'UTC');
    expect(next).toBe(at + 86_400_000);
  });

  it('answers null for an unknown zone', () => {
    expect(nextOccurrence({ type: 'daily' }, 0, 'Nowhere/Land')).toBeNull();
  });
});
