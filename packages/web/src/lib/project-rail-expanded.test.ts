import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MIN_MAIN_WIDTH_FOR_EXPANDED_RAIL,
  PROJECT_RAIL_EXPANDED_STORAGE_KEY,
  PROJECT_RAIL_EXPANDED_WIDTH,
  railCanExpand,
  readStoredRailExpanded,
  writeStoredRailExpanded,
} from './project-rail-expanded'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('railCanExpand', () => {
  const edge = PROJECT_RAIL_EXPANDED_WIDTH + 264 + MIN_MAIN_WIDTH_FOR_EXPANDED_RAIL
  it.each([
    [1440, 264, true],
    [edge, 264, true],
    [edge - 1, 264, false],
    // A wider sidebar costs the main column too.
    [1280, 420, false],
    [1280, 264, true],
    [1024, 264, false],
  ])('viewport %s, sidebar %s → %s', (viewport, sidebar, expected) => {
    expect(railCanExpand(viewport, sidebar)).toBe(expected)
  })
})

describe('stored rail choice', () => {
  it('defaults to collapsed', () => {
    expect(readStoredRailExpanded()).toBe(false)
  })

  it('round-trips both answers', () => {
    writeStoredRailExpanded(true)
    expect(localStorage.getItem(PROJECT_RAIL_EXPANDED_STORAGE_KEY)).toBe('1')
    expect(readStoredRailExpanded()).toBe(true)
    writeStoredRailExpanded(false)
    expect(readStoredRailExpanded()).toBe(false)
  })

  it('treats a junk value as collapsed', () => {
    localStorage.setItem(PROJECT_RAIL_EXPANDED_STORAGE_KEY, 'yes please')
    expect(readStoredRailExpanded()).toBe(false)
  })

  it('degrades to collapsed when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(readStoredRailExpanded()).toBe(false)
    expect(() => writeStoredRailExpanded(true)).not.toThrow()
  })
})
