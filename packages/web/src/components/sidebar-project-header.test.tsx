import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { SidebarProjectHeader } from './sidebar-project-header'
import { resetToasts, Toaster } from './ui/toaster'

const root = '/home/me/code/other-project'
const project = { id: 'other', name: 'Other Project', root, branch: 'feature/other', status: 'ok', source: 'local', addedAt: '', lastOpenedAt: '' }
const finishedAt = '2026-09-20T12:00:00.000Z'
const runs = [
  { id: 'done', status: 'done', finishedAt },
  { id: 'failed', status: 'failed', finishedAt },
  { id: 'read', status: 'done', finishedAt, seenAt: finishedAt },
  { id: 'running', status: 'running' },
  { id: 'cancelled', status: 'cancelled', finishedAt },
  { id: 'archived', status: 'done', finishedAt, archived: true },
  { id: 'scheduled', status: 'failed', finishedAt, autoResumeAt: finishedAt },
  { id: 'worker', status: 'done', finishedAt, delegation: { role: 'worker' } },
]
let requests: { url: string; method: string; body: unknown }[]
let failRead: boolean | string = false
beforeEach(() => {
  requests = []
  failRead = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const id = /runs\/([^/]+)\/read$/.exec(url)?.[1]
    if (id) return new Response(JSON.stringify((failRead === true || failRead === id) ? { error: 'Read failed' } : { ...runs.find((r) => r.id === id), seenAt: new Date().toISOString() }), { status: (failRead === true || failRead === id) ? 500 : 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/open-in')) return new Response(JSON.stringify({ opened: true, path: root }), { headers: { 'content-type': 'application/json' } })
    return new Promise<Response>(() => {})
  }))
})
afterEach(() => { cleanup(); resetToasts(); vi.unstubAllGlobals() })

function mount({ local = true, registry = true, runData = true, active = 'other' } = {}) {
  setApiScope(active)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.health, { bootProject: 'boot', repo: { name: 'Boot', root: '/boot', branch: 'boot-main' }, capabilities: { localHandoff: local } })
  if (registry) client.setQueryData(workspaceQueryKeys.projects, { bootProject: 'boot', projects: [project, { ...project, id: 'boot', name: 'Boot Project', root: '/boot', branch: 'stale-branch' }] })
  if (runData) client.setQueryData(queryKeys.runs.list(), runs)
  client.setQueryData(queryKeys.openTargets, { targets: [{ id: 'vscode', label: 'VS Code', icon: 'vscode' }, { id: 'folder', label: 'Finder', icon: 'folder' }, { id: 'cli:claude', label: 'Claude Code' }] })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/p/${active}/`]}><ProjectScopeProvider projectId={active}><SidebarProjectHeader /><Toaster /></ProjectScopeProvider></MemoryRouter></QueryClientProvider>)
  return client
}
async function menu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Project menu' }), { button: 0, ctrlKey: false })
  return screen.findByRole('menuitem', { name: /Mark all read/ })
}

it('uses the selected project identity and branch, never boot health', () => {
  mount()
  expect(screen.getByText('Other Project')).toBeTruthy()
  expect(screen.getByText('op')).toBeTruthy()
  expect(screen.getByText(/feature\/other/).textContent).toContain('other-project')
  expect(screen.queryByText(/boot-main/)).toBeNull()
})
it('hides paths and host actions remotely, retaining scoped settings', async () => {
  mount({ local: false })
  expect(screen.getByText('feature/other')).toBeTruthy()
  expect(document.body.textContent).not.toContain(root)
  await menu()
  expect(screen.queryByRole('menuitem', { name: 'Copy path' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: /Open in/ })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Project settings' }).getAttribute('href')).toBe('/p/other/settings')
})
it('marks only unread completed tasks through scoped reads and invalidates the rail index', async () => {
  const client = mount()
  client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
  const mark = await menu()
  expect(mark.textContent).toContain('2 unread')
  fireEvent.click(mark)
  await waitFor(() => expect(requests.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual(['/api/v1/p/other/runs/done/read', '/api/v1/p/other/runs/failed/read']))
  await waitFor(() => expect(client.getQueryState(workspaceQueryKeys.runsIndex)?.isInvalidated).toBe(true))
  expect(client.getQueryData<typeof runs>(queryKeys.runs.list())?.slice(0, 2).every((run) => run.seenAt)).toBe(true)
  expect((await menu()).getAttribute('data-disabled')).not.toBeNull()
})
it('reports read failures and leaves failed receipts unread', async () => {
  failRead = true
  const client = mount()
  fireEvent.click(await menu())
  await screen.findByText(/Could not mark/)
  expect(client.getQueryData<typeof runs>(queryKeys.runs.list())?.[0]?.seenAt).toBeUndefined()
})
it('never calls a missing registry the boot project or an unknown run count zero', async () => {
  mount({ registry: false, runData: false })
  expect(screen.getByText('Loading project…')).toBeTruthy()
  expect(screen.queryByText(/boot-main/)).toBeNull()
  const mark = await menu()
  expect(mark.getAttribute('data-disabled')).not.toBeNull()
  expect(mark.textContent).toContain('Loading…')
  expect(mark.textContent).not.toContain('0 unread')
})
it('copies the real root and opens supported project targets in a submenu', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  mount()
  await menu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(root))
  await menu()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /Open in/ }), { key: 'ArrowRight' })
  const editor = await screen.findByRole('menuitem', { name: 'VS Code' })
  expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull()
  fireEvent.click(editor)
  await waitFor(() => expect(requests.find((r) => r.url.endsWith('/open-in'))?.body).toEqual({ target: 'vscode' }))
  expect(requests.find((r) => r.url.endsWith('/open-in'))?.url).toBe('/api/v1/p/other/open-in')
  expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull()
})

it('preserves successful receipts when another task fails and can retry only the unread task', async () => {
  failRead = 'failed'
  const client = mount()
  fireEvent.click(await menu())
  await screen.findByText(/Could not mark 1 task read/)
  const rows = client.getQueryData<typeof runs>(queryKeys.runs.list())!
  expect(rows[0]?.seenAt).toBeTruthy()
  expect(rows[1]?.seenAt).toBeUndefined()
  const retry = await menu()
  expect(retry.textContent).toContain('1 unread')
  failRead = false
  fireEvent.click(retry)
  await waitFor(() => expect(client.getQueryData<typeof runs>(queryKeys.runs.list())?.[1]?.seenAt).toBeTruthy())
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.url)).toEqual([
    '/api/v1/p/other/runs/done/read', '/api/v1/p/other/runs/failed/read', '/api/v1/p/other/runs/failed/read',
  ])
})
it('reports an unavailable clipboard without claiming the path was copied', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
  mount()
  await menu()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
  await screen.findByText(`Could not copy path: ${root}`)
  expect(screen.queryByText('Project folder copied')).toBeNull()
})
it('keeps failed project and task loads visibly unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Offline' }), { status: 503 })))
  mount({ registry: false, runData: false })
  await screen.findByText('Project unavailable')
  const mark = await menu()
  await waitFor(() => expect(mark.textContent).toContain('Unavailable'))
  expect(mark.getAttribute('data-disabled')).not.toBeNull()
  expect(screen.queryByText(/boot-main/)).toBeNull()
})

it('uses live boot health for the boot branch while keeping the registered display name', () => {
  mount({ active: 'boot' })
  expect(screen.getByText('Boot Project')).toBeTruthy()
  expect(screen.getByText('/boot · boot-main')).toBeTruthy()
  expect(screen.queryByText(/stale-branch/)).toBeNull()
})

it('uses URL project runs above the route provider even when the mutable scope is stale', async () => {
  setApiScope('previous')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: { localHandoff: true } })
  client.setQueryData(workspaceQueryKeys.projects, { bootProject: 'boot', projects: [project] })
  client.setQueryData(['previous', 'runs', 'list'], [{ id: 'wrong', status: 'done', finishedAt }])
  client.setQueryData(['other', 'runs', 'list'], runs)
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/p/other/git']}><SidebarProjectHeader /></MemoryRouter></QueryClientProvider>)
  const mark = await menu()
  expect(mark.textContent).toContain('2 unread')
  fireEvent.click(mark)
  await waitFor(() => expect(requests.filter(r => r.method === 'POST').map(r => r.url)).toEqual(['/api/v1/p/other/runs/done/read', '/api/v1/p/other/runs/failed/read']))
  expect(client.getQueryData<{ seenAt?: string }[]>(['previous', 'runs', 'list'])?.[0]?.seenAt).toBeUndefined()
})
