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
  rememberPanePercent,
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

describe('preview memory validation and eviction', () => {
  it.each([null, 1, 'entry', [], false])('ignores an invalid entry %j', value => {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify({ a: value }))
    expect(readPreviewMemory('a')).toBeUndefined()
  })

  it.each([null, [], 'target', 1, { port: 0 }, { port: -1 }, { port: '5173' }, { agent: false }, { url: 7 }, { url: 'xhttps://example.com' }])('drops an invalid target %j', target => {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify({ a: { open: true, target } }))
    expect(readPreviewMemory('a')).toEqual({ open: true })
  })

  it.each([{ port: 1 }, { port: 65535 }, { url: 'http://example.com' }, { url: 'HTTPS://example.com' }])('keeps a valid target %j', target => {
    rememberPreview('a', { target })
    expect(readPreviewMemory('a')).toEqual({ open: false, target })
  })

  it('prefers a port over agent and URL, then agent over URL', () => {
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify({
      a: { target: { port: 5173, agent: true, url: 'https://example.com' } },
      b: { target: { port: 0, agent: true, url: 'https://example.com' } },
    }))
    expect(readPreviewMemory('a')).toEqual({ open: false, target: { port: 5173 } })
    expect(readPreviewMemory('b')).toEqual({ open: false, target: { agent: true } })
  })

  it('saves the current time and removes explicit undefined keys from storage', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12345)
    rememberPreview('a', { open: true, percent: 40 })
    expect(stored()).toEqual({ a: { open: true, percent: 40, at: 12345 } })
    rememberPreview('a', { percent: undefined })
    expect(stored()).toEqual({ a: { open: true, at: 12345 } })
  })

  it('keeps the full limit and evicts by last change rather than insertion order', () => {
    for (let i = 0; i < PREVIEW_MEMORY_LIMIT; i += 1) rememberPreview(`r${i}`, { open: true }, i + 1)
    expect(Object.keys(stored())).toHaveLength(PREVIEW_MEMORY_LIMIT)
    expect(readPreviewMemory('r0')).toEqual({ open: true })
    rememberPreview('r0', { open: false }, 1000)
    rememberPreview('new', { open: true }, 1001)
    expect(readPreviewMemory('r0')).toEqual({ open: false })
    expect(readPreviewMemory('r1')).toBeUndefined()
    expect(readPreviewMemory('r2')).toEqual({ open: true })
  })

  it('evicts invalid entries and entries without numeric ages before dated entries', () => {
    const all: Record<string, unknown> = { invalid: null, missing: { open: true }, text: { at: 'old' } }
    for (let i = 0; i < PREVIEW_MEMORY_LIMIT; i += 1) all[`r${i}`] = { open: true, at: i + 1 }
    localStorage.setItem(PREVIEW_MEMORY_STORAGE_KEY, JSON.stringify(all))
    rememberPreview('new', { open: true }, 1000)
    expect(Object.keys(stored())).toHaveLength(PREVIEW_MEMORY_LIMIT)
    for (const id of ['invalid', 'missing', 'text', 'r0']) expect(readPreviewMemory(id)).toBeUndefined()
    expect(readPreviewMemory('r1')).toEqual({ open: true })
  })
})

describe('remembered pane width writes', () => {
  it('writes the global width without making an unscoped task entry', () => {
    rememberPanePercent(undefined, 49)
    expect(localStorage.getItem(PANE_WIDTH_STORAGE_KEY)).toBe('49')
    expect(stored()).toEqual({})
    expect(readPanePercent(undefined)).toBe(49)
  })

  it('writes both the global width and the scoped width', () => {
    rememberPanePercent('a', 51)
    expect(readPreviewMemory('a')).toEqual({ open: false, percent: 51 })
    expect(readPanePercent('b')).toBe(51)
  })

  it('still writes the task width if the global width write fails', () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === PANE_WIDTH_STORAGE_KEY) throw new Error('denied')
      original.call(this, key, value)
    })
    expect(() => rememberPanePercent('a', 54)).not.toThrow()
    expect(readPreviewMemory('a')).toEqual({ open: false, percent: 54 })
  })

  it.each(['0', '-1', 'not a number', ''])('uses the default for an unusable last width %j', value => {
    localStorage.setItem(PANE_WIDTH_STORAGE_KEY, value)
    expect(readPanePercent(undefined)).toBe(DEFAULT_PANE_PERCENT)
  })
})
