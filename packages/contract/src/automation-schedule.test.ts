import { describe, expect, it } from 'vitest';
import {
  automationScheduleSchema,
  cronOf,
  nextOccurrence,
  normalizeSchedule,
  occurrencesBetween,
  onceCutoff,
  onceInstant,
  onceWallParts,
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

  it('yields each instant once for every-hour across a spring-forward gap', () => {
    // The nonexistent 02:00 settles onto a neighbouring slot's instant; it must not repeat it,
    // or the preview shows two equal rows and a catch-up counts one miss too many.
    for (const [zone, from] of [['Europe/Warsaw', '2026-03-28T22:00:00Z'], ['America/New_York', '2026-03-08T04:00:00Z']] as const) {
      const fromMs = Date.parse(from);
      const runs = occurrencesBetween({ type: 'hours', every: 1 }, fromMs, fromMs + 6 * 3_600_000, zone);
      expect(new Set(runs).size).toBe(runs.length);
      expect(runs).toHaveLength(6);
      expect(runs).toEqual([...runs].sort((a, b) => a - b));
    }
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

describe('once', () => {
  const once = { type: 'once', at: '2026-10-29T09:00', timeZone: 'Europe/Warsaw' } as const;

  it('resolves its instant in its own zone', () => {
    expect(new Date(onceInstant(once)!).toISOString()).toBe('2026-10-29T08:00:00.000Z');
  });

  it('yields its single occurrence regardless of the caller zone', () => {
    const at = onceInstant(once)!;
    expect(occurrencesBetween(once, at - 1, at + 1, 'UTC')).toEqual([at]);
    expect(occurrencesBetween(once, at + 1, at + 86_400_000, 'UTC')).toEqual([]);
    expect(nextOccurrence(once, at - 60_000, 'UTC')).toBe(at);
    expect(nextOccurrence(once, at, 'UTC')).toBeNull();
  });

  // Review of #1465: the text format alone admitted dates that do not exist.
  it.each(['2027-02-30T09:00', '2026-13-01T09:00', '2026-10-29T24:00', '2026-10-29T25:99', '2026-00-10T09:00', '2026-10-00T09:00'])('refuses the impossible wall time %s', (at) => {
    const parsed = automationScheduleSchema.safeParse({ ...once, at });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ['at'], message: 'at is not a real date and time' });
    expect(onceWallParts(at)).toBeNull();
  });

  it('admits 29 February only in a leap year', () => {
    expect(automationScheduleSchema.safeParse({ ...once, at: '2028-02-29T09:00' }).success).toBe(true);
    expect(automationScheduleSchema.safeParse({ ...once, at: '2027-02-29T09:00' }).success).toBe(false);
  });

  it('labels', () => {
    expect(scheduleLabel(once)).toBe('once on Thu 29 Oct 2026 at 09:00 (Europe/Warsaw)');
  });

  it('floors the cutoff at the grace window', () => {
    expect(onceCutoff({ ...once, latestStartMinutes: 10 })! - onceInstant(once)!).toBe(600_000);
    expect(onceCutoff({ ...once, latestStartMinutes: 360 })! - onceInstant(once)!).toBe(21_600_000);
    expect(onceCutoff(once)).toBeNull();
  });

  it('resolves a spring-forward wall time to one instant', () => {
    expect(onceInstant({ type: 'once', at: '2026-03-29T02:30', timeZone: 'Europe/Warsaw' })).not.toBeNull();
  });

  it('answers null for a recurring shape', () => {
    expect(onceInstant({ type: 'daily', hour: 4 })).toBeNull();
  });

  it.each([
    [{ type: 'once', at: '2026-10-29T09:00' }, 'timeZone'],
    [{ type: 'once', timeZone: 'UTC' }, 'at'],
    [{ type: 'once', at: '2026-10-29 09:00', timeZone: 'UTC' }, 'at'],
    [{ type: 'once', at: '2026-10-29T09:00', timeZone: 'Mars/Base' }, 'unknown time zone \\"Mars/Base\\"; use an IANA name such as Europe/Warsaw'],
    [{ type: 'once', at: '2026-10-29T09:00', timeZone: 'UTC', latestStartMinutes: 5 }, 'latestStartMinutes'],
    [{ type: 'once', at: '2026-10-29T09:00', timeZone: 'UTC', latestStartMinutes: 43_201 }, 'latestStartMinutes'],
    [{ type: 'daily', timeZone: 'UTC' }, 'timeZone'],
    [{ type: 'daily', at: '2026-10-29T09:00' }, 'at'],
    [{ type: 'once', at: '2026-10-29T09:00', timeZone: 'UTC', hour: 4 }, 'hour'],
  ])('refuses %j', (input, needle) => {
    const result = automationScheduleSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(needle);
  });

  it('accepts a full once shape', () => {
    expect(automationScheduleSchema.safeParse({ ...once, latestStartMinutes: 60 }).success).toBe(true);
  });

  it('has no cron form', () => {
    expect(() => cronOf(once)).toThrow();
  });
});
