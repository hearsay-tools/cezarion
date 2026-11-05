import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'

import { activityQueryKey, useActivity } from './activity'
import { createQueryClient } from './query-client'
import { jsonResponse } from '@/test/fetch-routes'

afterEach(() => {
  setApiScope(null)
  vi.unstubAllGlobals()
})

const snapshot = (projectId: string) => ({
  generatedAt: '2026-11-05T15:32:00.000Z',
  projects: [{ projectId, name: projectId, loaded: true, inReview: 0, tasks: [], requests: [], closed: [] }],
})

describe('useActivity cache keys', () => {
  it('keys the global read with null, never with a project id', () => {
    expect(activityQueryKey(undefined)).toEqual(['workspace', 'activity', null])
    expect(activityQueryKey('all')).toEqual(['workspace', 'activity', 'all'])
    expect(activityQueryKey('all')).not.toEqual(activityQueryKey(undefined))
  })

  it('never answers the global view from the cache entry of a project named all, or the reverse', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url === '/api/v1/workspace/activity' ? jsonResponse(snapshot('global-marker')) : jsonResponse(snapshot('all'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

    setApiScope('all')
    const project = renderHook(() => useActivity('project'), { wrapper })
    await waitFor(() => expect(project.result.current.data?.projects[0]?.projectId).toBe('all'))

    const global = renderHook(() => useActivity('all'), { wrapper })
    // A shared entry would paint the project's cards in the global view at once.
    expect(global.result.current.data).toBeUndefined()
    await waitFor(() => expect(global.result.current.data?.projects[0]?.projectId).toBe('global-marker'))
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/v1/workspace/activity?project=all',
      '/api/v1/workspace/activity',
    ])
    expect(client.getQueryData(activityQueryKey('all'))).not.toBe(client.getQueryData(activityQueryKey(undefined)))
  })
})
