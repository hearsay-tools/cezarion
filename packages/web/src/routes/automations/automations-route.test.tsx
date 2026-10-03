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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/automations') ? (failed ? json({ error: 'Unavailable' }, 503) : json(listBody)) : json({ error: 'not found' }, 404)))
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
    return path.endsWith('/automations') ? json(body) : json({ error: 'not found' }, 404)
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
