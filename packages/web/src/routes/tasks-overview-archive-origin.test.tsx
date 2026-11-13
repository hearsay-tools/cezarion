import { NOW, ago, run, renderOverview, tableRow } from './tasks-overview.testkit'
import { RUN_STATUS } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { TasksOverview } from '@/routes/tasks-overview'

afterEach(cleanup)

describe('archived pages past the window', () => {
  const archivedRuns = (count: number) => Array.from({ length: count }, (_, i) =>
    run({ id: `win-${i}`, archived: true, createdAt: ago(1_000_000 + i * 1000) }))
  const archivedTab = () => document.querySelector('[data-slot="overview-tab"][data-view="archived"]') as HTMLElement

  // Two renders of a full 200-row window: slow on a loaded suite, not a wait on anything.
  it('says 200+ while the window is full and the total is unknown, then the total', { timeout: 30_000 }, () => {
    const { rerender } = renderOverview({ view: 'archived', runs: archivedRuns(200) })
    expect(archivedTab().textContent).toBe('Archived · 200+')
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <TasksOverview runs={archivedRuns(200)} view="archived" now={NOW} archivedTotal={250}
            onViewChange={vi.fn()} onArchiveFinished={vi.fn()} onMarkAllRead={vi.fn()} onRename={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(archivedTab().textContent).toBe('Archived · 250')
  })

  it('keeps an origin count open-ended while the plain archive has older pages, whatever a search says (hearsay-tools/cezarion#1616)', { timeout: 30_000 }, () => {
    const window = archivedRuns(200).map((entry, i) => (i === 0 ? { ...entry, automationId: 'nightly' } : entry))
    const searched = { runs: [], query: 'needle', hasMore: false, loading: false, onLoadMore: vi.fn() }
    const { rerender } = renderOverview({ view: 'archived', runs: window, origin: 'automations', onOriginChange: vi.fn(), archivedPages: { ...searched, plainHasMore: true } })
    expect(archivedTab().textContent).toBe('Archived · 1+')
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <TasksOverview runs={window} view="archived" now={NOW} origin="automations" onOriginChange={vi.fn()}
            archivedPages={{ ...searched, plainHasMore: false }}
            onViewChange={vi.fn()} onArchiveFinished={vi.fn()} onMarkAllRead={vi.fn()} onRename={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(archivedTab().textContent).toBe('Archived · 1')
  })

  it('counts exactly below the window and offers no older page', () => {
    renderOverview({ view: 'archived', runs: archivedRuns(3) })
    expect(archivedTab().textContent).toBe('Archived · 3')
    expect(screen.queryByRole('button', { name: 'Show older archived' })).toBeNull()
  })

  it('shows older pages under the window, once each, and asks for the next one', () => {
    const onLoadMore = vi.fn()
    const window = archivedRuns(2)
    renderOverview({
      view: 'archived',
      runs: window,
      archivedPages: {
        runs: [{ ...window[1]! }, run({ id: 'older', archived: true, createdAt: ago(9_000_000) })],
        query: '',
        hasMore: true,
        loading: false,
        onLoadMore,
      },
    })
    expect(tableRow('older')).not.toBeNull()
    expect(document.querySelectorAll(`[data-slot="task-table-row"][data-run-id="${window[1]!.id}"]`)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show older archived' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('says when an older page failed, and retries it', () => {
    const onLoadMore = vi.fn()
    renderOverview({
      view: 'archived',
      runs: archivedRuns(2),
      archivedPages: { runs: [], query: '', hasMore: true, loading: false, onLoadMore, failed: true },
    })
    expect(screen.getByRole('alert').textContent).toContain('Could not load older archived tasks.')
    expect(screen.queryByRole('button', { name: 'Show older archived' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('keeps a window row the server matched by reference number, as it keeps an older one', () => {
    const recent = run({ id: 'recent-864', title: 'Bound the lists', archived: true, issueNumber: 864 })
    const older = run({ id: 'older-864', title: 'Older work', archived: true, issueNumber: 864, createdAt: ago(9_000_000) })
    renderOverview({
      view: 'archived',
      runs: [recent, run({ id: 'unrelated', archived: true })],
      onArchivedSearch: vi.fn(),
      archivedPages: { runs: [recent, older], query: '#864', hasMore: false, loading: false, onLoadMore: vi.fn() },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: '#864' } })
    expect(tableRow('recent-864')).not.toBeNull()
    expect(tableRow('older-864')).not.toBeNull()
    expect(tableRow('unrelated')).toBeNull()
  })

  it('does not let stale unfiltered pages widen a search', () => {
    renderOverview({
      view: 'archived',
      runs: [run({ id: 'unrelated', archived: true })],
      onArchivedSearch: vi.fn(),
      archivedPages: { runs: [run({ id: 'unrelated', archived: true })], query: '', hasMore: false, loading: false, onLoadMore: vi.fn() },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'needle' } })
    expect(tableRow('unrelated')).toBeNull()
  })

  it('drops a paged row the live list has since unarchived', () => {
    const live = run({ id: 'came-back', archived: false })
    renderOverview({
      view: 'archived',
      runs: [live],
      archivedPages: { runs: [{ ...live, archived: true }], query: '', hasMore: false, loading: false, onLoadMore: vi.fn() },
    })
    expect(tableRow('came-back')).toBeNull()
  })

  it('passes the search to the server and shows its hits even when the local filter would not', () => {
    const onArchivedSearch = vi.fn()
    renderOverview({
      view: 'archived',
      runs: archivedRuns(2),
      onArchivedSearch,
      archivedPages: {
        runs: [run({ id: 'by-issue', title: 'Bound the lists', archived: true, issueNumber: 864, createdAt: ago(9_000_000) })],
        query: '#864',
        hasMore: false,
        loading: false,
        onLoadMore: vi.fn(),
      },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: '#864' } })
    expect(onArchivedSearch).toHaveBeenLastCalledWith('#864')
    expect(tableRow('by-issue')).not.toBeNull()
  })
})

describe('TasksOverview — status groups and origin (hearsay-tools/cezarion#1616)', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  const automated = (over: Partial<RunRecord> = {}) =>
    // The summary's `automationId`, as `toRunSummary` derives it from `automationTrigger`.
    ({ ...run(over), automationId: 'nightly' })
  const heading = (label: string) => document.querySelector(`[data-slot="task-status-group"][data-bucket="${label}"]`) as HTMLElement
  const rowIds = () => [...document.querySelectorAll('[data-slot="task-summary-row"]')].map((row) => row.querySelector('a')?.getAttribute('href'))

  it('filters by recorded origin with counts, and scopes the bulk actions to it', () => {
    const onArchiveFinished = vi.fn()
    const onOriginChange = vi.fn()
    const runs = [
      run({ id: 'direct', autonomous: true }),
      automated({ id: 'auto-done' }),
      automated({ id: 'auto-running', status: RUN_STATUS.running }),
    ]
    const { rerender } = renderOverview({ runs, onArchiveFinished, origin: 'automations', onOriginChange }, false)
    const chips = within(document.querySelector('[data-slot="origin-filter"]') as HTMLElement)
    expect(chips.getByRole('button', { name: 'All 3' }).getAttribute('aria-pressed')).toBe('false')
    expect(chips.getByRole('button', { name: 'Direct tasks 1' })).toBeTruthy()
    expect(chips.getByRole('button', { name: 'Automations 2' }).getAttribute('aria-pressed')).toBe('true')
    expect(rowIds()).toEqual(['/tasks/auto-done', '/tasks/auto-running'])
    // The sweep names the origin and how many it will archive.
    fireEvent.click(screen.getByRole('button', { name: 'Archive finished 1' }))
    expect(onArchiveFinished).toHaveBeenCalledWith(true)
    fireEvent.click(chips.getByRole('button', { name: 'Direct tasks 1' }))
    expect(onOriginChange).toHaveBeenCalledWith('direct')
    void rerender
  })

  it('names the search in the plain count caption', () => {
    const caption = () => document.querySelector('[data-slot="tasks-result-count"]') as HTMLElement
    renderOverview({ runs: [run({ title: 'Needle' })] }, false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'Needle' } })
    expect(caption().textContent).toBe('1 task matching “Needle”')
  })

  it('follows a search the URL changes from outside, and keeps text being typed (hearsay-tools/cezarion#1616)', () => {
    const props = { runs: [run({ title: 'Needle' }), run({ id: 'r2', title: 'Haystack' })], onQueryChange: vi.fn() }
    const box = () => screen.getByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement
    const view = (query: string) => (
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <TasksOverview {...props} urlQuery={query} view="active" now={NOW}
            onViewChange={vi.fn()} onArchiveFinished={vi.fn()} onMarkAllRead={vi.fn()} onRename={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    // One tree for every render, so React keeps the page mounted and only the URL's text changes.
    const { rerender } = render(view('Needle'))
    expect(box().value).toBe('Needle')
    rerender(view('Haystack'))
    expect(box().value).toBe('Haystack')
    fireEvent.change(box(), { target: { value: 'Hay ' } })
    // The page's own write lands in the URL trimmed; that must not rewrite the box.
    rerender(view('Hay'))
    expect(box().value).toBe('Hay ')
  })

  it('keeps a cleared search when the URL renders the earlier write late (hearsay-tools/cezarion#1710)', () => {
    // The page reports `Needle` as written to the URL; the clear is still in its debounce.
    const onQueryChange = vi.fn((query: string, written: (query: string) => void) => { if (query === 'Needle') written(query) })
    const props = { runs: [run({ title: 'Needle' }), run({ id: 'r2', title: 'Haystack' })], onQueryChange }
    const box = () => screen.getByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement
    const view = (query: string) => (
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <TasksOverview {...props} urlQuery={query} view="active" now={NOW}
            onViewChange={vi.fn()} onArchiveFinished={vi.fn()} onMarkAllRead={vi.fn()} onRename={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(view(''))
    fireEvent.change(box(), { target: { value: 'Needle' } })
    fireEvent.change(box(), { target: { value: '' } })
    // The router renders the page's `q=Needle` write in a transition, after the clear.
    rerender(view('Needle'))
    expect(box().value).toBe('')
    rerender(view(''))
    expect(box().value).toBe('')
    // A change from outside still wins over the box.
    rerender(view('Haystack'))
    expect(box().value).toBe('Haystack')
  })

  it('scopes Mark all read to the origin', () => {
    const onMarkAllRead = vi.fn()
    renderOverview({ runs: [run({ finishedAt: ago(0) }), automated({ finishedAt: ago(0) })], onMarkAllRead, origin: 'direct' }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read 1' }))
    expect(onMarkAllRead).toHaveBeenCalledWith(false)
  })

  it('heads each group with its name and count, and marks Finished on a failure', () => {
    renderOverview({ runs: [run({ status: RUN_STATUS.review }), run(), run({ status: RUN_STATUS.failed }), run({ status: RUN_STATUS.running })] }, false)
    expect([...document.querySelectorAll('[data-slot="task-status-group"]')].map((group) => group.getAttribute('data-bucket')))
      .toEqual(['Needs you', 'Finished', 'Working'])
    expect(within(heading('Finished')).getByRole('button', { name: /Finished 2/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(heading('Finished')).getByRole('img', { name: 'contains failed tasks' })).toBeTruthy()
  })

  it('shows one Archived group for history', () => {
    renderOverview({ view: 'archived', runs: [run({ archived: true, status: RUN_STATUS.failed }), run({ archived: true })] }, false)
    expect([...document.querySelectorAll('[data-slot="task-status-group"]')].map((group) => group.getAttribute('data-bucket'))).toEqual(['Archived'])
  })

  it('folds a group, keeps its heading, reveals matches during a search and restores the fold after', () => {
    renderOverview({ runs: [run({ id: 'a', title: 'Alpha report' }), run({ id: 'b', title: 'Beta report' })] }, false)
    const toggle = within(heading('Finished')).getByRole('button', { name: /Finished 2/ })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rowIds()).toEqual([])
    expect(heading('Finished').textContent).toContain('2')

    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'Alpha' } })
    expect(rowIds()).toEqual(['/tasks/a'])
    expect(heading('Finished').getAttribute('data-folded')).toBe('true')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: '' } })
    expect(rowIds()).toEqual([])

    cleanup()
    renderOverview({ runs: [run({ id: 'c' })] }, false)
    expect(within(heading('Finished')).getByRole('button', { name: /Finished 1/ }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Expand groups' }))
    expect(rowIds()).toEqual(['/tasks/c'])
  })

  it('keeps Active and Archived folds apart', () => {
    renderOverview({ runs: [run()] }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse groups' }))
    cleanup()
    renderOverview({ view: 'archived', runs: [run({ id: 'old', archived: true })] }, false)
    expect(rowIds()).toEqual(['/tasks/old'])
  })

  it('names the origin under each title, falling back to the recorded automation id', () => {
    renderOverview({ runs: [run({ id: 'mine' }), automated({ id: 'named' })], automationName: () => undefined }, false)
    const origins = [...document.querySelectorAll('[data-slot="task-summary-row"] [data-slot="task-origin"]')].map((line) => line.textContent)
    expect(origins).toContain('Direct task')
    expect(origins).toContain('nightly')
    cleanup()
    renderOverview({ runs: [automated()], automationName: (id) => (id === 'nightly' ? 'Nightly health' : undefined) }, false)
    expect(document.querySelector('[data-slot="task-origin"]')?.textContent).toBe('Nightly health')
  })

  it('finds a task by its automation name', () => {
    renderOverview({ runs: [run({ id: 'mine' }), automated({ id: 'auto' })], automationName: () => 'Nightly health' }, false)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'nightly' } })
    expect(rowIds()).toEqual(['/tasks/auto'])
  })

  it('previews the latest progress inline with Open task, and says when it cannot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Handoff\n\n## Progress log\n\n- 10:02 — tests pass\n', { status: 200 })))
    renderOverview({ runs: [run({ id: 'p', title: 'Preview me', status: RUN_STATUS.failed, error: 'exit 1' })] }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Show resources for Preview me' }))
    const preview = document.querySelector('[data-slot="task-preview"]') as HTMLElement
    expect(within(preview).getByRole('status').textContent).toBe('Loading latest progress…')
    expect(await within(preview).findByText('10:02 — tests pass')).toBeTruthy()
    expect(within(preview).getByText('exit 1')).toBeTruthy()
    expect(within(preview).getByRole('link', { name: 'Open task: Preview me' }).getAttribute('href')).toBe('/tasks/p')

    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    renderOverview({ runs: [run({ id: 'q', title: 'No journal' })] }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Show resources for No journal' }))
    expect(await screen.findByText('Latest progress is unavailable.')).toBeTruthy()
  })

  it('offers a way back when an origin leaves nothing to show', () => {
    const onOriginChange = vi.fn()
    renderOverview({ runs: [run()], origin: 'automations', onOriginChange }, false)
    fireEvent.click(screen.getByRole('button', { name: 'Show all tasks' }))
    expect(onOriginChange).toHaveBeenCalledWith('all')
  })
})
