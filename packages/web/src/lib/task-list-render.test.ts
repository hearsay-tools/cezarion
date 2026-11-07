import { TASK_COLUMNS } from './task-columns'
import { describe, expect, it } from 'vitest'
import { taskListKeepMounted, taskResourceGrid, virtualizeTaskList } from './task-list-render'

describe('task list render policy', () => {
  it('retains find-in-page below the per-group threshold and bounds large groups', () => {
    expect(virtualizeTaskList(99, null)).toBe(false)
    expect(virtualizeTaskList(100, null)).toBe(true)
    expect(virtualizeTaskList(1000, 'flat')).toBe(false)
    expect(virtualizeTaskList(3, 'virtual')).toBe(true)
    expect(virtualizeTaskList(3, 'unknown')).toBe(false)
  })
  it('keeps focus and both keyboard neighbours without out-of-range indexes', () => {
    expect(taskListKeepMounted(['a', 'b', 'c'], 'b')).toEqual([0, 1, 2])
    expect(taskListKeepMounted(['a', 'b', 'c'], 'a')).toEqual([0, 1])
    expect(taskListKeepMounted(['a', 'b', 'c'], 'c')).toEqual([1, 2])
    expect(taskListKeepMounted(['a'], 'removed')).toEqual([])
    expect(taskListKeepMounted([], null)).toEqual([])
  })
})

it('sizes the grid to contain every column and lets the task track receive spare width', () => {
  const expanded = taskResourceGrid(TASK_COLUMNS, {})
  expect(expanded['--task-columns']).toContain('minmax(320px, 1fr)')
  const widths = expanded['--task-columns'].replace('minmax(320px, 1fr)', '320px').split(' ').map(Number.parseFloat)
  expect(expanded.minInlineSize).toBeGreaterThanOrEqual(widths.reduce((sum, width) => sum + width, 0))
  const folded = taskResourceGrid(TASK_COLUMNS, { workflow: false })
  expect(folded['--task-columns']).toContain('42px')
  expect(folded.minInlineSize).toBeLessThanOrEqual(expanded.minInlineSize)
})
