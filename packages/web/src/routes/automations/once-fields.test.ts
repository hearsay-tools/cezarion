import { describe, expect, it } from 'vitest'

import { defaultOnceAt } from './once-fields'

describe('defaultOnceAt', () => {
  it('is the next local calendar date at 09:00', () => {
    expect(defaultOnceAt('UTC', Date.parse('2026-10-22T13:00:00Z'))).toBe('2026-10-23T09:00')
  })

  it('moves to the next date in the early hours of a fall-back day', () => {
    // 00:30 in Warsaw on 2026-10-25, a 25-hour day: 24 hours later is still the 25th.
    expect(defaultOnceAt('Europe/Warsaw', Date.parse('2026-10-24T22:30:00Z'))).toBe('2026-10-26T09:00')
  })

  it('crosses a month end', () => {
    expect(defaultOnceAt('UTC', Date.parse('2026-10-31T23:00:00Z'))).toBe('2026-11-01T09:00')
  })
})
