import {
  ARCHIVED_WINDOW,
  groupRuns,
  isOwnedWorker,
  sidebarActiveRunId,
  sidebarRuns,
  sortRuns,
  type QuickListRow,
  type SidebarView,
} from '@/lib/task-groups'
import type { VoicePosition, VoiceStatus } from '@open-mercato/cezar-api-client/contract/voice'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { voiceStatusMatches } from './status-map'

/**
 * Turn an `open` decision (a status and a position) into the row it points at. Jev only picks the
 * words; the order, the counting and the edge cases are decided here (spec 2026-10-21-voice-mode,
 * § Open by status and position). Pure, like `task-groups.ts`.
 */

export type OpenTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'empty' }
  | { kind: 'past-end' }

/** The rows the sentence walks. Archived is the Tasks table's archived order over the rows already
 *  loaded; every other status walks the current sidebar tab in the sidebar's own order, with no
 *  row cap (`capBuckets` is the sidebar's, not the voice list's). */
function rowsFor(runs: readonly RunSummary[], sidebarView: SidebarView, status: VoiceStatus): QuickListRow[] {
  if (status === 'archived') {
    return sortRuns(runs, 'archived')
      .filter((run) => !isOwnedWorker(run))
      .slice(0, ARCHIVED_WINDOW)
      .map((run) => ({ kind: 'run', run, queuePosition: null }))
  }
  return groupRuns(sidebarRuns(runs, sidebarView), 'active').flatMap((bucket) => bucket.rows)
}

const rowMatches = (row: QuickListRow, status: VoiceStatus): boolean =>
  voiceStatusMatches(status, row.run)

const rowHolds = (row: QuickListRow, runId: string): boolean =>
  row.run.id === runId

const targetOf = (row: QuickListRow | undefined): OpenTarget => {
  if (row === undefined) return { kind: 'past-end' }
  return { kind: 'run', runId: row.run.id }
}

export function resolveOpenTarget(args: {
  runs: readonly RunSummary[]
  sidebarView: SidebarView
  openRunId: string | null
  status: VoiceStatus
  position: VoicePosition
}): OpenTarget {
  const { runs, sidebarView, openRunId, status, position } = args
  // Filter first, count second: "next failed" is the next row that is failed, not the next row.
  const rows = rowsFor(runs, sidebarView, status).filter((row) => rowMatches(row, status))
  if (rows.length === 0) return { kind: 'empty' }

  if (typeof position === 'number') return targetOf(rows[position - 1])
  if (position === 'last') return targetOf(rows[rows.length - 1])

  const activeId = sidebarActiveRunId(openRunId, runs)
  const current = activeId === null ? -1 : rows.findIndex((row) => rowHolds(row, activeId))
  if (position === 'next') return targetOf(rows[current + 1])
  // `previous` with no current row is the last row; `rows[-2]` below would be `undefined`.
  return targetOf(current === -1 ? rows[rows.length - 1] : rows[current - 1])
}
