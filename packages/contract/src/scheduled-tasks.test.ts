import { describe, expect, it } from 'vitest';
import { onceInstant } from './automation-schedule.ts';
import {
  parseDurationMinutes,
  resolveDelay,
  scheduleTaskRequestSchema,
  scheduledTasksRequestSchema,
} from './scheduled-tasks.ts';

describe('resolveDelay', () => {
  it('adds elapsed days across a DST change and reports the local wall time', () => {
    // 2026-10-22T13:00Z is 15:00 in Warsaw (CEST); seven days later the clocks have gone back.
    expect(resolveDelay('7d', Date.parse('2026-10-22T13:00:00Z'), 'Europe/Warsaw')).toBe('2026-10-29T14:00');
  });

  // Review of #1465: a wall time cannot name both instants of a clock overlap. A delay must still
  // never resolve earlier than asked, or the schedule is refused as past.
  it('a delay into the second pass of a New York overlap resolves after the overlap, not before now', () => {
    const now = Date.parse('2026-11-01T05:45:00Z'); // 01:45 EDT; at 06:00Z the clock goes back to 01:00 EST
    const at = resolveDelay('30m', now, 'America/New_York');
    expect(at).toBe('2026-11-01T02:00');
    expect(new Date(onceInstant({ type: 'once', at, timeZone: 'America/New_York' })!).toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it.each([
    ['America/New_York', '2026-11-01T04:30:00Z'],
    ['Europe/Warsaw', '2026-10-24T23:30:00Z'],
  ])('across the %s overlap no delay resolves earlier than now plus the delay', (timeZone, start) => {
    for (let minute = 0; minute <= 180; minute += 5) {
      const now = Date.parse(start) + minute * 60_000;
      const at = resolveDelay('30m', now, timeZone);
      expect(onceInstant({ type: 'once', at, timeZone })!, `${timeZone} ${new Date(now).toISOString()} → ${at}`).toBeGreaterThanOrEqual(now + 30 * 60_000);
    }
  });

  it('rounds up to the next minute', () => {
    expect(resolveDelay('30m', Date.parse('2026-10-22T13:00:20Z'), 'UTC')).toBe('2026-10-22T13:31');
    expect(resolveDelay('36h', Date.parse('2026-10-22T13:00:00Z'), 'UTC')).toBe('2026-10-24T01:00');
  });
});

describe('parseDurationMinutes', () => {
  it.each([['10m', 10], ['6h', 360], ['2d', 2_880], ['45 m', 45]])('%s', (input, minutes) => {
    expect(parseDurationMinutes(input)).toBe(minutes);
  });

  it('refuses anything else', () => {
    expect(() => parseDurationMinutes('soon')).toThrow(/30m, 6h or 7d/);
  });
});

describe('scheduleTaskRequestSchema', () => {
  const base = { name: 'Check the rollout', prompt: 'Check it' };

  it('takes at or delay, never both and never neither', () => {
    expect(scheduleTaskRequestSchema.safeParse({ ...base, at: '2026-10-29T09:00', time_zone: 'Europe/Warsaw' }).success).toBe(true);
    expect(scheduleTaskRequestSchema.safeParse({ ...base, delay: '7d' }).success).toBe(true);
    expect(scheduleTaskRequestSchema.safeParse({ ...base, at: '2026-10-29T09:00', delay: '7d' }).success).toBe(false);
    expect(scheduleTaskRequestSchema.safeParse(base).success).toBe(false);
  });

  it('refuses an at that is no real date and time', () => {
    const parsed = scheduleTaskRequestSchema.safeParse({ name: 'n', prompt: 'p', at: '2027-02-30T09:00' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['at']);
    expect(scheduledTasksRequestSchema.safeParse({ action: 'update', id: 'a1', at: '2026-13-01T25:99' }).success).toBe(false);
  });

  it('refuses unknown fields such as a run or project id', () => {
    expect(scheduleTaskRequestSchema.safeParse({ ...base, delay: '1h', project_id: 'other' }).success).toBe(false);
  });

  it('accepts a 100 000-character prompt', () => {
    expect(scheduleTaskRequestSchema.safeParse({ ...base, delay: '1h', prompt: 'x'.repeat(100_000) }).success).toBe(true);
  });
});

describe('scheduledTasksRequestSchema', () => {
  it('discriminates on action', () => {
    expect(scheduledTasksRequestSchema.safeParse({ action: 'list' }).success).toBe(true);
    expect(scheduledTasksRequestSchema.safeParse({ action: 'cancel', id: 'a' }).success).toBe(true);
    expect(scheduledTasksRequestSchema.safeParse({ action: 'update', id: 'a', delay: '2h' }).success).toBe(true);
    expect(scheduledTasksRequestSchema.safeParse({ action: 'cancel' }).success).toBe(false);
    expect(scheduledTasksRequestSchema.safeParse({ action: 'delete', id: 'a' }).success).toBe(false);
  });
});
