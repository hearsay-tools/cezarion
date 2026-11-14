import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { activityQueryKey } from '@/api/activity-live'
import { createQueryClient } from '@/api/query-client'
import { jsonResponse } from '@/test/fetch-routes'

import { ACTIVITY_WAIT_KIND, NOW, RUN_STATUS, iso, project, request, run, snapshot, worker } from './activity.testkit'
import { ProjectActivityRoute } from './activity-route'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderRoute(client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/p/cezarion/activity']}>
        <ProjectActivityRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
/** The header clock's time, "HH:MM:SS". */
const clockText = () => /\d{2}:\d{2}:\d{2}/.exec(document.querySelector('[data-slot="activity-clock"]')?.textContent ?? '')?.[0]

const chip = (label: string) => document.querySelector(`[data-chip="${label}"]`)?.textContent

describe('ProjectActivityRoute', () => {
  // Rule: docs/areas/web-ui.md § Activity view (live region).
  it('reads the project snapshot over HTTP and renders the header, chips and cards', async () => {
    const tasks = [
      run({ runId: 'a', title: 'Porting upstream SSE', status: RUN_STATUS.waiting, rung: 'waiting-on-workers', wait: { kind: ACTIVITY_WAIT_KIND.workers, since: iso(-1_000), detail: { owed: 1, total: 1, settled: 0, replies: true, recipientRunIds: ['b'] } } }),
      run({ runId: 'b', title: 'Implementing worker spawn', workers: [worker({ runId: 'w' }), worker({ runId: 'w2', status: RUN_STATUS.done, rung: 'done' })] }),
      run({ runId: 'c', title: 'Designing activity view', status: RUN_STATUS.waiting, rung: 'needs-you', wait: { kind: ACTIVITY_WAIT_KIND.human, since: iso(-1_000), detail: { reason: 'question', question: 'Accept?' } } }),
      run({ runId: 'd', title: 'Update waits docs', status: RUN_STATUS.queued, rung: 'queued' }),
    ]
    fetchMock.mockImplementation(async () => jsonResponse(snapshot(project({ name: 'cezarion', inReview: 3, tasks, requests: [request({ senderRunId: 'a', recipientRunId: 'b' })] }))))
    renderRoute()

    expect(await screen.findByRole('heading', { level: 1, name: 'Activity · cezarion' })).toBeTruthy()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/workspace/activity?project=default')
    expect(chip('needs you')).toBe('1 needs you')
    expect(chip('working')).toBe('1 working')
    expect(chip('waiting')).toBe('1 waiting')
    expect(chip('queued')).toBe('1 queued')
    expect(chip('active workers')).toBe('1 active workers')
    expect(chip('open requests')).toBe('1 open requests')
    expect(chip('in review')).toBe('3 in review')
    expect(screen.getByRole('link', { name: /3 in review/ }).getAttribute('href')).toBe('/p/cezarion/')
    expect(document.querySelector('[data-slot="activity-summary"]')?.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelectorAll('[data-activity-card]')).toHaveLength(4)
    const scope = screen.getByRole('navigation', { name: 'Activity scope' })
    expect(within(scope).getByRole('link', { name: 'This project' }).getAttribute('aria-current')).toBe('page')
    expect(within(scope).getByRole('link', { name: 'All projects' }).getAttribute('href')).toBe('/activity')
  })

  it('says so when the snapshot cannot be read, with a retry', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, 500))
    renderRoute()
    // bound: the query client retries a non-4xx failure once before it reports the error.
    const alert = await screen.findByRole('alert', {}, { timeout: 3_000 })
    expect(alert.textContent).toContain('Could not load activity')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('keeps the clock at the current time for a project the first read finds removed, until a real snapshot replaces it', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'unknown project: default' }, 404))
    const client = createQueryClient()
    renderRoute(client)
    expect(await screen.findByText('unknown project: default')).toBeTruthy()
    const clockNear = (at: number) => [-1_000, 0, 1_000].map((d) => CLOCK.format(at + d))
    expect(clockNear(Date.now())).toContain(clockText())

    fetchMock.mockImplementation(async () => jsonResponse(snapshot(project({ tasks: [run({ runId: 'a', title: 'Porting upstream SSE' })] }))))
    await act(async () => { await client.refetchQueries({ queryKey: activityQueryKey({ kind: 'project', projectId: 'default' }) }) })
    expect(await screen.findByText('Porting upstream SSE')).toBeTruthy()
    expect(screen.queryByText('unknown project: default')).toBeNull()
    expect(clockNear(NOW)).toContain(clockText())
  })

  it('shows a project the read finds removed as unavailable, as the topic does', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'unknown project: default' }, 404))
    renderRoute()
    expect((await screen.findByText('unknown project: default')).getAttribute('data-slot')).toBe('activity-project-notice')
  })

  it('treats a malformed snapshot as an error, never a crash', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ generatedAt: 'not a date', projects: 'nope' }))
    renderRoute()
    // bound: the query client retries a non-4xx failure once before it reports the error.
    const alert = await screen.findByRole('alert', {}, { timeout: 3_000 })
    expect(alert.textContent).toContain('unexpected body')
  })

  it.each([
    ['a store that cannot open', project({ unavailable: { status: 503, error: 'The run store is locked by another process.' } }), 'The run store is locked by another process.'],
    ['a project this cockpit has not loaded', project({ loaded: false }), 'Not loaded in this cockpit'],
  ])('never shows %s as idle', async (_name, value, notice) => {
    fetchMock.mockImplementation(async () => jsonResponse(snapshot(value)))
    renderRoute()
    expect((await screen.findByText(notice)).getAttribute('data-slot')).toBe('activity-project-notice')
    expect(screen.queryByText('No active work in this project.')).toBeNull()
  })

  it('shows an empty project with its review chip and no cards', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(snapshot(project({ inReview: 2 }))))
    renderRoute()
    expect(await screen.findByText('No active work in this project.')).toBeTruthy()
    expect(chip('in review')).toBe('2 in review')
  })
})
