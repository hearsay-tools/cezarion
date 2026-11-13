import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useActivityLive } from '@/api/activity-live'
import { createQueryClient } from '@/api/query-client'
import { jsonResponse } from '@/test/fetch-routes'

import { project, run, snapshot } from './activity.testkit'
import { ProjectActivityRoute } from './activity-route'
import { GlobalActivityRoute } from './global-activity-route'

/** Both views read through the live hook (spec 2026-11-05-live-activity-view, slice S6): one
 *  query key per scope, the topic or the 5 s re-read, and no second read path. */

vi.mock('@/api/activity-live', async (original) => {
  const actual = await original<typeof import('@/api/activity-live')>()
  return { ...actual, useActivityLive: vi.fn(actual.useActivityLive) }
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://cockpit.test').pathname
    if (path === '/api/v1/workspace/activity') return jsonResponse(snapshot(project({ tasks: [run({ runId: 'a', title: 'Porting upstream SSE' })] })))
    return jsonResponse({ error: 'not found' }, 404)
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(useActivityLive).mockClear()
})

function renderAt(path: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the activity views read the live snapshot', () => {
  it('reads the project view through useActivityLive with the project scope', async () => {
    renderAt('/p/cezarion/activity', <ProjectActivityRoute />)
    expect(await screen.findByText('Porting upstream SSE')).toBeTruthy()
    expect(vi.mocked(useActivityLive).mock.calls.every(([scope]) => scope.kind === 'project' && scope.projectId === 'default')).toBe(true)
  })

  it('reads the global view through useActivityLive with the workspace scope', async () => {
    renderAt('/activity', <GlobalActivityRoute />)
    expect(await screen.findByText('Porting upstream SSE')).toBeTruthy()
    expect(vi.mocked(useActivityLive).mock.calls.every(([scope]) => scope.kind === 'workspace')).toBe(true)
    expect(vi.mocked(useActivityLive)).toHaveBeenCalled()
  })
})
