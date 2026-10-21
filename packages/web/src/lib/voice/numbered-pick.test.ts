// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { parseNumberedPick } from './numbered-pick'

describe('parseNumberedPick', () => {
  it.each(['two', '2', 'number two', 'The second.', 'second one', 'the second one', 'Number 2!', ' 2 '])(
    'reads %j as the second option',
    (text) => {
      expect(parseNumberedPick(text, 3)).toBe(1)
    },
  )

  it.each([
    ['1', 0],
    ['one', 0],
    ['first', 0],
    ['the first one', 0],
    ['ten', 9],
    ['10', 9],
    ['tenth', 9],
    ['number ten', 9],
    ['third', 2],
  ])('reads %j as index %i', (text, index) => {
    expect(parseNumberedPick(text, 10)).toBe(index)
  })

  it('refuses a number past the count', () => {
    expect(parseNumberedPick('four', 3)).toBeNull()
    expect(parseNumberedPick('4', 3)).toBeNull()
  })

  it('refuses zero and eleven', () => {
    expect(parseNumberedPick('0', 10)).toBeNull()
    expect(parseNumberedPick('11', 20)).toBeNull()
  })

  it.each(['open next', '', 'two options', 'second one please', 'number', 'the', '2.5'])('refuses %j', (text) => {
    expect(parseNumberedPick(text, 10)).toBeNull()
  })
})
