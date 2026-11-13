import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_MEDIA_QUERY, useIsDesktop } from './use-desktop'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('reads the md query before its first render and follows changes until unmount', () => {
  let matches = false
  const listeners = new Set<() => void>()
  const matchMedia = vi.fn(() => ({
    get matches() { return matches },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }))
  vi.stubGlobal('matchMedia', matchMedia)
  const { result, unmount } = renderHook(useIsDesktop)
  expect(result.current).toBe(false)
  expect(matchMedia).toHaveBeenCalledWith(DESKTOP_MEDIA_QUERY)
  act(() => { matches = true; for (const listener of listeners) listener() })
  expect(result.current).toBe(true)
  unmount()
  expect(listeners.size).toBe(0)
})

it('uses the desktop fallback without matchMedia', () => {
  vi.stubGlobal('matchMedia', undefined)
  expect(renderHook(useIsDesktop).result.current).toBe(true)
})
