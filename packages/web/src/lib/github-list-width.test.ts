import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_GITHUB_LIST_WIDTH,
  GITHUB_LIST_WIDTH_STORAGE_KEY,
  MAX_GITHUB_LIST_WIDTH,
  MIN_GITHUB_LIST_WIDTH,
  clampGithubListWidth,
  readStoredGithubListWidth,
  writeStoredGithubListWidth,
} from './github-list-width'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('clampGithubListWidth', () => {
  it.each([
    [280, 280],
    [360, 360],
    [520, 520],
    [317.4, 317],
    [317.5, 318],
    [0, MIN_GITHUB_LIST_WIDTH],
    [-4000, MIN_GITHUB_LIST_WIDTH],
    [279, MIN_GITHUB_LIST_WIDTH],
    [521, MAX_GITHUB_LIST_WIDTH],
    [99_999, MAX_GITHUB_LIST_WIDTH],
  ])('%s → %s', (raw, expected) => {
    expect(clampGithubListWidth(raw)).toBe(expected)
  })

  it('parses localStorage strings and returns the default for junk', () => {
    expect(clampGithubListWidth('340.6')).toBe(341)
    expect(clampGithubListWidth('wide')).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    expect(clampGithubListWidth('   ')).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    expect(clampGithubListWidth(null)).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    expect(clampGithubListWidth(NaN)).toBe(DEFAULT_GITHUB_LIST_WIDTH)
  })
})

describe('readStoredGithubListWidth / writeStoredGithubListWidth', () => {
  it('round-trips the shared width through the documented key', () => {
    writeStoredGithubListWidth(400)
    expect(localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)).toBe('400')
    expect(readStoredGithubListWidth()).toBe(400)
  })

  it('clamps on write and read', () => {
    writeStoredGithubListWidth(10_000)
    expect(localStorage.getItem(GITHUB_LIST_WIDTH_STORAGE_KEY)).toBe(String(MAX_GITHUB_LIST_WIDTH))
    localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, '12')
    expect(readStoredGithubListWidth()).toBe(MIN_GITHUB_LIST_WIDTH)
  })

  it('defaults when storage is absent, invalid, or unavailable', () => {
    expect(readStoredGithubListWidth()).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    localStorage.setItem(GITHUB_LIST_WIDTH_STORAGE_KEY, 'not a number')
    expect(readStoredGithubListWidth()).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readStoredGithubListWidth()).toBe(DEFAULT_GITHUB_LIST_WIDTH)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeStoredGithubListWidth(400)).not.toThrow()
  })
})
