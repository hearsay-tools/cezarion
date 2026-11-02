import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { getReports, useReports } from './reports'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setApiScope(null) })
it('uses a project-owned key and encoded search, validates the response and fetches the next page', async () => {
  setApiScope('shop')
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ reports: [], total: 2, nextCursor: 'next' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ reports: [], total: 2, nextCursor: null })))
  vi.stubGlobal('fetch', fetcher)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useReports('income & costs'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(client.getQueryData(['shop', 'reports', 'income & costs'])).toBeTruthy()
  expect(result.current.isStale).toBe(true)
  expect(String(fetcher.mock.calls[0]![0])).toContain('/p/shop/reports?q=income+%26+costs')
  await result.current.fetchNextPage()
  expect(String(fetcher.mock.calls[1]![0])).toContain('before=next')
  client.clear()
})
it('rejects a malformed response instead of rendering an empty shelf', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ reports: [] }))))
  await expect(getReports('shop', '')).rejects.toThrow()
})
