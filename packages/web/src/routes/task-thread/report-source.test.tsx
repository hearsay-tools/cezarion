import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getArtifactMetadata, getRunRelationships } from '@/api/client'
import { useReportSource } from './report-source'

vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), getArtifactMetadata: vi.fn(), getRunRelationships: vi.fn() }))
const metadata = vi.mocked(getArtifactMetadata)
const relationships = vi.mocked(getRunRelationships)
const missing = () => new ApiError(404, 'Artifact not found')
afterEach(() => { cleanup(); vi.resetAllMocks() })

function lookup(artifactId: string | undefined = 'report') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useReportSource('parent', artifactId), { wrapper })
}

describe('report source without mounted cards or transcript data', () => {
  it('finds a same-run publication with no card', async () => {
    metadata.mockResolvedValue({ artifact: { id: 'report' } } as Awaited<ReturnType<typeof getArtifactMetadata>>)
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.data).toBe('parent'))
    expect(metadata.mock.calls.map(call => call.slice(0, 2))).toEqual([['parent', 'report']])
    expect(relationships).not.toHaveBeenCalled()
  })

  it('finds a worker publication with no card', async () => {
    metadata.mockImplementation(async runId => {
      if (runId === 'worker') return { artifact: { id: 'report' } } as Awaited<ReturnType<typeof getArtifactMetadata>>
      throw missing()
    })
    relationships.mockResolvedValue({ workers: [{ workerId: 'empty' }, { workerId: 'worker' }] } as Awaited<ReturnType<typeof getRunRelationships>>)
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.data).toBe('worker'))
    expect(metadata.mock.calls.map(call => call[0])).toEqual(['parent', 'empty', 'worker'])
    expect(relationships).toHaveBeenCalledWith('parent', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('ends an unknown artifact with the reader missing error', async () => {
    metadata.mockRejectedValue(missing())
    relationships.mockResolvedValue({ workers: [{ workerId: 'worker' }] } as Awaited<ReturnType<typeof getRunRelationships>>)
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(hook.result.current.error).toMatchObject({ status: 404, message: 'Report missing or deleted' })
    expect(hook.result.current.isPending).toBe(false)
  })

  it('keeps lookup loading while metadata is pending', () => {
    metadata.mockImplementation(() => new Promise(() => {}))
    const hook = lookup()
    expect(hook.result.current.isPending).toBe(true)
    expect(hook.result.current.data).toBeUndefined()
  })

  it('preserves a transport error instead of calling a report missing', async () => {
    metadata.mockRejectedValue(new ApiError(500, 'Storage unavailable'))
    const hook = lookup()
    await waitFor(() => expect(hook.result.current.error).toMatchObject({ status: 500 }))
    expect(relationships).not.toHaveBeenCalled()
  })

  it('does not probe anything without an open report', () => {
    // renderHook has no ReportCard or transcript provider in any case.
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    renderHook(() => useReportSource('parent', undefined), { wrapper })
    expect(metadata).not.toHaveBeenCalled()
    expect(relationships).not.toHaveBeenCalled()
  })
})
