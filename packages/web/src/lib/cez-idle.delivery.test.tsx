import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { attachQueryIdle, setIdleSource } from './cez-idle'

afterEach(() => {
  vi.useRealTimers()
  setIdleSource('queries', false)
})

it('keeps idle false until settled query results reach React', async () => {
  vi.useFakeTimers()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['delivery'], 'old')
  let release!: (value: string) => void
  const pending = new Promise<string>((resolve) => { release = resolve })
  function Result() {
    const { data } = useQuery({ queryKey: ['delivery'], queryFn: () => pending, enabled: false })
    return <div>{data}</div>
  }
  render(<QueryClientProvider client={client}><Result /></QueryClientProvider>)
  const stop = attachQueryIdle(client)
  try {
    const fetch = client.fetchQuery({ queryKey: ['delivery'], queryFn: () => pending })
    release('new')
    await fetch
    expect(client.isFetching()).toBe(0)
    expect(screen.getByText('old')).not.toBeNull()
    expect(window.__cezIdle).toBe(false)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(screen.getByText('new')).not.toBeNull()
    expect(window.__cezIdle).toBe(true)
  } finally {
    stop()
    client.clear()
  }
})
