import { describe, expect, it } from 'vitest'
import { isNewerVersion } from './is-newer-version'

describe('isNewerVersion', () => {
  it.each([
    ['1.2.10', '1.2.9', true],
    ['2.0.0', '1.99.99', true],
    ['1.2.3', '1.2.3', false],
    ['1.2.2', '1.2.3', false],
    ['1.2.3-nightly.1', '1.2.3', false],
  ])('compares %s against %s numerically', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected)
  })
})
