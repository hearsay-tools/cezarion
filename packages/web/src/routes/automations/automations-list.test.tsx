import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { AutomationsList } from './automations-list'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const task = { prompt: 'Summarise yesterday', workflow: 'quick-task' }
const base = { revision: 1, description: '', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 } }
const schedule = { ...base, id: 'a1', name: 'Morning digest', kind: 'schedule', enabled: true, schedule: { type: 'daily', hour: 4, minute: 0 }, task, nextRunAt: '2026-07-16T02:00:00.000Z', latestLog: { seq: 1, ts: '2026-07-15T02:00:00Z', automationId: 'a1', revision: 1, result: 'launched', reason: 'Started the scheduled run.' } }
const github = { ...base, id: 'g1', name: 'Triage issues', kind: 'github', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task, nextRunAt: '2026-07-16T02:05:00.000Z' }
const response = (automations: unknown[], extra: Partial<AutomationsResponse> = {}) =>
  ({ available: true, timeZone: 'Europe/Warsaw', scheduler: { state: 'scheduled' }, automations, ...extra }) as AutomationsResponse

function mount(data: AutomationsResponse | undefined, error = '', refresh = vi.fn(async () => undefined)) {
  const client = createQueryClient()
  render(<QueryClientProvider client={client}><MemoryRouter><AutomationsList data={data} error={error} refresh={refresh} /></MemoryRouter></QueryClientProvider>)
  return refresh
}

it('shows a schedule row with its label and next run and runs it by hand', async () => {
  const calls: { path: string; method?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method })
    return json({ runId: 'run-7' }, 202)
  }))
  const refresh = mount(response([schedule]))
  expect(screen.getByText('every day at 04:00')).not.toBeNull()
  expect(screen.getByText('Next run: Thu 04:00')).not.toBeNull()
  expect(screen.getByText('Started the scheduled run.')).not.toBeNull()
  expect(screen.getByText('Scheduler running · GitHub available · Europe/Warsaw')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
  expect((await screen.findByRole('status')).textContent).toContain('Started task')
  expect(calls.find((call) => call.path.endsWith('/a1/run'))?.method).toBe('POST')
  expect(screen.getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/run-7')
  expect(refresh).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Test filter' })).toBeNull()
})

it('reports a refused run under the card without losing the row', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Another cezar process holds the lease.' }, 409)))
  mount(response([schedule]))
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Another cezar process holds the lease.')
  expect(screen.getByText('Morning digest')).not.toBeNull()
})

it('shows a github row with Test filter and no Run now', () => {
  mount(response([github], { available: false, reason: 'No GitHub remote configured.' }))
  expect(screen.getByText('on issue.opened · every 5 min')).not.toBeNull()
  expect(screen.getByText('continuous')).not.toBeNull()
  expect(screen.getByRole('button', { name: 'Test filter' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull()
  expect(screen.getByText('Scheduler running · GitHub unavailable · No GitHub remote configured. · Europe/Warsaw')).not.toBeNull()
})

it('shows a paused schedule with no next run, offers Enable, and still allows Run now', () => {
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
