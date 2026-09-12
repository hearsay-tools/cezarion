import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { AutomationsRoute } from './automations'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const automation = { id: 'a1', name: 'Saved trigger', description: '', events: ['pull_request.opened'], intervalSeconds: 86400, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}', workflow: 'quick-task' }, enabled: false, revision: 2 }
function mount() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { capabilities: { automations: true } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/automations/a1']}><Routes><Route path="/automations/:automationId" element={<AutomationsRoute mode="edit" />} /><Route path="/automations" element={<div>Saved</div>} /></Routes></MemoryRouter></QueryClientProvider>)
}
it('shows the saved trigger and enables an edited automation only when selected', async () => {
  const calls: { path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return json(String(input).endsWith('/automations') ? { automations: [automation], available: true, scheduler: { state: 'idle' } } : {})
  }))
  mount()
  await screen.findByDisplayValue('Saved trigger')
  expect(screen.getByText(/pull_request.opened/).textContent).toContain('1440')
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
  await screen.findByText('Saved')
  expect(calls.find((call) => call.path.endsWith('/a1') && call.body)?.body).toMatchObject({ events: ['pull_request.opened'], intervalSeconds: 86400, expectedRevision: 2 })
  expect(calls.some((call) => call.path.endsWith('/a1/enable'))).toBe(true)
})
it('shows an editor load error and retries the same automation', async () => {
  let failed = true
  vi.stubGlobal('fetch', vi.fn(async () => failed ? json({ error: 'Unavailable' }, 503) : json({ automations: [automation], available: true, scheduler: { state: 'idle' } })))
  mount()
  const retry = await screen.findByRole('button', { name: 'Retry' })
  failed = false
  fireEvent.click(retry)
  await screen.findByDisplayValue('Saved trigger')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
})

it('shows recent execution activity on the automation list without enabling it', async () => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input); requests.push(path)
    return json(path.includes('/automation-log?automationId=a1') ? { records: [{ seq: 1, ts: '2026-09-11T12:00:00Z', automationId: 'a1', result: 'no-match', reason: 'No new matching pull requests.' }] } : { automations: [automation], available: true, scheduler: { state: 'idle' } })
  }))
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { capabilities: { automations: true } })
  render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute /></MemoryRouter></QueryClientProvider>)
  expect(await screen.findByText('No new matching pull requests.')).not.toBeNull()
  expect(screen.getByRole('heading', { name: 'Recent activity' })).not.toBeNull()
  expect(requests.some((path) => path.endsWith('/enable'))).toBe(false)
})

it.each(['list', 'new', 'edit', 'log'] as const)('keeps %s gated when automations are off', async (mode) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { capabilities: { automations: false } })
  render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute mode={mode} /></MemoryRouter></QueryClientProvider>)
  expect(screen.getByText('GitHub automations are off')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Save automation' })).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  { available: true, state: 'scheduled', tone: 'text-success', reason: undefined },
  { available: true, state: 'idle', tone: 'text-muted-foreground', reason: undefined },
  { available: false, state: 'scheduled', tone: 'text-destructive', reason: 'GitHub authentication expired.' },
  { available: false, state: 'idle', tone: 'text-destructive', reason: 'No GitHub remote configured.' },
])('renders scheduler $state with availability $available honestly for populated and empty lists', async ({ available, state, tone, reason }) => {
  for (const automations of [[automation], []]) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json(String(input).includes('/automation-log')
      ? { records: [] }
      : { automations, available, reason, scheduler: { state } })))
    const client = createQueryClient()
    client.setQueryData(queryKeys.health, { capabilities: { automations: true } })
    render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute /></MemoryRouter></QueryClientProvider>)
    const status = await screen.findByText(`Scheduler ${state} · GitHub ${available ? 'available' : 'unavailable'}${reason ? ` · ${reason}` : ''}`)
    expect(status.classList.contains(tone)).toBe(true)
    if (tone !== 'text-success') expect(status.classList.contains('text-success')).toBe(false)
    cleanup()
    client.clear()
  }
})
