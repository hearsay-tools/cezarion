import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { AutomationLogScreen, InlineLog } from './log'

// Radix's Select measures and scrolls; jsdom has neither.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const row = (seq: number, extra: Record<string, unknown>) => ({ seq, ts: '2026-07-15T02:00:00Z', automationId: 'a1', revision: 1, ...extra })
const records = [
  row(6, { result: 'failed', reason: 'Workflow “nope” does not exist.', receiptId: 'r1' }),
  row(5, { result: 'failed', reason: 'Paused after 3 consecutive launch failures; fix the task and enable it again.' }),
  row(4, { result: 'manual', runId: 'run-9', receiptId: 'r2' }),
  row(3, { result: 'catch-up', runId: 'run-8', receiptId: 'r3', reason: 'Missed 04:00; launched late.' }),
  row(2, { result: 'skipped', reason: 'Another cezar process holds the lease.' }),
  row(1, { result: 'launched', runId: 'run-7', receiptId: 'r4', event: 'issue.opened', githubNumber: 12, githubTitle: 'Crash on save', githubUrl: 'https://github.com/o/r/issues/12' }),
]

type Call = { path: string; method: string }
function stub(list: unknown[] = records, onOther?: (call: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    if (call.path.includes('/automation-log?')) return json({ records: list })
    return onOther ? onOther(call) : json({}, 404)
  }))
  return calls
}
const mountScreen = () => render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><AutomationLogScreen automationId="a1" automationName="Morning digest" timeZone="Europe/Warsaw" /></MemoryRouter></QueryClientProvider>)
const rowOf = (name: string | RegExp) => screen.getByText(name).closest('li') as HTMLElement

it('renders manual and failed rows with their tones and the task link', async () => {
  stub()
  mountScreen()
  const log = await screen.findByRole('list', { name: 'Automation execution log' })
  const items = within(log).getAllByRole('listitem')
  expect(items).toHaveLength(6)
  const pill = (item: HTMLElement) => item.querySelector('[data-slot="pill"]') as HTMLElement
  const tone = (item: HTMLElement) => pill(item).querySelector('[data-slot="status-dot"]')?.className ?? ''
  expect(pill(items[0]!).textContent).toBe('Failed')
  expect(pill(items[2]!).textContent).toBe('Manual')
  expect(pill(items[3]!).textContent).toBe('Catch up')
  expect(tone(items[0]!)).toContain('bg-danger')
  expect(tone(items[2]!)).toContain('bg-success')
  expect(tone(items[3]!)).toContain('bg-success')
  expect(tone(items[4]!)).toContain('bg-soft-foreground')
  expect(within(items[2]!).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/run-9')
  expect(within(items[5]!).getByRole('link', { name: 'Crash on save' }).getAttribute('href')).toBe('https://github.com/o/r/issues/12')
  expect(screen.getByText('Workflow “nope” does not exist.')).not.toBeNull()
  // 02:00Z on 2026-07-15 is 04:00 in Warsaw.
  expect(items[2]!.querySelector('time')?.textContent).toMatch(/04:00$/)
})

it('offers Retry task only on launch-error rows, and retries the same receipt', async () => {
  const calls = stub(records, () => json({ receiptId: 'r1', runId: 'run-10' }, 202))
  mountScreen()
  await screen.findByRole('list', { name: 'Automation execution log' })
  const retries = screen.getAllByRole('button', { name: 'Retry task' })
  expect(retries).toHaveLength(1)
  expect(within(rowOf('Workflow “nope” does not exist.')).getByRole('button', { name: 'Retry task' })).toBe(retries[0])
  fireEvent.click(retries[0]!)
  await vi.waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/automation-log/r1/retry'))).toBe(true))
})

it('does not offer Retry task for a failed launch the receipt has since recovered from', async () => {
  stub([row(2, { result: 'launched', runId: 'run-11', receiptId: 'r1' }), row(1, { result: 'failed', reason: 'boom', receiptId: 'r1' })])
  mountScreen()
  await screen.findByRole('list', { name: 'Automation execution log' })
  expect(screen.queryByRole('button', { name: 'Retry task' })).toBeNull()
})

it('shows a refused retry under its row', async () => {
  stub(records, () => json({ error: 'receipt is not retryable' }, 409))
  mountScreen()
  fireEvent.click(await screen.findByRole('button', { name: 'Retry task' }))
  expect((await screen.findByRole('alert')).textContent).toContain('receipt is not retryable')
})

it('filters by result', async () => {
  stub()
  mountScreen()
  await screen.findByRole('list', { name: 'Automation execution log' })
  const trigger = screen.getByRole('combobox', { name: 'Result' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.keyDown(await screen.findByRole('option', { name: 'Manual' }), { key: 'Enter' })
  const items = within(screen.getByRole('list', { name: 'Automation execution log' })).getAllByRole('listitem')
  expect(items).toHaveLength(1)
  expect(items[0]!.textContent).toContain('Manual')
})

it('says so when nothing has run yet', async () => {
  stub([])
  mountScreen()
  expect(await screen.findByText('Nothing has run yet.')).not.toBeNull()
})

it('shows a load error with a Retry that reloads', async () => {
  let failing = true
  vi.stubGlobal('fetch', vi.fn(async () => (failing ? json({ error: 'Unavailable' }, 503) : json({ records }))))
  mountScreen()
  const retry = await screen.findByRole('button', { name: 'Retry' })
  failing = false
  fireEvent.click(retry)
  await screen.findByRole('list', { name: 'Automation execution log' })
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('InlineLog shows the five latest rows under Recent activity and enables nothing', async () => {
  const calls = stub()
  render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><InlineLog automationId="a1" timeZone="Europe/Warsaw" /></MemoryRouter></QueryClientProvider>)
  expect(await screen.findByRole('heading', { name: 'Recent activity' })).not.toBeNull()
  expect(within(screen.getByRole('list', { name: 'Automation execution log' })).getAllByRole('listitem')).toHaveLength(5)
  expect(calls.some((call) => call.path.endsWith('/enable'))).toBe(false)
  // The five newest rows: two of them started a task.
  expect(screen.getAllByRole('link', { name: 'Open task' })).toHaveLength(2)
})

it('offers Retry task only on the newest failed row of a receipt', async () => {
  stub([
    row(3, { result: 'failed', reason: 'second failure', receiptId: 'r1' }),
    row(2, { result: 'failed', reason: 'first failure', receiptId: 'r1' }),
  ])
  mountScreen()
  await screen.findByRole('list', { name: 'Automation execution log' })
  expect(screen.getAllByRole('button', { name: 'Retry task' })).toHaveLength(1)
  expect(within(rowOf('second failure')).getByRole('button', { name: 'Retry task' })).not.toBeNull()
  expect(within(rowOf('first failure')).queryByRole('button', { name: 'Retry task' })).toBeNull()
})
