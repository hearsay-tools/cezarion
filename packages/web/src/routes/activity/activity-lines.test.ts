import { describe, expect, it } from 'vitest'

import { NOW, iso } from './activity.testkit'
import { shortText, spanUsed, windowUsed } from './activity-lines'

describe('request label text', () => {
  it.each([
    ['  Review\t\n  the  API  ', 'Review the API'],
    ['   \n\t ', ''],
    ['Ready?', 'Ready?'],
    ['1234567890123456789012345678', '1234567890123456789012345678'],
    ['12345678901234567890123456789', '123456789012345678901234567…'],
    ['abcdefghijklmnopqrstuvwxyz tail', 'abcdefghijklmnopqrstuvwxyz…'],
  ])('shortens %j to %j', (text, expected) => {
    expect(shortText(text)).toBe(expected)
  })
})

describe('deadline progress', () => {
  it('omits progress when a request has no deadline', () => {
    expect(windowUsed({ createdAt: iso(-25_000) }, NOW)).toBeUndefined()
  })

  it('uses the request creation time and deadline', () => {
    expect(windowUsed({ createdAt: iso(-25_000), deadline: iso(75_000) }, NOW)).toBe(0.25)
  })

  it.each([
    ['before the start', -50_000, 0],
    ['at the start', -25_000, 0],
    ['inside the window', 0, 0.25],
    ['at the deadline', 75_000, 1],
    ['after the deadline', 100_000, 1],
  ])('clamps progress %s', (_name, offset, expected) => {
    expect(spanUsed(iso(-25_000), iso(75_000), NOW + offset)).toBe(expected)
  })

  it.each([
    ['invalid start', 'invalid', iso(75_000)],
    ['invalid deadline', iso(-25_000), 'invalid'],
    ['equal endpoints', iso(25_000), iso(25_000)],
    ['reversed endpoints', iso(75_000), iso(25_000)],
  ])('shows full progress for %s', (_name, start, end) => {
    expect(spanUsed(start, end, NOW)).toBe(1)
  })
})
