import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { useArtifactMetadata } from './queries'

const fetchMock = vi.fn<typeof fetch>()
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  setApiScope(null)
})

it('fetches scoped metadata only when selected and separates each report cache', async () => {
  setApiScope('project')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async input => new Response(JSON.stringify({ artifact: { name: String(input) } }), { headers: { 'content-type': 'application/json' } }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result, rerender } = renderHook(({ run, artifact }: { run: string; artifact: string | null }) => useArtifactMetadata(run, artifact), { wrapper, initialProps: { run: 'task-a', artifact: null } as { run: string; artifact: string | null } })
  expect(fetchMock).not.toHaveBeenCalled()
  rerender({ run: 'task-a', artifact: 'report-a' })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/p/project/runs/task-a/artifacts/report-a/metadata')
  rerender({ run: 'task-b', artifact: 'report-b' })
  await waitFor(() => expect(result.current.data?.artifact.name).toContain('/task-b/artifacts/report-b/metadata'))
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls.every(([input]) => String(input).endsWith('/metadata'))).toBe(true)
  client.clear()
})
