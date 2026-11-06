import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { useReports } from './reports'
const live = vi.hoisted(() => ({ topics: new Map<string, (value: unknown) => void>(), reads: new Map<string, (value: unknown) => void>(), mode: 'topics' as 'topics' | 'finite' }))
vi.mock('./ws', () => ({ subscribeTopic: (topic: string, listener: (value: unknown) => void) => { live.topics.set(topic, listener); return () => live.topics.delete(topic) } }))
vi.mock('./live-coordinator', () => ({ liveTransport: () => live.mode, onLiveTransport: () => { return () => {} } }))
vi.mock('./live-reads', () => ({ subscribeLiveRead: (input: { path: string; intervalMs: number }, listener: (value: unknown) => void) => { expect(input.intervalMs).toBe(5_000); live.reads.set(input.path, listener); return () => live.reads.delete(input.path) } }))
const state = { epoch: '93d9b907-7b9c-4cdb-bac4-414f40ab64eb', generation: 0, metadataGeneration: 0 }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); live.topics.clear(); live.reads.clear(); live.mode = 'topics'; setApiScope(null) })
function shelf() {
  setApiScope('P')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const hook = renderHook(() => useReports(''), { wrapper })
  return { client, ...hook }
}
it('demands only its project topic and releases it on unmount; other project changes cause no reads', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ reports: [], total: 0, nextCursor: null })))
  vi.stubGlobal('fetch', fetch)
  const { client, result, unmount } = shelf()
  // bound: React must deliver the completed query to its observer.
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect([...live.topics.keys()]).toEqual(['reports:project:P'])
  act(() => live.topics.get('reports:project:Q')?.({ ...state, type: 'content', generation: 1 }))
  expect(fetch).toHaveBeenCalledTimes(1)
  act(() => live.topics.get('reports:project:P')?.({ ...state, type: 'snapshot' }))
  act(() => live.topics.get('reports:project:P')?.({ ...state, type: 'content', generation: 1 }))
  // bound: React must deliver the completed query to its observer.
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  unmount(); expect(live.topics.size).toBe(0); client.clear()
})
it('uses the finite state twin every five seconds and releases its read', async () => {
  live.mode = 'finite'
  const fetch = vi.fn(async () => new Response(JSON.stringify({ reports: [], total: 0, nextCursor: null })))
  vi.stubGlobal('fetch', fetch)
  const { client, result, unmount } = shelf()
  // bound: React must deliver the completed query to its observer.
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect([...live.reads.keys()]).toEqual(['/api/v1/p/P/reports/state'])
  act(() => live.reads.get('/api/v1/p/P/reports/state')?.(state))
  act(() => live.reads.get('/api/v1/p/P/reports/state')?.({ ...state, metadataGeneration: 1 }))
  // bound: React must deliver the completed query to its observer.
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  unmount(); expect(live.reads.size).toBe(0); client.clear()
})
