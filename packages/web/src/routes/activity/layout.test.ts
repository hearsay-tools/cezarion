// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { columnCount, placeCards, samePlacement } from './layout'

describe('columnCount', () => {
  it.each([
    [0, 1],
    [299, 1],
    [695, 1],
    [696, 2],
    [1091, 2],
    [1092, 3],
    [Number.NaN, 1],
  ])('%i px → %i columns', (width, count) => {
    expect(columnCount(width)).toBe(count)
  })
})

describe('placeCards (D9: stable placement)', () => {
  it('fills the shortest column first, leftmost on a tie', () => {
    expect(placeCards(undefined, ['a', 'b', 'c', 'd'], 3)).toEqual([['a', 'd'], ['b'], ['c']])
  })

  it('weighs a card by its height estimate', () => {
    const weight = (id: string) => (id === 'a' ? 3 : 1)
    expect(placeCards(undefined, ['a', 'b', 'c', 'd'], 2, weight)).toEqual([['a'], ['b', 'c', 'd']])
  })

  it('keeps every card in its column and order across snapshot changes', () => {
    const first = placeCards(undefined, ['a', 'b', 'c', 'd', 'e'], 3)
    // A new snapshot lists the same cards in another order (states changed): nothing moves.
    const second = placeCards(first, ['e', 'd', 'c', 'b', 'a'], 3)
    expect(second).toEqual(first)
    expect(samePlacement(first, second)).toBe(true)
  })

  it('puts a new card at the end of the shortest column and leaves the others in place', () => {
    const first = placeCards(undefined, ['a', 'b', 'c', 'd'], 3)
    expect(placeCards(first, ['a', 'b', 'c', 'd', 'e'], 3)).toEqual([['a', 'd'], ['b', 'e'], ['c']])
  })

  it('closes the gap a leaving card leaves, without moving cards across columns', () => {
    const first = placeCards(undefined, ['a', 'b', 'c', 'd', 'e', 'f'], 3)
    const second = placeCards(first, ['a', 'c', 'd', 'e', 'f'], 3)
    expect(second).toEqual([['a', 'd'], ['e'], ['c', 'f']])
    // The next new card fills the column that lost one.
    expect(placeCards(second, ['a', 'c', 'd', 'e', 'f', 'g'], 3)).toEqual([['a', 'd'], ['e', 'g'], ['c', 'f']])
  })

  it('places every card again when the column count changes', () => {
    const three = placeCards(undefined, ['a', 'b', 'c', 'd'], 3)
    expect(placeCards(three, ['a', 'b', 'c', 'd'], 1)).toEqual([['a', 'b', 'c', 'd']])
    expect(samePlacement(three, placeCards(three, ['a', 'b', 'c', 'd'], 1))).toBe(false)
  })
})
