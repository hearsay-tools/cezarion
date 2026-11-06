import { ago, run, tableRow as detailedTableRow } from './tasks-overview.testkit'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { createPath, MemoryRouter, NavigationType, Router, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { ListViewProvider } from '@/components/list-view'
import { TaskQuickListContainer } from '@/components/task-quick-list'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { TasksOverviewRoute } from '@/routes/tasks-overview'

afterEach(cleanup)

// Route checks preserve row inclusion in the selected representation.
const tableRow = (id: string) => detailedTableRow(id) ?? document.querySelector(`[data-slot="task-summary-row"][data-run-id="${id}"]`)

describe('TasksOverviewRoute — wired to the app', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    resetToasts()
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  function renderApp(runs: RunSummary[]) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input).replace('?archived=recent', '')
      if (url === '/api/v1/run-summaries') return new Response(JSON.stringify(runs), { status: 200 })
      if (url === '/api/v1/runs/archive-finished')
        return new Response(JSON.stringify({ archived: 1 }), { status: 200 })
      return new Response('[]', { status: 200 })
    })
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ListViewProvider>
            {/* Sidebar and overview together: they must keep independent Active/Archived state. */}
            <TaskQuickListContainer />
            <TasksOverviewRoute />
            <Toaster />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const sidebarTab = (view: string) =>
    document.querySelector(`[data-slot="view-tab"][data-view="${view}"]`) as HTMLElement
  const overviewTab = (view: string) =>
    document.querySelector(`[data-slot="overview-tab"][data-view="${view}"]`) as HTMLElement
  const sidebarRow = (id: string) => document.querySelector(`[data-slot="task-row"][data-run-id="${id}"]`)

  it('follows a link to a search that was typed and erased before the page wrote it (hearsay-tools/cezarion#1710)', async () => {
    let navigate!: ReturnType<typeof useNavigate>
    function Navigator() { navigate = useNavigate(); return null }
    fetchMock.mockImplementation(async () => json([run({ title: 'Needle' }), run({ id: 'r2', title: 'Haystack' })]))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter><ListViewProvider><Navigator /><TasksOverviewRoute /></ListViewProvider></MemoryRouter>
      </QueryClientProvider>,
    )
    const box = await screen.findByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement
    fireEvent.change(box, { target: { value: 'Needle' } })
    fireEvent.change(box, { target: { value: '' } })
    act(() => { void navigate({ search: '?q=Needle' }) })
    await waitFor(() => expect(box.value).toBe('Needle'))
  })

  it('drops a search still waiting for its debounce when the sidebar opens one section', async () => {
    let navigate!: ReturnType<typeof useNavigate>
    let search = ''
    function Navigator() { navigate = useNavigate(); search = useLocation().search; return null }
    fetchMock.mockImplementation(async () => json([run({ id: 'f1', title: 'Alpha' }), run({ id: 'f2', title: 'Beta' })]))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter><ListViewProvider><Navigator /><TasksOverviewRoute /></ListViewProvider></MemoryRouter>
      </QueryClientProvider>,
    )
    const box = await screen.findByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement
    vi.useFakeTimers()
    try {
      fireEvent.change(box, { target: { value: 'matches nothing' } })
      // The sidebar's "2 of 2" link, followed before the 250 ms search debounce fires.
      act(() => { void navigate('/?origin=direct&section=finished') })
      act(() => vi.advanceTimersByTime(250))
      expect(search).toBe('?origin=direct')
      expect(box.value).toBe('')
      expect(screen.queryAllByText('Alpha').length).toBeGreaterThan(0)
      expect(screen.queryAllByText('Beta').length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
      // The link saved folds for this list; later tests start with every group open.
      localStorage.clear()
    }
  })

  it('keeps a cleared search when the real debounced writer lands late (hearsay-tools/cezarion#2081)', async () => {
    // Hold the router commit, not the writer callback: the input must recognise the real
    // writer's echo after another keystroke. CI run 40763004045 attempt 1, job 123079799508
    // captured the archived view with q=done restored after Backspace.
    fetchMock.mockImplementation(async () => json([]))
    const navigator = { createHref: createPath, go: vi.fn(), push: vi.fn(), replace: vi.fn() }
    type Location = ComponentProps<typeof Router>['location']
    const client = createQueryClient()
    const tree = (location: Location, state?: unknown) => (
      <QueryClientProvider client={client}>
        <Router location={typeof location === 'string' ? location : { ...location, state }}
          navigator={navigator} navigationType={NavigationType.Replace}>
          <ListViewProvider><TasksOverviewRoute /></ListViewProvider>
        </Router>
      </QueryClientProvider>
    )
    const { rerender } = render(tree('/?archived=1'))
    const box = await screen.findByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement
    vi.useFakeTimers()
    try {
      fireEvent.change(box, { target: { value: 'Needle' } })
      act(() => vi.advanceTimersByTime(250))
      expect(navigator.replace).toHaveBeenCalledTimes(1)
      const [destination, state] = navigator.replace.mock.calls[0]!
      expect(destination.search).toBe('?archived=1&q=Needle')
      fireEvent.change(box, { target: { value: '' } })
      rerender(tree({ ...destination, key: 'late-query' }, state))
      expect(box.value).toBe('')
      expect(overviewTab('archived').getAttribute('aria-pressed')).toBe('true')
      act(() => vi.advanceTimersByTime(250))
      expect(navigator.replace).toHaveBeenCalledTimes(2)
      expect(navigator.replace.mock.calls[1]![0].search).toBe('?archived=1')
      // An external link still wins over the cleared input.
      rerender(tree({ pathname: '/', search: '?archived=1&q=Haystack', key: 'external' }))
      expect(box.value).toBe('Haystack')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the archived pages when the window is full, and pages older ones in (#864)', { timeout: 30_000 }, async () => {
    const window = Array.from({ length: 200 }, (_, i) => run({ id: `win-${i}`, archived: true, createdAt: ago(1_000_000 + i * 1000) }))
    const asked: string[] = []
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      asked.push(url)
      if (url === '/api/v1/run-summaries?archived=recent') return json(window)
      if (url === '/api/v1/run-summaries/archived?limit=200') return json({ runs: window, nextCursor: 'c1', total: 201 })
      if (url === '/api/v1/run-summaries/archived?before=c1&limit=200') {
        return json({ runs: [run({ id: 'oldest', archived: true, createdAt: ago(9_000_000) })], nextCursor: null, total: 201 })
      }
      return json([])
    })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter><ListViewProvider><TasksOverviewRoute /></ListViewProvider></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(overviewTab('archived').textContent).toBe('Archived · 200+'))
    // The Active tab never asks for archived pages.
    expect(asked.some((url) => url.includes('/run-summaries/archived'))).toBe(false)
    fireEvent.click(overviewTab('archived'))
    await waitFor(() => expect(overviewTab('archived').textContent).toBe('Archived · 201'))
    fireEvent.click(await screen.findByRole('button', { name: 'Show older archived' }))
    await waitFor(() => expect(tableRow('oldest')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Show older archived' })).toBeNull()
  })

  it('names an automation whose task is only on an older archived page (hearsay-tools/cezarion#1616)', { timeout: 30_000 }, async () => {
    const window = Array.from({ length: 200 }, (_, i) => run({ id: `win-${i}`, archived: true, createdAt: ago(1_000_000 + i * 1000) }))
    const older = { ...run({ id: 'older-auto', archived: true, createdAt: ago(9_000_000) }), automationId: 'nightly' }
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/api/v1/health') return json({ capabilities: { automations: true } })
      if (url === '/api/v1/run-summaries?archived=recent') return json(window)
      if (url === '/api/v1/run-summaries/archived?limit=200') return json({ runs: window, nextCursor: 'c1', total: 201 })
      if (url === '/api/v1/run-summaries/archived?before=c1&limit=200') return json({ runs: [older], nextCursor: null, total: 201 })
      if (url.includes('/automations')) {
        return json({ available: true, timeZone: 'UTC', scheduler: { state: 'idle' }, automations: [{ id: 'nightly', name: 'Nightly sweep', counts: {} }] })
      }
      return json([])
    })
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/?archived=1']}><ListViewProvider><TasksOverviewRoute /></ListViewProvider></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(overviewTab('archived').textContent).toBe('Archived · 201'))
    fireEvent.click(await screen.findByRole('button', { name: 'Show older archived' }))
    await waitFor(() => expect(tableRow('older-auto')).not.toBeNull())
    await waitFor(() => expect(tableRow('older-auto')!.textContent).toContain('Nightly sweep'))
  })

  it('keeps a tab switched while the typed search is still on its way to the URL (hearsay-tools/cezarion#1616)', async () => {
    renderApp([run({ id: 'act', title: 'Needle act', status: RUN_STATUS.running }), run({ id: 'arc', title: 'Needle arc', status: RUN_STATUS.done, archived: true })])
    await waitFor(() => expect(tableRow('act')).not.toBeNull())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'Needle' } })
    fireEvent.click(overviewTab('archived'))
    expect(overviewTab('archived').getAttribute('aria-pressed')).toBe('true')
    // The search reaches the URL after its debounce; that write must not restore the old view,
    // not even for one render.
    const seen: (string | null)[] = []
    const observer = new MutationObserver(() => seen.push(overviewTab('archived').getAttribute('aria-pressed')))
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] })
    await act(() => new Promise((resolve) => setTimeout(resolve, 800))) // bound: several 250 ms search debounces
    observer.disconnect()
    expect(seen.filter((pressed) => pressed !== 'true')).toEqual([])
    expect(overviewTab('archived').getAttribute('aria-pressed')).toBe('true')
    expect(tableRow('arc')).not.toBeNull()
  })

  it('keeps the sidebar Active/Automations tabs and the table Active/Archived tabs independent (#1332)', async () => {
    renderApp([
      run({ id: 'act', status: RUN_STATUS.running }),
      run({ id: 'arc', status: RUN_STATUS.done, archived: true }),
      { ...run({ id: 'auto', status: RUN_STATUS.done }), automationId: 'auto-1' },
    ])
    await waitFor(() => expect(tableRow('act')).not.toBeNull())
    expect(sidebarRow('act')).not.toBeNull()
    expect(sidebarRow('auto')).toBeNull()
    // The table's Active is every unarchived task, automation-created ones included.
    expect(tableRow('auto')).not.toBeNull()
    expect(overviewTab('active').getAttribute('aria-pressed')).toBe('true')
    expect(sidebarTab('active').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(overviewTab('archived'))
    expect(overviewTab('archived').getAttribute('aria-pressed')).toBe('true')
    expect(sidebarTab('active').getAttribute('aria-pressed')).toBe('true')
    expect(tableRow('arc')).not.toBeNull()
    expect(tableRow('act')).toBeNull()
    expect(sidebarRow('act')).not.toBeNull()
    expect(sidebarRow('arc')).toBeNull()

    fireEvent.click(sidebarTab('automations'))
    expect(sidebarTab('automations').getAttribute('aria-pressed')).toBe('true')
    expect(overviewTab('archived').getAttribute('aria-pressed')).toBe('true')
    expect(tableRow('arc')).not.toBeNull()
    expect(tableRow('act')).toBeNull()
    expect(sidebarRow('auto')).not.toBeNull()
    expect(sidebarRow('act')).toBeNull()
    expect(sidebarRow('arc')).toBeNull()

    fireEvent.click(sidebarTab('active'))
    expect(sidebarTab('active').getAttribute('aria-pressed')).toBe('true')
    expect(overviewTab('archived').getAttribute('aria-pressed')).toBe('true')
    expect(tableRow('arc')).not.toBeNull()
    expect(sidebarRow('act')).not.toBeNull()
    expect(sidebarRow('auto')).toBeNull()
  })

  it('adopts persisted workspace choices, updates optimistically, and reloads the server answer', async () => {
    let workspaceState = {
      taskTable: {
        expandedColumns: { branch: false },
        futureSibling: 'preserve',
      },
    }
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input).replace('?archived=recent', '')
      if (url === '/api/v1/workspace/ui-state') {
        if (init?.method === 'PUT') {
          workspaceState = { ...workspaceState, ...JSON.parse(String(init.body)) }
        }
        return json(workspaceState)
      }
      if (url === '/api/v1/run-summaries') return json([run({ id: 'persisted', branch: 'feat/persisted' })])
      return json({})
    })

    const first = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ListViewProvider>
            <TasksOverviewRoute />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Columns' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resource columns' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    const restore = await screen.findByRole('button', { name: 'Expand Branch column', pressed: false })
    restore.focus()
    fireEvent.click(restore)
    const fold = await screen.findByRole('button', { name: 'Fold Branch column', pressed: true })
    expect(document.activeElement).toBe(fold)
    const put = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([path, options]) => String(path) === '/api/v1/workspace/ui-state' && options?.method === 'PUT',
      )
      if (!call) throw new Error('workspace PUT missing')
      return call
    })
    expect(JSON.parse(String(put[1]?.body))).toEqual({
      taskTable: {
        expandedColumns: { branch: true },
        futureSibling: 'preserve',
      },
    })
    expect(put[1]?.keepalive).toBe(true)

    first.unmount()
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ListViewProvider>
            <TasksOverviewRoute />
          </ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Columns' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resource columns' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(await screen.findByRole('button', { name: 'Fold Branch column', pressed: true })).not.toBeNull()
  })

  it('posts to /api/v1/runs/archive-finished and refetches the authoritative list', async () => {
    renderApp([run({ id: 'd1', status: RUN_STATUS.done })])
    fireEvent.click(await screen.findByRole('button', { name: /Archive finished/ }))

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([path]) => String(path) === '/api/v1/runs/archive-finished')
      expect(posted?.[1]?.method).toBe('POST')
    })
    // The doctrine: after the mutation, ask the endpoint again rather than trusting the cache.
    await waitFor(() => {
      const listFetches = fetchMock.mock.calls.filter(([path]) => String(path) === '/api/v1/run-summaries?archived=recent')
      expect(listFetches.length).toBeGreaterThan(1)
    })
  })

  it('keeps query and rows on archive failure and exposes a retryable action', async () => {
    renderApp([run({ id: 'failure', title: 'Keep me' })])
    await waitFor(() => expect(tableRow('failure')).not.toBeNull())
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'Keep' } })
    fetchMock.mockImplementation(async input => String(input).replace('?archived=recent', '').endsWith('archive-finished')
      ? json({ error: 'Archive unavailable. Try again.' }, 503)
      : json([]))
    fireEvent.click(screen.getByRole('button', { name: 'Archive finished 1' }))
    expect(await screen.findByText('Archive unavailable. Try again.')).not.toBeNull()
    expect(tableRow('failure')).not.toBeNull()
    expect((screen.getByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement).value).toBe('Keep')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive finished 1' }).hasAttribute('disabled')).toBe(false))
  })

  it('PATCHes a table rename to /api/v1/runs/:id and refetches the authoritative list', async () => {
    renderApp([run({ id: 'rn1', title: 'Old name', status: RUN_STATUS.done })])
    await waitFor(() => expect(tableRow('rn1')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resource columns' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(within(tableRow('rn1') as HTMLElement).getByRole('button', { name: 'Rename task' }))
    const input = within(tableRow('rn1') as HTMLElement).getByLabelText('Task title')
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      const patched = fetchMock.mock.calls.find(([path]) => String(path) === '/api/v1/runs/rn1')
      expect(patched?.[1]?.method).toBe('PATCH')
      expect(JSON.parse(String(patched?.[1]?.body))).toEqual({ title: 'New name' })
    })
    // Same doctrine as archive: the endpoint's answer is the truth — refetch, don't trust.
    await waitFor(() => {
      const listFetches = fetchMock.mock.calls.filter(([path]) => String(path) === '/api/v1/run-summaries?archived=recent')
      expect(listFetches.length).toBeGreaterThan(1)
    })
  })
})
