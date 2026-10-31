import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDevicePixelRatio } from './use-device-pixel-ratio'

/** The viewer's pixel ratio, live (hearsay-tools/cezarion#2069): a resolution query per ratio says when it changes. */

const ratio = { value: 1 }
const lists: Array<{ query: string; listeners: Set<() => void> }> = []

function stub(initial: number) {
  ratio.value = initial
  lists.length = 0
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ratio.value })
  vi.stubGlobal('matchMedia', (query: string) => {
    const list = { query, listeners: new Set<() => void>() }
    lists.push(list)
    return { matches: true, media: query, addEventListener: (_: string, fn: () => void) => list.listeners.add(fn), removeEventListener: (_: string, fn: () => void) => list.listeners.delete(fn) }
  })
}
const fire = (query: string) => act(() => { for (const list of lists.filter(entry => entry.query === query)) for (const fn of [...list.listeners]) fn() })
const listening = () => lists.filter(list => list.listeners.size > 0).map(list => list.query)

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { devicePixelRatio?: number }).devicePixelRatio
})

it('reads the ratio and follows it to another display', () => {
  stub(2)
  const hook = renderHook(() => useDevicePixelRatio())
  expect(hook.result.current).toBe(2)
  expect(listening()).toEqual(['(resolution: 2dppx)'])
  ratio.value = 1.5
  fire('(resolution: 2dppx)')
  expect(hook.result.current).toBe(1.5)
  // The old query is let go; only the new ratio's query listens.
  expect(listening()).toEqual(['(resolution: 1.5dppx)'])
  hook.unmount()
  expect(listening()).toEqual([])
})

it('reads 1 where the browser reports no ratio or no matchMedia', () => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => undefined })
  vi.stubGlobal('matchMedia', undefined)
  expect(renderHook(() => useDevicePixelRatio()).result.current).toBe(1)
})
