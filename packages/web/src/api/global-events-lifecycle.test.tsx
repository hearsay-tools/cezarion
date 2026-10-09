import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createUsageStore } from './events'
import { useGlobalEvents } from './global-events'
import { configureLiveSession, resetLiveSession } from './live-coordinator'
import { createQueryClient } from './query-client'
import { queryKeys } from './queries'

class Worker {
  static all: Worker[] = []
  port = { postMessage: vi.fn(), start: vi.fn(), close: vi.fn(), onmessage: null, onmessageerror: null }
  addEventListener = vi.fn()
  constructor() { Worker.all.push(this) }
}

beforeEach(() => {
  vi.useFakeTimers()
  Worker.all = []
  vi.stubGlobal('SharedWorker', Worker)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { cleanup(); resetLiveSession(); vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([true, false].flatMap(local => ['visibility', 'bfcache', 'freeze'].map(lifecycle => ({ local, lifecycle }))))(
  'reconciles once after fresh authentication on $lifecycle restoration (local: $local)', async ({ local, lifecycle }) => {
  const client = createQueryClient()
  const usage = createUsageStore()
  configureLiveSession({ local, bootProject: 'boot', apiBase: '' })
  renderHook(() => useGlobalEvents(usage), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(Worker.all).toHaveLength(local ? 1 : 0)
  const invalidation = vi.spyOn(client, 'invalidateQueries')
  let authenticate!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { authenticate = resolve })))
  act(() => {
    if (lifecycle === 'visibility') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    } else if (lifecycle === 'bfcache') window.dispatchEvent(new Event('pagehide'))
    else document.dispatchEvent(new Event('freeze'))
  })
  if (local) expect(Worker.all[0]!.port.close).toHaveBeenCalledTimes(1)
  act(() => {
    if (lifecycle === 'visibility') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    } else if (lifecycle === 'bfcache') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    else document.dispatchEvent(new Event('resume'))
  })
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/v1/health', expect.objectContaining({ credentials: 'include' }))
  expect(invalidation).not.toHaveBeenCalled()
  expect(Worker.all).toHaveLength(local ? 1 : 0)
  await act(async () => {
    authenticate(new Response(JSON.stringify({ bootProject: 'boot', capabilities: {
      localHandoff: local, followups: true, singleProject: false, automations: false,
      preview: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true,
    } })))
    await vi.advanceTimersByTimeAsync(0)
  })
  const runInvalidations = invalidation.mock.calls.map(([filters]) => filters?.queryKey)
    .filter(key => key?.length === 2 && key[1] === 'runs')
  expect(runInvalidations).toEqual([queryKeys.runs.all])
  expect(Worker.all).toHaveLength(local ? 2 : 0)
  if (!local) {
    invalidation.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(invalidation.mock.calls.filter(([filters]) => filters?.queryKey?.[1] === 'runs')).toHaveLength(1)
  }
  client.clear()
})
