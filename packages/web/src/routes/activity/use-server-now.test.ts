import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NO_SERVER_TIME } from '@/api/activity-live'

import { useServerNow } from './use-server-now'

const CLIENT = Date.parse('2026-11-06T10:00:00.000Z')
const SERVER = '2026-11-06T09:59:00.000Z' // the server's clock runs 60 s behind the client's

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(CLIENT)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useServerNow', () => {
  it('ticks from a server snapshot: its generatedAt at the time the client received it', () => {
    const hook = renderHook(() => useServerNow(SERVER, CLIENT))
    expect(hook.result.current).toBe(Date.parse(SERVER))
  })

  it('keeps the client clock for a snapshot the client built with no server time', () => {
    const hook = renderHook(() => useServerNow(NO_SERVER_TIME, CLIENT))
    expect(hook.result.current).toBe(CLIENT)
  })

  it('never moves the clock for a client-built snapshot that keeps the cached server time', () => {
    const hook = renderHook(({ at, received }) => useServerNow(at, received), { initialProps: { at: SERVER, received: CLIENT } })
    // Ten minutes later the read fails; the unavailable snapshot keeps the cached generatedAt.
    act(() => { vi.advanceTimersByTime(600_000) })
    hook.rerender({ at: SERVER, received: CLIENT + 600_000 })
    expect(hook.result.current).toBe(Date.parse(SERVER) + 600_000)
  })
})
