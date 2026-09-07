import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun, WorkerInspection } from '@open-mercato/cezar-api-client'
import { RunHeader, type RunTab } from './run-header'

const parentId = '10000000-0000-4000-8000-000000000001'
const workerId = '10000000-0000-4000-8000-000000000002'
const at = '2026-09-06T00:00:00.000Z'
const workspace = { ownerRunId: workerId, resourceId: workerId, kind: 'owned-isolated' as const, path: '/managed/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) }
const worker: WorkerInspection = { workerId, parentRunId: parentId, status: 'failed', workspace, destroy: { requestedAt: at, phase: 'incomplete', remaining: ['branch'], error: 'Branch is checked out' } }
const ordinary: ApiRun = { id: parentId, title: 'Parent', task: 'Do task', workflow: 'quick-task', status: 'running', createdAt: at, tokensUsed: 0, archived: false, steps: [] }
const root: ApiRun = { ...ordinary, delegation: { role: 'root', permissions: [], receipts: [{ requestId: workerId, workerId, requestHash: 'b'.repeat(64) }] } }
const child: ApiRun = { ...ordinary, id: workerId, delegation: { role: 'worker', permissions: [], parentRunId: parentId, workspace } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function setup(run: ApiRun, response: () => Promise<Response> = async () => json({ workers: [] }), tab = '') {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/relationships')) return response()
    if (path.endsWith('/runs')) return json([])
    if (path.endsWith('/providers/status')) return json({ providers: [] })
    if (path.endsWith(`/runs/${parentId}`)) return json({ error: 'not found' }, 404)
    return json({})
  }))
  const client = createQueryClient(); client.setDefaultOptions({ queries: { retry: false } })
  const view = render(<QueryClientProvider client={client}><ProjectScopeProvider projectId="sample"><MemoryRouter initialEntries={[`/p/sample/tasks/${run.id}${tab}`]}><RunHeader run={run} tab={(tab.slice(1) || 'session') as RunTab} /></MemoryRouter></ProjectScopeProvider></QueryClientProvider>)
  return { ...view, requests, client }
}
afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.unstubAllGlobals() })

it.each(['', '/changes', '/commits', '/files'])('keeps a scoped parent link in the shared header on tab %s', async tab => {
  const { requests } = setup(child, async () => json({ parentRunId: parentId, workers: [] }), tab)
  const link = screen.getByRole('link', { name: new RegExp(`parent task ${parentId}`, 'i') })
  expect(link.getAttribute('href')).toBe(`/p/sample/tasks/${parentId}`)
  expect(link.className).toContain('min-h-11')
  await waitFor(() => expect(requests).toContain(`/api/v1/p/sample/runs/${workerId}/relationships`))
})
it('renders complete worker status and incomplete cleanup in accessible scoped links', async () => {
  setup(root, async () => json({ workers: [worker] }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  await within(panel).findByText('failed')
  expect(within(panel).getByRole('link', { name: `Worker task ${workerId}` }).getAttribute('href')).toBe(`/p/sample/tasks/${workerId}`)
  expect(within(panel).getByText(/Cleanup incomplete/)).toBeTruthy()
  expect(within(panel).getByText(/branch/)).toBeTruthy()
  expect(panel.querySelector('a a')).toBeNull()
})
it('keeps durable IDs while loading, failing and retrying instead of inventing an empty list', async () => {
  let finish!: (r: Response) => void
  let attempts = 0
  setup(root, () => ++attempts === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(json({ workers: [worker] })))
  expect(screen.getByRole('link', { name: `Worker task ${workerId}` })).toBeTruthy()
  expect(screen.getByText(/Loading relationships/)).toBeTruthy()
  await act(async () => finish(json({ error: 'offline' }, 503)))
  expect(await screen.findByText(/Could not load relationships/)).toBeTruthy()
  expect(screen.queryByText('No workers')).toBeNull()
  expect(screen.getByRole('link', { name: `Worker task ${workerId}` })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry relationships' }))
  expect(await screen.findByText('failed')).toBeTruthy()
})
it('keeps IDs offline and marks unavailable worker records separately from no workers', async () => {
  onlineManager.setOnline(false)
  const view = setup(root)
  expect(screen.getByRole('link', { name: `Worker task ${workerId}` })).toBeTruthy()
  expect(screen.getByText(/Offline/)).toBeTruthy()
  act(() => onlineManager.setOnline(true))
  expect(await screen.findByText(/Record unavailable or deleted/)).toBeTruthy()
  expect(screen.queryByText('No workers')).toBeNull()
  view.unmount()
})
it('shows empty only after a successful root lookup and leaves ordinary records unchanged', async () => {
  const view = setup(ordinary)
  expect(screen.queryByRole('region', { name: 'Task relationships' })).toBeNull()
  expect(view.requests.some(path => path.endsWith('/relationships'))).toBe(false)
  view.unmount()
  setup({ ...root, delegation: { role: 'root', permissions: [], receipts: [] } })
  expect(await screen.findByText('No workers')).toBeTruthy()
})

it('keeps unavailable parent navigation and provides a parent-specific retry', async () => {
  const { requests } = setup(child, async () => json({ parentRunId: parentId, workers: [] }))
  expect(await screen.findByText('Parent record unavailable or deleted')).toBeTruthy()
  expect(screen.getByRole('link', { name: `Parent task ${parentId}` })).toBeTruthy()
  const count = requests.filter(path => path.endsWith(`/runs/${parentId}`)).length
  fireEvent.click(screen.getByRole('button', { name: 'Retry parent task' }))
  await waitFor(() => expect(requests.filter(path => path.endsWith(`/runs/${parentId}`))).toHaveLength(count + 1))
})
it('keeps last fetched worker status on a failed refresh and rejects malformed relationship responses', async () => {
  let attempts = 0
  const { client } = setup(root, async () => ++attempts === 1 ? json({ workers: [worker] }) : json({ workers: 'invalid' }))
  expect(await screen.findByText('failed')).toBeTruthy()
  await act(async () => { await client.invalidateQueries({ queryKey: ['sample', 'runs', 'relationships', parentId] }) })
  expect(await screen.findByText(/Could not load relationships/)).toBeTruthy()
  expect(screen.getByText('failed')).toBeTruthy()
  expect(screen.getByRole('link', { name: `Worker task ${workerId}` })).toBeTruthy()
  expect(screen.queryByText('No workers')).toBeNull()
})

it('keeps every one of 32 worker links in the bounded list, independent of root receipts', async () => {
  const workers = Array.from({ length: 32 }, (_, index) => ({
    ...worker, workerId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }))
  setup({ ...root, delegation: { role: 'root', permissions: [], receipts: [] } }, async () => json({ workers }))
  const links = await screen.findAllByRole('link', { name: /^Worker task/ })
  expect(links).toHaveLength(32)
  expect(links.at(-1)?.getAttribute('href')).toBe(`/p/sample/tasks/${workers.at(-1)!.workerId}`)
  expect(links.every(link => link.className.includes('min-h-11'))).toBe(true)
  const list = screen.getByRole('list')
  expect(list.className).toContain('max-h-64')
  expect(list.className).toContain('overflow-y-auto')
})
