import { describe, expect, it } from 'vitest'

import { endsOnScreen, isOnScreen } from './line-viewport'

const view = { x0: 0, y0: 0, x1: 1000, y1: 600 }
const on = { x: 0, y: 100, w: 300, h: 120 }
const below = { x: 396, y: 900, w: 300, h: 120 }
const above = { x: 396, y: -400, w: 300, h: 120 }

describe('endsOnScreen', () => {
  it('draws a full line when both ends are on screen', () => {
    expect(endsOnScreen(on, { ...on, x: 396 }, view)).toBe('both')
  })

  it('keeps the end that is on screen when the other is off screen or not on the view', () => {
    expect(endsOnScreen(on, below, view)).toBe('sender')
    expect(endsOnScreen(above, on, view)).toBe('recipient')
    expect(endsOnScreen(on, undefined, view)).toBe('sender')
  })

  it('draws no line when neither end is on screen', () => {
    expect(endsOnScreen(above, below, view)).toBe('none')
    expect(endsOnScreen(undefined, below, view)).toBe('none')
  })

  it('counts a card cut by the viewport edge as on screen', () => {
    expect(isOnScreen({ x: 0, y: 550, w: 300, h: 120 }, view)).toBe(true)
  })
})
