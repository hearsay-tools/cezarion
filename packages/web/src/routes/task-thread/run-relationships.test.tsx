import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { ApiRun, WorkerInspection } from '@open-mercato/cezar-api-client'
import { RunRelationshipsPanel } from './run-relationships'

const parentId = '10000000-0000-4000-8000-000000000001'
const workerId = '10000000-0000-4000-8000-000000000002'
const at = '2026-09-06T00:00:00.000Z'
const workspace = { ownerRunId: workerId, resourceId: workerId, kind: 'owned-isolated' as const, path: '/managed/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) }
const worker: WorkerInspection = { workerId, parentRunId: parentId, status: 'failed', workspace, destroy: { requestedAt: at, phase: 'incomplete', remaining: ['branch'], error: 'Branch is checked out' } }
const ordinary: ApiRun = { id: parentId, title: 'Parent', task: 'Do task', workflow: 'quick-task', status: 'running', createdAt: at, tokensUsed: 0, archived: false, steps: [] }
const root: ApiRun = { ...ordinary, delegation: { role: 'root', permissions: [], receipts: [{ requestId: workerId, workerId, requestHash: 'b'.repeat(64) }] } }
const child: ApiRun = { ...ordinary, id: workerId, delegation: { role: 'worker', permissions: [], parentRunId: parentId, workspace } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function setup(run: ApiRun, response: () => Promise<Response> = async () => json({ workers: [] }),
  destroyResponse: () => Promise<Response> = async () => json({ workerId, state: 'complete', remaining: [] })) {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/relationships')) return response()
    if (path.endsWith('/worker-destroy')) return destroyResponse()
    if (path.endsWith('/runs')) return json([])
    if (path.endsWith('/providers/status')) return json({ providers: [] })
    if (path.endsWith(`/runs/${parentId}`)) return json({ error: 'not found' }, 404)
    return json({})
  }))
  const client = createQueryClient(); client.setDefaultOptions({ queries: { retry: false } })
  const view = render(
    <QueryClientProvider client={client}>
      <ProjectScopeProvider projectId="sample">
        <MemoryRouter initialEntries={[`/p/sample/tasks/${run.id}`]}>
          <RunRelationshipsPanel run={run} />
        </MemoryRouter>
      </ProjectScopeProvider>
    </QueryClientProvider>,
  )
  return { ...view, requests, client }
}
afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.unstubAllGlobals() })

it('keeps a scoped parent link in the relationships panel', async () => {
  const { requests } = setup(child, async () => json({ parentRunId: parentId, workers: [] }))
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
it('says nothing about a cleanup that completed with nothing left behind', async () => {
  // Every destroyed worker carried a "Cleanup complete" line, on every row, forever. A
  // cleanup that left nothing behind is the expected end of a worker's life, so the line
  // only ever told the reader what they already assumed (#402 feedback).
  const tidy: WorkerInspection = { ...worker, status: 'done', destroy: { requestedAt: at, phase: 'complete', remaining: [] } }
  setup(root, async () => json({ workers: [tidy] }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  await within(panel).findByText('done')
  expect(within(panel).queryByText(/Cleanup/)).toBeNull()
})
it('still reports a cleanup that completed with something left behind', async () => {
  const leftovers: WorkerInspection = { ...worker, status: 'done', destroy: { requestedAt: at, phase: 'complete', remaining: ['worktree'] } }
  setup(root, async () => json({ workers: [leftovers] }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  expect(await within(panel).findByText(/Cleanup complete/)).toBeTruthy()
  expect(within(panel).getByText(/worktree/)).toBeTruthy()
})
it('still reports a cleanup that is only part-way through', async () => {
  const midway: WorkerInspection = { ...worker, status: 'done', destroy: { requestedAt: at, phase: 'cleaning', remaining: [] } }
  setup(root, async () => json({ workers: [midway] }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  expect(await within(panel).findByText(/Cleanup cleaning/)).toBeTruthy()
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

it.each([root, child])('shows request waiting for either participant ($id)', run => {
  if (!run.delegation || run.delegation.role === 'invalid') throw Error('fixture');
  setup({ ...run, delegation: { ...run.delegation, wait: { id: '10000000-0000-4000-8000-000000000003', workerIds: [], requestIds: [workerId], phase: 'parked', deadline: at, outcomes: [] } } });
  expect(screen.getByText(run.delegation.role === 'worker' ? /Waiting on parent reply/ : /Waiting on worker replies/)).toBeTruthy();
});


it('collapses worker navigation on phones and preserves its scoped links when reopened', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  setup(root, async () => json({ workers: [worker] }))
  const switcher = await screen.findByRole('button', { name: /Parent.*Workers 1/ })
  expect(switcher.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('link', { name: `Worker task ${workerId}` })).toBeNull()
  fireEvent.click(switcher)
  expect(switcher.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('link', { name: `Worker task ${workerId}` }).getAttribute('href')).toBe(`/p/sample/tasks/${workerId}`)
  fireEvent.click(switcher)
  expect(screen.queryByRole('link', { name: `Worker task ${workerId}` })).toBeNull()
})

// #816: capacity is reclaimable, so history beyond the old 32 is listed in full.
const workerAt = (n: number): WorkerInspection => {
  const id = `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  return { workerId: id, parentRunId: parentId, status: 'done', workspace: { ...workspace, ownerRunId: id, resourceId: id }, destroy: { requestedAt: at, phase: 'complete', remaining: [] } }
}
it('lists every historical worker beyond 32 without slicing (#816)', async () => {
  const many = Array.from({ length: 33 }, (_, n) => workerAt(n))
  const run: ApiRun = { ...ordinary, delegation: { role: 'root', permissions: [], receipts: many.map(w => ({ requestId: w.workerId, workerId: w.workerId, requestHash: 'b'.repeat(64) })) } }
  setup(run, async () => json({ workers: many, capacity: { outstanding: 0, limit: 32, created: 33, creationLimit: 1024 } }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  await waitFor(() => expect(within(panel).getAllByRole('link', { name: /^Worker task / })).toHaveLength(33))
})
it('shows how much worker capacity the parent uses (#816)', async () => {
  setup(root, async () => json({ workers: [worker], capacity: { outstanding: 12, limit: 32, created: 40, creationLimit: 1024 } }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  expect(await within(panel).findByText('Capacity 12 of 32 in use')).toBeTruthy()
  expect(within(panel).queryByText(/All 32 worker slots are in use/)).toBeNull()
})
it('explains exhausted capacity and its recovery (#816)', async () => {
  setup(root, async () => json({ workers: [worker], capacity: { outstanding: 32, limit: 32, created: 32, creationLimit: 1024 } }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  expect(await within(panel).findByText('All 32 worker slots are in use. Clean up finished workers to free a slot.')).toBeTruthy()
})
it('offers Clean up only for settled workers that are not verifiably destroyed, and posts the human destroy (#816)', async () => {
  const settled: WorkerInspection = { ...worker, status: 'done', destroy: undefined }
  const live = { ...workerAt(1), status: 'running' as const, destroy: undefined }
  const gone = workerAt(2)
  const run: ApiRun = { ...ordinary, delegation: { role: 'root', permissions: [], receipts: [settled, live, gone].map(w => ({ requestId: w.workerId, workerId: w.workerId, requestHash: 'b'.repeat(64) })) } }
  const { requests } = setup(run, async () => json({ workers: [settled, live, gone], capacity: { outstanding: 2, limit: 32, created: 3, creationLimit: 1024 } }))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  const button = await within(panel).findByRole('button', { name: `Clean up worker ${workerId.slice(0, 8)}` })
  expect(within(panel).getAllByRole('button', { name: /^Clean up worker/ })).toHaveLength(1)
  expect(button.className).toContain('min-h-11')
  fireEvent.click(button)
  await waitFor(() => expect(requests).toContain(`/api/v1/p/sample/runs/${workerId}/worker-destroy`))
})
it('reports an incomplete cleanup and leaves Clean up available for a retry (#816)', async () => {
  const settled: WorkerInspection = { ...worker, status: 'done', destroy: undefined }
  setup(root, async () => json({ workers: [settled], capacity: { outstanding: 1, limit: 32, created: 1, creationLimit: 1024 } }),
    async () => json({ workerId, state: 'incomplete', remaining: ['branch'], error: 'Branch is checked out' }, 409))
  const panel = await screen.findByRole('region', { name: 'Task relationships' })
  fireEvent.click(await within(panel).findByRole('button', { name: `Clean up worker ${workerId.slice(0, 8)}` }))
  expect(await within(panel).findByText(/Cleanup did not finish/)).toBeTruthy()
  expect((within(panel).getByRole('button', { name: `Clean up worker ${workerId.slice(0, 8)}` }) as HTMLButtonElement).disabled).toBe(false)
})
