import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clampPanePercent,
  DEFAULT_PANE_PERCENT,
  PANE_WIDTH_STORAGE_KEY,
  PREVIEW_MEMORY_LIMIT,
  PREVIEW_MEMORY_STORAGE_KEY,
  readPreviewMemory,
  readPanePercent,
  rememberPreview,
} from './preview-memory'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(PREVIEW_MEMORY_STORAGE_KEY) ?? '{}') as Record<string, unknown>

describe('preview memory (hearsay-tools/cezarion#2077)', () => {
  it('has no memory for a task it never saw', () => {
    expect(readPreviewMemory('r1')).toBeUndefined()
  })

  it('round-trips each kind of target, the open flag and the width', () => {
    rememberPreview('a', { open: true, target: { port: 5173 }, percent: 40 }, 1)
    rememberPreview('b', { open: false, target: { agent: true } }, 2)
    rememberPreview('c', { open: true, target: { url: 'https://example.com/docs' } }, 3)
    expect(readPreviewMemory('a')).toEqual({ open: true, target: { port: 5173 }, percent: 40 })
    expect(readPreviewMemory('b')).toEqual({ open: false, target: { agent: true } })
    expect(readPreviewMemory('c')).toEqual({ open: true, target: { url: 'https://example.com/docs' } })
  })

  it('merges a change into the task entry and leaves other tasks as they were', () => {
    rememberPreview('a', { open: true, target: { port: 5173 }, percent: 40 }, 1)
    rememberPreview('b', { open: true, target: { port: 3000 } }, 2)
    rememberPreview('a', { open: false }, 3)
    expect(readPreviewMemory('a')).toEqual({ open: false, target: { port: 5173 }, percent: 40 })
    expect(readPreviewMemory('b')).toEqual({ open: true, target: { port: 3000 } })
  })

  it('forgets a target when told to', () => {
    rememberPreview('a', { open: true, target: { port: 5173 } }, 1)
    rememberPreview('a', { target: undefined }, 2)
    expect(readPreviewMemory('a')).toEqual({ open: true })
  })

  it(`keeps at most ${PREVIEW_MEMORY_LIMIT} tasks and drops the oldest first`, () => {
    for (let index = 0; index <= PREVIEW_MEMORY_LIMIT; index += 1) rememberPreview(`r${index}`, { open: true }, index)
    expect(Object.keys(stored())).toHaveLength(PREVIEW_MEMORY_LIMIT)
    expect(readPreviewMemory('r0')).toBeUndefined()
    expect(readPreviewMemory(`r${PREVIEW_MEMORY_LIMIT}`)).toEqual({ open: true })
  })

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a string', '"x"'],
  ])('reads %s as no memory, and the next write replaces it', (_name, raw) => {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, raw)
    expect(readPreviewMemory('a')).toBeUndefined()
    rememberPreview('a', { open: true }, 1)
    expect(readPreviewMemory('a')).toEqual({ open: true })
  })

  it.each([
    ['a port out of range', { port: 70000 }],
    ['a fractional port', { port: 51.5 }],
    ['an agent flag that is not true', { agent: 'yes' }],
    ['a url of another scheme', { url: 'javascript:void(0)' }],
    ['an unknown shape', { file: '/etc/passwd' }],
  ])('drops %s from a hand-edited entry', (_name, target) => {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify({ a: { open: true, target, at: 1 } }))
    expect(readPreviewMemory('a')).toEqual({ open: true })
  })

  it('reads an entry with no usable open flag as closed, and drops a width that is not a number', () => {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify({ a: { open: 'yes', percent: 'wide', at: 1 } }))
    expect(readPreviewMemory('a')).toEqual({ open: false })
  })

  it('degrades to no memory when storage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => rememberPreview('a', { open: true })).not.toThrow()
    expect(readPreviewMemory('a')).toBeUndefined()
    expect(readPanePercent('a')).toBe(DEFAULT_PANE_PERCENT)
  })
})

describe('pane width', () => {
  it.each([
    [10, 30],
    [30, 30],
    [52.4, 52],
    [75, 75],
    [99, 75],
  ])('clamps %s to %s', (input, output) => {
    expect(clampPanePercent(input)).toBe(output)
  })

  it("reads the task's own width first, then the last width set anywhere, then the default", () => {
    expect(readPanePercent('a')).toBe(DEFAULT_PANE_PERCENT)
    localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '44')
    expect(readPanePercent('a')).toBe(44)
    rememberPreview('a', { percent: 66 })
    expect(readPanePercent('a')).toBe(66)
    expect(readPanePercent('b')).toBe(44)
    expect(readPanePercent(undefined)).toBe(44)
  })

  it('clamps a stored width outside the limits', () => {
    localStorage.setItem(PANE_WIDTH_STORAGE_KEY, '5')
    rememberPreview('a', { percent: 120 })
    expect(readPanePercent('a')).toBe(75)
    expect(readPanePercent('b')).toBe(30)
  })
})
