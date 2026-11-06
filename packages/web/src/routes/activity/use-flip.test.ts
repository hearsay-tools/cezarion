import { describe, expect, it } from 'vitest'

import { flipDeltas } from './use-flip'

describe('flipDeltas', () => {
  it('plays each card that moved from where it was; new, gone and still cards stay', () => {
    const before = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 200 }], ['gone', { x: 0, y: 400 }], ['still', { x: 396, y: 0 }]])
    const after = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 120 }], ['new', { x: 0, y: 300 }], ['still', { x: 396.4, y: 0 }]])
    expect(Object.fromEntries(flipDeltas(before, after))).toEqual({ b: { x: 0, y: 80 } })
  })
})
