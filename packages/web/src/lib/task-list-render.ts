import { isColumnExpanded, type NormalizedExpandedColumns, type TaskColumnDefinition } from './task-columns'

/** Per status group. Small lists retain native find-in-page and normal flow (ADR 0034). */
export const TASK_LIST_VIRTUALIZE_THRESHOLD = 100
export function virtualizeTaskList(count: number, override: string | null): boolean {
  if (override === 'flat') return false
  return override === 'virtual' || count >= TASK_LIST_VIRTUALIZE_THRESHOLD
}

/** Keep keyboard neighbours mounted so Tab can cross the viewport boundary. */
export function taskListKeepMounted(keys: readonly string[], focused: string | null): number[] {
  const index = focused === null ? -1 : keys.indexOf(focused)
  return index < 0 ? [] : [index - 1, index, index + 1].filter((item) => item >= 0 && item < keys.length)
}


/** Match the resource table's readable column widths while giving spare space to the title. */
export function taskResourceGrid(columns: readonly TaskColumnDefinition[], expanded: NormalizedExpandedColumns) {
  const widths = columns.map((column) => {
    if (!isColumnExpanded(column.id, expanded)) return 42
    if (column.id === 'workflow' || column.id === 'memory') return 120
    return Number.parseFloat(column.width ?? '100')
  })
  return {
    '--task-columns': columns.map((column, index) => column.id === 'task' ? `minmax(${widths[index]}px, 1fr)` : `${widths[index]}px`).join(' '),
    minInlineSize: Math.max(1240, widths.reduce((sum, width) => sum + width, 0)),
  }
}
