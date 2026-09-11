import { afterEach, describe, expect, it } from 'vitest'

import {
  ACCENT_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  WIDTH_STORAGE_KEY,
  applyAppearance,
  normalizeAccent,
  normalizeAppearance,
  normalizeDensity,
  normalizeWidth,
  readStoredAppearance,
  writeStoredAppearance,
} from './appearance'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.width
})

describe('normalize', () => {
  it('maps legacy and unknown accents onto the sole Cezarion accent', () => {
    for (const raw of ['cezarion', 'violet', 'lime', null, undefined, 'magenta', 42, {}]) {
      expect(normalizeAccent(raw)).toBe('cezarion')
    }
  })

  it('accepts the known density and width values and defaults everything else', () => {
    for (const raw of [null, undefined, 'magenta', 42, {}]) {
      expect(normalizeDensity(raw)).toBe('comfortable')
      expect(normalizeWidth(raw)).toBe('narrow')
    }
    expect(normalizeDensity('compact')).toBe('compact')
    expect(normalizeDensity('ultra')).toBe('ultra')
    expect(normalizeWidth('wide')).toBe('wide')
    expect(normalizeWidth('narrow')).toBe('narrow')
  })

  it('normalizeAppearance survives any ui-state shape', () => {
    expect(normalizeAppearance(undefined)).toEqual({
      accent: 'cezarion',
      density: 'comfortable',
      width: 'narrow',
    })
    expect(normalizeAppearance('not-an-object')).toEqual({
      accent: 'cezarion',
      density: 'comfortable',
      width: 'narrow',
    })
    expect(normalizeAppearance({ accent: 'violet' })).toEqual({
      accent: 'cezarion',
      density: 'comfortable',
      width: 'narrow',
    })
    expect(normalizeAppearance({ accent: 'nope', density: 'compact', width: 'wide' })).toEqual({
      accent: 'cezarion',
      density: 'compact',
      width: 'wide',
    })
  })
})

describe('the localStorage mirror', () => {
  it('round-trips through the same keys the index.html pre-paint script reads', () => {
    writeStoredAppearance({ accent: 'cezarion', density: 'compact', width: 'wide' })
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('cezarion')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBe('wide')
    expect(readStoredAppearance()).toEqual({ accent: 'cezarion', density: 'compact', width: 'wide' })
  })

  it('defaults when the mirror is empty', () => {
    expect(readStoredAppearance()).toEqual({ accent: 'cezarion', density: 'comfortable', width: 'narrow' })
  })
})

describe('applyAppearance', () => {
  it('keeps the sole accent implicit and stamps only non-default density and width', () => {
    const root = document.documentElement
    root.dataset.accent = 'legacy'
    applyAppearance(root, { accent: 'cezarion', density: 'compact', width: 'wide' })
    expect(root.hasAttribute('data-accent')).toBe(false)
    expect(root.dataset.density).toBe('compact')
    expect(root.dataset.width).toBe('wide')

    applyAppearance(root, { accent: 'cezarion', density: 'comfortable', width: 'narrow' })
    expect(root.hasAttribute('data-accent')).toBe(false)
    expect(root.hasAttribute('data-density')).toBe(false)
    expect(root.hasAttribute('data-width')).toBe(false)
  })
})
