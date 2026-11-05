import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { jsonResponse } from '@/test/fetch-routes'

import { project, run, snapshot } from './activity.testkit'
import { GlobalActivityRoute } from './global-activity-route'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('GlobalActivityRoute (the S5 placeholder)', () => {
  it('lists every project of the global snapshot with its state and a link to its activity', async () => {
    const body = snapshot(
      project({ projectId: 'cezarion', name: 'cezarion', tasks: [run(), run()] }),
      project({ projectId: 'squeal', name: 'squeal', loaded: false }),
      project({ projectId: 'notes', name: 'notes', unavailable: { status: 409, error: 'The project folder is missing.' } }),
      project({ projectId: 'site', name: 'site' }),
    )
    fetchMock.mockImplementation(async (input) => (String(input) === '/api/v1/workspace/activity' ? jsonResponse(body) : jsonResponse({ error: 'not found' }, 404)))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/activity']}>
          <GlobalActivityRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('2 active tasks')
    const rows = Array.from(document.querySelectorAll('[data-slot="activity-project"]'))
    expect(rows.map((row) => row.querySelector('[data-slot="activity-project-state"]')?.textContent)).toEqual([
      '2 active tasks',
      'Not loaded in this cockpit',
      'The project folder is missing.',
      'No active work',
    ])
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([
      '/p/cezarion/activity', '/p/squeal/activity', '/p/notes/activity', '/p/site/activity',
    ])
  })
})
