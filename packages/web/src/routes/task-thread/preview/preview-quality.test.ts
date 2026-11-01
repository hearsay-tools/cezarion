import { afterEach, describe, expect, it, vi } from 'vitest'

import { PREVIEW_QUALITIES, PREVIEW_QUALITY_STORAGE_KEY, readStoredPreviewQuality, writeStoredPreviewQuality } from './preview-quality'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('preview quality storage (hearsay-tools/cezarion#2066)', () => {
  it('reads Normal when nothing is stored, and for junk', () => {
    expect(readStoredPreviewQuality()).toBe('normal')
    localStorage.setItem(PREVIEW_QUALITY_STORAGE_KEY, 'lossless')
    expect(readStoredPreviewQuality()).toBe('normal')
  })

  it('remembers High for the next preview in this browser', () => {
    writeStoredPreviewQuality('high')
    expect(readStoredPreviewQuality()).toBe('high')
    writeStoredPreviewQuality('normal')
    expect(readStoredPreviewQuality()).toBe('normal')
  })

  it('remembers Ultra (hearsay-tools/cezarion#2069)', () => {
    writeStoredPreviewQuality('ultra')
    expect(readStoredPreviewQuality()).toBe('ultra')
  })

  it('falls back to Normal, and keeps working, when storage refuses', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeStoredPreviewQuality('high')).not.toThrow()
    expect(readStoredPreviewQuality()).toBe('normal')
  })

  it('names the cost of High and never calls it lossless', () => {
    const high = PREVIEW_QUALITIES.find(option => option.value === 'high')!
    expect(high.detail).toMatch(/CPU and network/)
    const ultra = PREVIEW_QUALITIES.find(option => option.value === 'ultra')!
    expect(ultra.detail).toMatch(/pixel density, up to 2×/)
    expect(ultra.detail).toMatch(/most CPU and network/)
    expect(PREVIEW_QUALITIES.map(option => `${option.label} ${option.detail}`).join(' ')).not.toMatch(/lossless/i)
  })
})
