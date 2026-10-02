import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'

const api = vi.hoisted(() => ({
  archiveRun: vi.fn(),
  archiveProjectRun: vi.fn(),
  pinRun: vi.fn(),
  pinProjectRun: vi.fn(),
  archiveFinished: vi.fn(),
  archiveProjectFinished: vi.fn(),
}))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), ...api }))
const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast: toastMock }))

import { archivedToastMessage, undoArchive, useSidebarArchive } from '@/components/sidebar-archive'

const record = (over: Partial<RunRecord> = {}) =>
  ({ id: 'a', title: 'Fix the thing', workflow: 'w', task: 't', status: 'done', createdAt: '2026-01-01T00:00:00Z', tokensUsed: 0, archived: false, steps: [], ...over }) as RunRecord

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({})
  toastMock.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('archivedToastMessage', () => {
  it('names one row, counts a sweep', () => {
    expect(archivedToastMessage({ title: 'X' })).toBe('Archived "X"')
    expect(archivedToastMessage({ count: 1 })).toBe('Archived 1 task')
    expect(archivedToastMessage({ count: 4 })).toBe('Archived 4 tasks')
  })

  it('truncates a long title to 60 characters with an ellipsis', () => {
    const long = 'x'.repeat(100)
    expect(archivedToastMessage({ title: long })).toBe(`Archived "${'x'.repeat(59)}…"`)
    expect(archivedToastMessage({ title: 'y'.repeat(60) })).toBe(`Archived "${'y'.repeat(60)}"`)
  })
})

describe('undoArchive', () => {
  it('unarchives every id, and re-pins a pinned one only after its unarchive resolved', async () => {
    const order: string[] = []
    let releaseB!: () => void
    api.archiveProjectRun.mockImplementation(async (_p: string, id: string) => {
      if (id === 'b') await new Promise<void>((r) => { releaseB = r })
      order.push(`unarchive ${id}`)
      return {}
    })
    api.pinProjectRun.mockImplementation(async (_p: string, id: string) => { order.push(`pin ${id}`); return {} })
    const done = undoArchive('proj', ['a', 'b'], ['b'])
    await vi.waitFor(() => expect(order).toEqual(['unarchive a']))
    expect(api.pinProjectRun).not.toHaveBeenCalled()
    releaseB()
    await done
    expect(order).toEqual(['unarchive a', 'unarchive b', 'pin b'])
    expect(api.archiveProjectRun).toHaveBeenCalledWith('proj', 'a', false)
    expect(api.pinProjectRun).toHaveBeenCalledWith('proj', 'b', true)
  })

  it('lets the other ids finish when one fails, and toasts once with the server message', async () => {
    api.archiveProjectRun.mockImplementation(async (_p: string, id: string) => {
      if (id === 'a') throw new Error('Run a is gone')
      return {}
    })
    await undoArchive('proj', ['a', 'b', 'c'], ['a', 'c'])
    expect(api.archiveProjectRun).toHaveBeenCalledTimes(3)
    // a failed to unarchive, so its pin is not attempted; c is re-pinned.
    expect(api.pinProjectRun).toHaveBeenCalledTimes(1)
    expect(api.pinProjectRun).toHaveBeenCalledWith('proj', 'c', true)
    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock).toHaveBeenCalledWith('Run a is gone', { tone: 'danger' })
  })

  it('without a project id uses the scope-free calls', async () => {
    await undoArchive(undefined, ['a'], ['a'])
    expect(api.archiveRun).toHaveBeenCalledWith('a', false)
    expect(api.pinRun).toHaveBeenCalledWith('a', true)
  })
})

describe('useSidebarArchive', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>

  it('archives one row in its own project and offers Undo bound to that project', async () => {
    const { result, rerender } = renderHook(({ project }: { project: string }) => useSidebarArchive(project, project), { wrapper, initialProps: { project: 'p1' } })
    act(() => result.current.archiveOne(record({ id: 'r1', pinned: true })))
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1))
    expect(api.archiveProjectRun).toHaveBeenCalledWith('p1', 'r1', true)
    expect(toastMock.mock.calls[0]![0]).toBe('Archived "Fix the thing"')
    // The user navigates to another project before pressing Undo (Review Focus 5).
    rerender({ project: 'p2' })
    api.archiveProjectRun.mockClear()
    await act(async () => { toastMock.mock.calls[0]![1].action.onAction() })
    await vi.waitFor(() => expect(api.pinProjectRun).toHaveBeenCalledWith('p1', 'r1', true))
    expect(api.archiveProjectRun).toHaveBeenCalledWith('p1', 'r1', false)
  })

  it('sweeps with the response ids, not the visible rows, and undoes with pinnedIds', async () => {
    api.archiveProjectFinished.mockResolvedValue({ archived: 3, ids: ['x', 'y', 'ghost'], pinnedIds: ['y'] })
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    act(() => result.current.sweep('unpinned'))
    expect(result.current.sweeping).toBe('unpinned')
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1))
    expect(api.archiveProjectFinished).toHaveBeenCalledWith('p1', 'unpinned')
    expect(toastMock.mock.calls[0]![0]).toBe('Archived 3 tasks')
    await vi.waitFor(() => expect(result.current.sweeping).toBeNull())
    await act(async () => { toastMock.mock.calls[0]![1].action.onAction() })
    await vi.waitFor(() => expect(api.pinProjectRun).toHaveBeenCalledWith('p1', 'y', true))
    expect(api.archiveProjectRun).toHaveBeenCalledWith('p1', 'ghost', false)
    expect(api.pinProjectRun).toHaveBeenCalledTimes(1)
  })

  it('toasts nothing when a sweep took nothing', async () => {
    api.archiveProjectFinished.mockResolvedValue({ archived: 0, ids: [], pinnedIds: [] })
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    act(() => result.current.sweep('pinned'))
    await vi.waitFor(() => expect(result.current.sweeping).toBeNull())
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('surfaces a failed archive as a danger toast', async () => {
    api.archiveProjectRun.mockRejectedValue(new Error('Nope'))
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    act(() => result.current.archiveOne(record()))
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledWith('Nope', { tone: 'danger' }))
  })
})

describe('useSidebarArchive guards and focus (#780)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>

  it('ignores a repeat click on a row whose archive is still in flight', async () => {
    let resolve!: (value: unknown) => void
    api.archiveProjectRun.mockImplementation(() => new Promise((r) => { resolve = r }))
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    act(() => { result.current.archiveOne(record({ id: 'r1' })); result.current.archiveOne(record({ id: 'r1' })) })
    await act(async () => resolve({}))
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1))
    expect(api.archiveProjectRun).toHaveBeenCalledTimes(1)
    // Settled: the same row may be archived again (after an Undo, say).
    api.archiveProjectRun.mockResolvedValue({})
    act(() => result.current.archiveOne(record({ id: 'r1' })))
    await vi.waitFor(() => expect(api.archiveProjectRun).toHaveBeenCalledTimes(2))
  })

  function mountBucket(ids: string[]) {
    const list = document.createElement('div')
    list.innerHTML = `<div data-slot="quick-list-bucket">${ids
      .map((id) => `<div data-slot="task-row" data-run-id="${id}"><a href="#${id}">${id}</a><button data-action="archive-run">x</button></div>`)
      .join('')}</div>`
    document.body.append(list)
    const row = (id: string) => list.querySelector<HTMLElement>(`[data-run-id="${id}"]`)!
    return { list, row, link: (id: string) => row(id).querySelector('a')!, button: (id: string) => row(id).querySelector('button')! }
  }

  async function archiveAndRemove(ui: ReturnType<typeof mountBucket>, id: string) {
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    ui.button(id).focus()
    act(() => result.current.archiveOne(record({ id })))
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalled())
    // The SSE removes the row a moment after the request answers.
    act(() => ui.row(id).remove())
  }

  afterEach(() => { document.body.innerHTML = '' })

  it('moves focus to the next row, else the previous one, after the focused row leaves', async () => {
    const ui = mountBucket(['a', 'b', 'c'])
    await archiveAndRemove(ui, 'b')
    await vi.waitFor(() => expect(document.activeElement).toBe(ui.link('c')))
    toastMock.mockClear()
    ui.button('c').focus()
    await archiveAndRemove(ui, 'c')
    await vi.waitFor(() => expect(document.activeElement).toBe(ui.link('a')))
  })

  it('falls back to the list container when the group emptied', async () => {
    const ui = mountBucket(['only'])
    await archiveAndRemove(ui, 'only')
    await vi.waitFor(() => expect(document.activeElement).toBe(ui.list))
  })

  it('leaves focus alone when the user already moved it', async () => {
    const ui = mountBucket(['a', 'b'])
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    ui.button('a').focus()
    act(() => result.current.archiveOne(record({ id: 'a' })))
    elsewhere.focus()
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalled())
    act(() => ui.row('a').remove())
    await new Promise((r) => setTimeout(r, 20))
    expect(document.activeElement).toBe(elsewhere)
  })

  it('moves focus out of a swept group once its button is gone', async () => {
    api.archiveProjectFinished.mockResolvedValue({ archived: 1, ids: ['a'], pinnedIds: [] })
    const host = document.createElement('div')
    host.innerHTML = `<div data-slot="quick-list-bucket" data-bucket="Finished"><button data-action="archive-group" data-scope="unpinned">Archive all</button><div data-slot="task-row" data-run-id="a"><a href="#a">a</a></div></div><div data-slot="quick-list-bucket" data-bucket="Archived"><div data-slot="task-row" data-run-id="z"><a href="#z">z</a></div></div>`
    document.body.append(host)
    const button = host.querySelector<HTMLElement>('[data-action="archive-group"]')!
    const { result } = renderHook(() => useSidebarArchive('p1', 'p1'), { wrapper })
    button.focus()
    act(() => result.current.sweep('unpinned'))
    await vi.waitFor(() => expect(toastMock).toHaveBeenCalled())
    act(() => host.querySelector('[data-bucket="Finished"]')!.remove())
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('a[href="#z"]')))
  })
})
