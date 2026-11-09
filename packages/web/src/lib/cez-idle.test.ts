import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { attachQueryIdle, setIdleSource, trackSseReconcile } from './cez-idle'

afterEach(() => {
  vi.useRealTimers()
  setIdleSource('queries', false)
  setIdleSource('sse', false)
  setIdleSource('ws', false)
})

describe('window.__cezIdle (#415)', () => {
  it('is false while a tracked query is fetching and awaiting delivery', async () => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const stop = attachQueryIdle(client)
    expect(window.__cezIdle).toBe(true)

    let release!: () => void
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('ok')
    })
    const fetch = client.fetchQuery({ queryKey: ['idle-probe'], queryFn: () => pending })
    expect(window.__cezIdle).toBe(false)
    release()
    await fetch
    expect(window.__cezIdle).toBe(false)
    await vi.runAllTimersAsync()
    expect(window.__cezIdle).toBe(true)
    stop()
  })

  it('is false while an SSE reconcile is in flight', async () => {
    attachQueryIdle(new QueryClient())
    expect(window.__cezIdle).toBe(true)
    let finish!: () => void
    trackSseReconcile(() => [
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    ])
    expect(window.__cezIdle).toBe(false)
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(window.__cezIdle).toBe(true)
  })

  it('is false while a WS topic is in flight', () => {
    attachQueryIdle(new QueryClient())
    setIdleSource('ws', true)
    expect(window.__cezIdle).toBe(false)
    setIdleSource('ws', false)
    expect(window.__cezIdle).toBe(true)
  })
})

describe('query delivery callbacks', () => {
  it('does not let an old settlement clear a newer fetch', async () => {
    vi.useFakeTimers()
    const client = new QueryClient()
    const stop = attachQueryIdle(client)
    await client.fetchQuery({ queryKey: ['first'], queryFn: async () => 'first' })
    let release!: () => void
    const pending = new Promise<string>((resolve) => { release = () => resolve('second') })
    const fetch = client.fetchQuery({ queryKey: ['second'], queryFn: () => pending })
    await vi.runAllTimersAsync()
    expect(window.__cezIdle).toBe(false)
    release()
    await fetch
    await vi.runAllTimersAsync()
    expect(window.__cezIdle).toBe(true)
    stop()
    client.clear()
  })

  it('ignores pending delivery callbacks after detach and reattach', async () => {
    vi.useFakeTimers()
    const first = new QueryClient()
    const stopFirst = attachQueryIdle(first)
    await first.fetchQuery({ queryKey: ['first'], queryFn: async () => 'first' })
    stopFirst()
    const second = new QueryClient()
    let release!: () => void
    const pending = new Promise<string>((resolve) => { release = () => resolve('second') })
    const fetch = second.fetchQuery({ queryKey: ['second'], queryFn: () => pending })
    const stopSecond = attachQueryIdle(second)
    await vi.runAllTimersAsync()
    expect(window.__cezIdle).toBe(false)
    release()
    await fetch
    await vi.runAllTimersAsync()
    expect(window.__cezIdle).toBe(true)
    stopSecond()
    first.clear()
    second.clear()
  })
})
