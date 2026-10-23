import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { AutomationsRoute } from './automations-route'

// The workspace event bus keeps its listener set private; capture it so a test can fire the SSE
// `automation-change` news the server emits after every edit.
const bus = vi.hoisted(() => ({ listeners: new Set<(name: string, payload: unknown) => void>() }))
vi.mock('@/api/global-events', async (original) => ({
  ...(await original<typeof import('@/api/global-events')>()),
  onWorkspaceEvent: (listener: (name: string, payload: unknown) => void) => { bus.listeners.add(listener); return () => bus.listeners.delete(listener) },
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(mode: 'list' | 'new' | 'edit' | 'log', health: unknown) {
  const client = createQueryClient()
  if (health !== undefined) client.setQueryData(queryKeys.health, health)
  return render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute mode={mode} /></MemoryRouter></QueryClientProvider>)
}

it.each(['list', 'new', 'edit', 'log'] as const)('keeps %s gated, and says how to turn automations on, when they are off', (mode) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  mount(mode, { capabilities: { automations: false } })
  expect(screen.getByText('Automations are off')).not.toBeNull()
  expect(screen.getByText(/CEZ_AUTOMATIONS=1/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('waits for health before it renders anything or fetches', () => {
  const client = createQueryClient()
  // Health never answers: a pending query, no cached payload.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute mode="new" /></MemoryRouter></QueryClientProvider>)
  expect(screen.getByText('Loading automations…')).not.toBeNull()
  expect(screen.queryByText('Automations are off')).toBeNull()
  expect(document.querySelector('#automation-name')).toBeNull()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const stored = { id: 'a1', name: 'Saved trigger', description: '', kind: 'schedule', schedule: { type: 'daily' }, task: { prompt: 'Go', workflow: 'quick-task' }, enabled: false, revision: 2, createdAt: '', updatedAt: '', counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 } }
const listBody = { automations: [stored], available: true, timeZone: 'Europe/Warsaw', scheduler: { state: 'idle' } }

function mountAt(path: string, mode: 'list' | 'new' | 'edit' | 'log') {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { capabilities: { automations: true } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/automations/:automationId/log" element={<AutomationsRoute mode={mode} />} />
    <Route path="/automations/:automationId" element={<AutomationsRoute mode={mode} />} />
    <Route path="/automations" element={<AutomationsRoute mode={mode} />} />
  </Routes></MemoryRouter></QueryClientProvider>)
}

it('shows an editor load error and retries the same automation', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let failed = true
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => /\/automations(\?archived=include)?$/.test(String(input)) ? (failed ? json({ error: 'Unavailable' }, 503) : json(listBody)) : json({ error: 'not found' }, 404)))
  mountAt('/automations/a1', 'edit')
  const retry = await screen.findByRole('button', { name: 'Retry' })
  failed = false
  fireEvent.click(retry)
  await screen.findByDisplayValue('Saved trigger')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull())
})

it('says an unknown automation was not found, with a way back', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(listBody)))
  mountAt('/automations/missing', 'edit')
  expect(await screen.findByText('Automation not found')).not.toBeNull()
  expect(screen.getByRole('link', { name: 'Back to automations' })).not.toBeNull()
})

it('opens the execution log with the automation name and the zone from the list', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/automation-log?')
    ? json({ records: [{ seq: 1, ts: '2026-07-15T02:00:00Z', automationId: 'a1', revision: 1, result: 'manual', runId: 'run-42' }] })
    : json(listBody)))
  mountAt('/automations/a1/log', 'log')
  expect(await screen.findByText('Saved trigger')).not.toBeNull()
  expect((await screen.findByRole('link', { name: 'Open task' })).getAttribute('href')).toBe('/tasks/run-42')
})

it('keeps the typed name when another cockpit bumps the revision, and drops it only on an explicit Reload', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  let body = listBody
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if ((init?.method ?? 'GET') === 'PUT') return json({ error: 'automation revision conflict' }, 409)
    return /\/automations(\?archived=include)?$/.test(path) ? json(body) : json({ error: 'not found' }, 404)
  }))
  mountAt('/automations/a1', 'edit')
  const name = await screen.findByDisplayValue('Saved trigger')
  fireEvent.change(name, { target: { value: 'Typed locally' } })
  // Someone else edits it: revision 3, a new name, and the SSE signal that follows.
  body = { ...listBody, automations: [{ ...stored, revision: 3, name: 'Edited elsewhere name' }] }
  bus.listeners.forEach((listener) => listener('automation-change', { project: 'p', automationId: 'a1', revision: 3 }))
  await waitFor(() => expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(2))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Typed locally')
  // Saving surfaces the conflict, and Reload is the one act that replaces the draft.
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
  await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Edited elsewhere name'))
})

it('renders the automations list at /automations', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(listBody)))
  mountAt('/automations', 'list')
  expect(await screen.findByText('Saved trigger')).not.toBeNull()
  expect(screen.getByRole('link', { name: 'New automation' })).not.toBeNull()
  expect(screen.queryByText('Automation not found.')).toBeNull()
})

// hearsay-tools/cezarion#1465: the Archived filter refetches the list with the query.
it('the Archived filter refetches the list with archived=only and back', async () => {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return json(listBody) }))
  mountAt('/automations', 'list')
  expect(await screen.findByText('Saved trigger')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
  await waitFor(() => expect(urls.some((url) => /\/automations\?archived=only$/.test(url))).toBe(true))
  const count = urls.length
  fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
  await waitFor(() => expect(urls.slice(count).some((url) => /\/automations$/.test(url))).toBe(true))
})

// Review of #1465: the link the CLI and the agent tools print for an archived one-time schedule
// opens a read-only record: what happened, the task, what it ran with, its log, and Delete.
it('an archived one-time schedule opens read-only with its task, inputs, log and Delete', async () => {
  const archived = {
    ...stored, id: 'o1', name: 'Check the rollout', schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw' },
    task: { prompt: 'Check the rollout of the parser', workflow: 'quick-task', model: 'opus' }, onceStatus: 'archived',
    archived: { at: '2030-01-15T08:00:05Z', outcome: 'launched', runId: 'run-9', receiptId: 'r1' },
  }
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (url.includes('/automation-log?')) return json({ records: [{ seq: 1, ts: '2030-01-15T08:00:05Z', automationId: 'o1', revision: 2, result: 'launched', runId: 'run-9' }] })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return /\/automations\?archived=include$/.test(url) ? json({ ...listBody, automations: [archived] }) : json({ error: 'not found' }, 404)
  }))
  mountAt('/automations/o1', 'edit')
  expect(await screen.findByText('Started its task.')).not.toBeNull()
  expect(screen.getAllByRole('link', { name: 'Open task' })[0]!.getAttribute('href')).toBe('/tasks/run-9')
  expect(screen.getByText('Check the rollout of the parser')).not.toBeNull()
  expect(screen.getByText('opus')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  expect(screen.queryByLabelText('Name')).toBeNull()
  await screen.findByRole('heading', { name: /Recent activity/ })
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete schedule' }))
  await waitFor(() => expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/automations/o1'))).toBe(true))
})

it('the full log of an archived schedule offers no Retry task', async () => {
  const archived = {
    ...stored, id: 'o1', name: 'Check the rollout', schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw' },
    task: { prompt: 'Check it' }, onceStatus: 'archived',
    archived: { at: '2030-01-15T10:00:00Z', outcome: 'cancelled' },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/automation-log?')) return json({ records: [{ seq: 1, ts: '2030-01-15T08:00:05Z', automationId: 'o1', revision: 2, result: 'failed', reason: 'model gone', receiptId: 'r1' }] })
    return /\/automations\?archived=include$/.test(url) ? json({ ...listBody, automations: [archived] }) : json({ error: 'not found' }, 404)
  }))
  mountAt('/automations/o1/log', 'log')
  expect(await screen.findByText('model gone')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry task' })).toBeNull()
})

// Review of #1469: a cancelled schedule can keep an earlier failed-launch row. The server refuses
// a retry of an archived schedule, so its read-only page offers none.
it('an archived schedule shows its failed-launch rows without Retry task', async () => {
  const archived = {
    ...stored, id: 'o1', name: 'Check the rollout', schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw' },
    task: { prompt: 'Check it' }, onceStatus: 'archived',
    archived: { at: '2030-01-15T10:00:00Z', outcome: 'cancelled' },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/automation-log?')) return json({ records: [{ seq: 1, ts: '2030-01-15T08:00:05Z', automationId: 'o1', revision: 2, result: 'failed', reason: 'model gone', receiptId: 'r1' }] })
    return /\/automations\?archived=include$/.test(url) ? json({ ...listBody, automations: [archived] }) : json({ error: 'not found' }, 404)
  }))
  mountAt('/automations/o1', 'edit')
  expect(await screen.findByText('model gone')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry task' })).toBeNull()
})
