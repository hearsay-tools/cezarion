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
