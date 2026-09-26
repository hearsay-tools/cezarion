import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'

import { attachQueryIdle, setIdleSource, trackSseReconcile } from './cez-idle'

afterEach(() => {
  setIdleSource('queries', false)
  setIdleSource('sse', false)
  setIdleSource('ws', false)
})

describe('window.__cezIdle (#415)', () => {
  it('is false while a tracked query is fetching', async () => {
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
