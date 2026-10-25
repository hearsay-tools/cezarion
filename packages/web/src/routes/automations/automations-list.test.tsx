import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { AutomationsList } from './automations-list'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const task = { prompt: 'Summarise yesterday', workflow: 'quick-task' }
const base = { revision: 1, description: '', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 } }
const schedule = { ...base, id: 'a1', name: 'Morning digest', kind: 'schedule', enabled: true, schedule: { type: 'daily', hour: 4, minute: 0 }, task, nextRunAt: '2026-07-16T02:00:00.000Z' }
const github = { ...base, id: 'g1', name: 'Triage issues', kind: 'github', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task, nextRunAt: '2026-07-16T02:05:00.000Z' }
/** The list's own request, plus the per-card activity reads that ride along with it. */
const logRecords = [{ seq: 1, ts: '2026-07-15T02:00:00Z', automationId: 'a1', revision: 1, result: 'no-match', reason: 'No new matching pull requests.' }]
function routed(handler: (path: string, init?: RequestInit) => Response | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    return handler(path, init) ?? (path.includes('/automation-log?') ? json({ records: [] }) : json({ error: 'not found' }, 404))
  }))
}
const response = (automations: unknown[], extra: Partial<AutomationsResponse> = {}) =>
  ({ available: true, timeZone: 'Europe/Warsaw', scheduler: { state: 'scheduled' }, automations, ...extra }) as AutomationsResponse

function mount(data: AutomationsResponse | undefined, error = '', refresh = vi.fn(async () => undefined), archived?: { value: boolean; onChange: (next: boolean) => void }) {
  const client = createQueryClient()
  render(<QueryClientProvider client={client}><MemoryRouter><AutomationsList data={data} error={error} refresh={refresh} {...(archived ? { archived: archived.value, onArchivedChange: archived.onChange } : {})} /></MemoryRouter></QueryClientProvider>)
  return refresh
}

it('shows a schedule row with its label and next run and runs it by hand', async () => {
  const calls: { path: string; method?: string | undefined }[] = []
  routed((path, init) => {
    calls.push({ path, method: init?.method })
    return path.endsWith('/run') ? json({ runId: 'run-7' }, 202) : undefined
  })
  const refresh = mount(response([schedule]))
  expect(screen.getByText('every day at 04:00')).not.toBeNull()
  expect(screen.getByText('Next run: Thu 04:00')).not.toBeNull()
  expect(screen.getByText('Scheduler running · GitHub available · Europe/Warsaw')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
  await waitFor(() => {
    expect(screen.getByRole('status').textContent).toContain('Started task')
  })
  expect(calls.find((call) => call.path.endsWith('/a1/run'))?.method).toBe('POST')
  const open = screen.getByRole('link', { name: 'Open task' })
  expect(open.getAttribute('href')).toBe('/tasks/run-7')
  expect(open.className).toContain('min-h-11')
  expect(refresh).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Test filter' })).toBeNull()
})

it('reports a refused run under the card without losing the row', async () => {
  routed((path) => (path.endsWith('/run') ? json({ error: 'Another cezar process holds the lease.' }, 409) : undefined))
  mount(response([schedule]))
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Another cezar process holds the lease.')
  expect(screen.getByText('Morning digest')).not.toBeNull()
})

it('shows a github row with Test filter and no Run now', () => {
  routed(() => undefined)
  mount(response([github], { available: false, reason: 'No GitHub remote configured.' }))
  expect(screen.getByText('on issue.opened · every 5 min')).not.toBeNull()
  expect(screen.getByText('continuous')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Test filter' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull()
  expect(screen.getByText('Scheduler running · GitHub unavailable · No GitHub remote configured. · Europe/Warsaw')).not.toBeNull()
})

it('shows a paused schedule with no next run, offers Enable, and still allows Run now', () => {
  routed(() => undefined)
  mount(response([{ ...schedule, enabled: false, nextRunAt: undefined }], { scheduler: { state: 'idle' } }))
  expect(screen.getByText('Paused')).not.toBeNull()
  expect(screen.getByText('Next run: —')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Enable' })).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Run now' })).not.toBeNull()
  expect(screen.getByText(/Scheduler idle/)).not.toBeNull()
})

it('renders the empty state with New automation', () => {
  mount(response([]))
  expect(screen.getByRole('heading', { name: 'No automations yet' })).not.toBeNull()
  expect(screen.getByText(/Create one paused, preview it, then enable it/)).not.toBeNull()
  expect(screen.getAllByRole('link', { name: 'New automation' }).length).toBeGreaterThan(0)
})

it('renders a loading state and an error with Retry', () => {
  const refresh = mount(undefined)
  expect(screen.getByText('Loading automations…')).not.toBeNull()
  cleanup()
  const retry = mount(undefined, 'Error: boom')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
})

it('shows the recent activity of each automation on its card, newest first and capped at five', async () => {
  routed((path) => (path.includes('/automation-log?automationId=a1') ? json({ records: logRecords }) : undefined))
  mount(response([schedule]))
  expect(await screen.findByText('No new matching pull requests.')).not.toBeNull()
  expect(screen.getByRole('heading', { name: 'Recent activity' })).not.toBeNull()
})

// hearsay-tools/cezarion#1465: one-time schedules in the list.
const once = { ...base, id: 'o1', name: 'Check the rollout', kind: 'schedule', enabled: true, schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw' }, task, nextRunAt: '2030-01-15T08:00:00.000Z', onceStatus: 'waiting' }

it('shows the once label and Waiting badge', () => {
  routed(() => undefined)
  mount(response([once, { ...once, id: 'o2', name: 'Missed one', enabled: false, nextRunAt: undefined, onceStatus: 'missed' }]))
  expect(screen.getAllByText('once on Tue 15 Jan 2030 at 09:00 (Europe/Warsaw)')).toHaveLength(2)
  expect(screen.getByText('Waiting')).not.toBeNull()
  expect(screen.getByText('Missed')).not.toBeNull()
  expect(screen.queryByText('Enabled')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2)
})

it('Cancel confirms and posts', async () => {
  const calls: { path: string; method?: string | undefined }[] = []
  routed((path, init) => {
    calls.push({ path, method: init?.method })
    return path.endsWith('/cancel') ? json({ automation: { ...once, archived: { at: '2026-10-22T13:00:00Z', outcome: 'cancelled' } } }) : undefined
  })
  const refresh = mount(response([once]))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(calls.some((call) => call.path.endsWith('/cancel'))).toBe(false)
  expect(screen.getByText('Cancel “Check the rollout”? It will never run, and it moves to Archived.')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
  expect(screen.queryByText(/It will never run/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule' }))
  await waitFor(() => expect(calls.find((call) => call.path.endsWith('/o1/cancel'))?.method).toBe('POST'))
  await waitFor(() => expect(refresh).toHaveBeenCalled())
})

// The Cancel button leaves the DOM when the confirm opens, so focus moves to Keep, not to <body>.
it('opening the cancel confirm moves focus to Keep, and Keep returns it to Cancel', () => {
  routed(() => undefined)
  mount(response([once]))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }))
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
})

it('Archived filter requests archived=only and links the run', () => {
  routed(() => undefined)
  const onChange = vi.fn()
  mount(response([once]), '', undefined, { value: false, onChange })
  const filter = screen.getByRole('button', { name: 'Archived' })
  expect(filter.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(filter)
  expect(onChange).toHaveBeenCalledWith(true)
  cleanup()
  const launched = { ...once, enabled: false, nextRunAt: undefined, onceStatus: 'archived', archived: { at: '2030-01-15T08:00:05Z', outcome: 'launched', runId: 'run-9' } }
  const cancelled = { ...once, id: 'o3', name: 'Dropped', enabled: false, nextRunAt: undefined, onceStatus: 'archived', archived: { at: '2026-10-22T13:00:00Z', outcome: 'cancelled' } }
  mount(response([launched, cancelled]), '', undefined, { value: true, onChange })
  expect(screen.getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getAllByText('Archived', { selector: '[data-slot="pill"], [data-slot="pill"] *' }).length).toBeGreaterThan(0)
  expect(screen.getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/run-9')
  expect(screen.getByText('Cancelled — no task was started.')).not.toBeNull()
  for (const name of ['Edit', 'Pause', 'Enable', 'Run now', 'Cancel']) expect(screen.queryByRole(name === 'Edit' ? 'link' : 'button', { name })).toBeNull()
})

// Review of #1465: an archived schedule stays inspectable. Its card links to a read-only detail.
it('an archived card links to its read-only detail', () => {
  routed(() => undefined)
  const launched = { ...once, enabled: false, nextRunAt: undefined, onceStatus: 'archived', archived: { at: '2030-01-15T08:00:05Z', outcome: 'launched', runId: 'run-9' } }
  mount(response([launched]), '', undefined, { value: true, onChange: vi.fn() })
  expect(screen.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/automations/o1')
})
