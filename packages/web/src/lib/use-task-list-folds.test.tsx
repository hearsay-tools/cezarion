import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { SIDEBAR_SECTIONS_STORAGE_KEY } from '@/lib/sidebar-collapse'
import { TASK_LIST_FOLDS_STORAGE_KEY, useTaskListFolds } from '@/lib/use-task-list-folds'

describe('useTaskListFolds (hearsay-tools/cezarion#1616)', () => {
  beforeEach(() => localStorage.clear())

  it('starts open, saves a fold per scope and view, and leaves the sidebar alone', () => {
    const active = renderHook(() => useTaskListFolds('project:p1', 'active'))
    expect(active.result.current.isCollapsed('Finished')).toBe(false)
    act(() => active.result.current.toggle('Finished'))
    expect(active.result.current.isCollapsed('Finished')).toBe(true)
    expect(JSON.parse(localStorage.getItem(TASK_LIST_FOLDS_STORAGE_KEY)!)).toEqual({ [JSON.stringify(['project:p1', 'active', 'Finished'])]: true })
    expect(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY)).toBeNull()

    expect(renderHook(() => useTaskListFolds('project:p1', 'archived')).result.current.isCollapsed('Finished')).toBe(false)
    expect(renderHook(() => useTaskListFolds('global', 'active')).result.current.isCollapsed('Finished')).toBe(false)
    expect(renderHook(() => useTaskListFolds('project:p1', 'active')).result.current.isCollapsed('Finished')).toBe(true)
  })

  it('shows a revealed group without touching its saved fold', () => {
    const folds = renderHook(({ revealed }) => useTaskListFolds('global', 'active', revealed), { initialProps: { revealed: new Set<'Working'>() } })
    act(() => folds.result.current.toggle('Working'))
    folds.rerender({ revealed: new Set(['Working'] as const) })
    expect(folds.result.current.isCollapsed('Working')).toBe(false)
    expect(folds.result.current.isFolded('Working')).toBe(true)
    folds.rerender({ revealed: new Set() })
    expect(folds.result.current.isCollapsed('Working')).toBe(true)
  })

  it('expands and collapses every named group at once', () => {
    const folds = renderHook(() => useTaskListFolds('global', 'active'))
    act(() => folds.result.current.setAll(['Needs you', 'Working'], true))
    expect(folds.result.current.isCollapsed('Needs you')).toBe(true)
    expect(folds.result.current.isCollapsed('Working')).toBe(true)
    expect(folds.result.current.isCollapsed('Finished')).toBe(false)
    act(() => folds.result.current.setAll(['Needs you', 'Working'], false))
    expect(folds.result.current.isCollapsed('Needs you')).toBe(false)
  })

  it('keeps working when storage is unreadable', () => {
    localStorage.setItem(TASK_LIST_FOLDS_STORAGE_KEY, 'not json')
    const folds = renderHook(() => useTaskListFolds('global', 'active'))
    expect(folds.result.current.isCollapsed('Finished')).toBe(false)
  })
})
