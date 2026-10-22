// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { dayTime, logTime, onceResolved, relativeIn } from '@/lib/automation-format'

describe('relativeIn', () => {
  const from = Date.parse('2026-07-14T12:00:00.000Z')
  it.each([
    [-5_000, 'now'],
    [0, 'now'],
    [30_000, 'in <1m'],
    [12 * 60_000, 'in 12m'],
    [59 * 60_000 + 59_000, 'in 59m'],
    [3 * 3_600_000, 'in 3h'],
    [23 * 3_600_000 + 59 * 60_000, 'in 23h'],
    [2 * 86_400_000, 'in 2d'],
    [9 * 86_400_000 + 3_600_000, 'in 9d'],
  ])('%d ms ahead reads %s', (delta, text) => {
    expect(relativeIn(from, from + delta)).toBe(text)
  })
})

describe('dayTime', () => {
  it('names the weekday and the wall time in the given zone', () => {
    // 02:00Z is 04:00 in Warsaw (CEST) and 22:00 the evening before in New York.
    expect(dayTime('2026-07-16T02:00:00.000Z', 'Europe/Warsaw')).toBe('Thu 04:00')
    expect(dayTime('2026-07-16T02:00:00.000Z', 'America/New_York')).toBe('Wed 22:00')
  })
  it('falls back to the raw instant for an unreadable one', () => {
    expect(dayTime('not a date', 'Europe/Warsaw')).toBe('not a date')
  })
})

describe('logTime', () => {
  const now = Date.parse('2026-07-16T10:00:00.000Z')
  const tz = 'Europe/Warsaw'
  it('shows the clock for today, a word for yesterday, the weekday inside a week, the date beyond', () => {
    expect(logTime('2026-07-16T02:00:00.000Z', tz, now)).toBe('Today 04:00')
    expect(logTime('2026-07-15T12:30:00.000Z', tz, now)).toBe('Yesterday 14:30')
    expect(logTime('2026-07-12T12:30:00.000Z', tz, now)).toBe('Sun 14:30')
    expect(logTime('2026-06-01T12:30:00.000Z', tz, now)).toBe('1 Jun 14:30')
  })
  it('judges "today" in the zone, not in UTC', () => {
    // 23:30Z on the 15th is already 01:30 on the 16th in Warsaw.
    expect(logTime('2026-07-15T23:30:00.000Z', tz, now)).toBe('Today 01:30')
  })
})

// Review of #1465: the cockpit reports the instant a one-time schedule really runs at, not only the
// typed wall time, when a DST change moves or doubles it.
describe('onceResolved', () => {
  const once = (at: string, timeZone: string) => ({ type: 'once' as const, at, timeZone })

  it('an ordinary time reads back as typed, with no note', () => {
    expect(onceResolved(once('2026-10-29T09:00', 'Europe/Warsaw'))).toEqual({ date: 'Thu 29 Oct 2026', time: '09:00' })
  })

  it('a time in a spring-forward gap reports the time it runs at and why', () => {
    expect(onceResolved(once('2027-03-28T02:30', 'Europe/Warsaw'))).toEqual({
      date: 'Sun 28 Mar 2027', time: '01:30', note: '02:30 does not exist on Sun 28 Mar 2027 in Europe/Warsaw.',
    })
  })

  it.each([
    ['Europe/Warsaw', '2026-10-25T02:30', 'the second', 'UTC+01:00'],
    ['America/New_York', '2026-11-01T01:30', 'the first', 'UTC-04:00'],
    // Review of #1469: Lord Howe goes back 30 minutes, not an hour.
    ['Australia/Lord_Howe', '2027-04-04T01:45', 'the second', 'UTC+10:30'],
  ])('a time in a %s overlap names which of the two it runs at', (timeZone, at, which, offset) => {
    expect(onceResolved(once(at, timeZone))).toEqual({
      date: expect.any(String), time: at.slice(11), note: `${at.slice(11)} happens twice that day; it runs at ${which} (${offset}).`,
    })
  })
})
