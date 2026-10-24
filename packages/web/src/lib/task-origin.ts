import { isAutomationTask } from '@open-mercato/cezar-api-client/contract/runs'
import type { RunIndexEntry, RunSummary } from '@open-mercato/cezar-api-client'

import { deriveAttention, type AttentionTone } from './attention'
import { groupRuns, isOwnedWorker, queuePositions, type BucketLabel, type ListView } from './task-groups'

/**
 * The Tasks pages' origin filter and status groups (hearsay-tools/cezarion#1616): the pure half
 * shared by Project tasks and All tasks.
 *
 * Origin is the RECORDED provenance (`automationId`, from `automation` or `automationTrigger`), the
 * rule the sidebar's Automations tab already uses through `isAutomationTask`. An autonomous task a
 * person started is still a direct task: the flag says how it runs, not who started it.
 *
 * Grouping is the sidebar's own `groupRuns`, called directly so the two surfaces cannot disagree
 * about which task needs you. What this module adds is the part the sidebar never needed: the
 * cross-project index has run ids that are only unique per project, so its rows are namespaced
 * before grouping and mapped back after.
 */

export type TaskOrigin = 'all' | 'direct' | 'automations'

export const TASK_ORIGINS: readonly { value: TaskOrigin; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'direct', label: 'Direct tasks' },
  { value: 'automations', label: 'Automations' },
]

/** The URL spelling: `origin=direct|automations`, absent for All. Anything else reads as All. */
export function parseOrigin(value: string | null | undefined): TaskOrigin {
  return value === 'direct' || value === 'automations' ? value : 'all'
}

export function matchesOrigin(run: { automationId?: string }, origin: TaskOrigin): boolean {
  if (origin === 'all') return true
  return isAutomationTask(run) === (origin === 'automations')
}

/** The `automation` flag the bulk routes take (`archive-finished`, `read-all`): absent for All. */
export function originAutomationFlag(origin: TaskOrigin): boolean | undefined {
  return origin === 'all' ? undefined : origin === 'automations'
}

/** The origin chips' counts, for the archive view in front of the reader. Owned workers are not
 *  rows, so they are not counted. */
export function originCounts(
  runs: readonly (Pick<RunSummary, 'archived' | 'automationId'> & { delegation?: { role?: string } | null })[],
  view: ListView,
): Record<TaskOrigin, number> {
  const counts = { all: 0, direct: 0, automations: 0 }
  for (const run of runs) {
    if (isOwnedWorker(run) || run.archived !== (view === 'archived')) continue
    counts.all += 1
    if (isAutomationTask(run)) counts.automations += 1
    else counts.direct += 1
  }
  return counts
}

/** One row of a status group, over any row type: a project's `RunSummary` or a global task. */
export type TaskGroupRow<R> =
  | { kind: 'run'; run: R; queuePosition: number | null }
  | { kind: 'group'; groupId: string; title: string; members: R[]; lead: R }

export interface TaskStatusGroup<R> {
  label: BucketLabel
  rows: TaskGroupRow<R>[]
}

/** Every task in a group, variant members included: what its heading counts. */
export function groupMembers<R>(group: TaskStatusGroup<R>): R[] {
  return group.rows.flatMap((row) => (row.kind === 'run' ? [row.run] : row.members))
}

/**
 * The heading dot. Needs you is yellow, Working violet, Archived neutral (history does not wait
 * for anyone). Finished is green, and red when any member failed, a variant member included: a
 * failure must not hide inside a green group.
 */
export function groupTone(label: BucketLabel, members: readonly RunSummary[]): AttentionTone {
  switch (label) {
    case 'Needs you':
      return 'pending'
    case 'Working':
      return 'running'
    case 'Archived':
      return 'neutral'
    case 'Finished':
      return members.some((run) => deriveAttention(run).bucket === 'error') ? 'danger' : 'success'
  }
}

/** The project tasks' groups: filter first, then group, with queue numbers from the full list. */
export function groupProjectRuns(
  visible: readonly RunSummary[],
  view: ListView,
  all: readonly RunSummary[],
): TaskStatusGroup<RunSummary>[] {
  return groupRuns(visible, view, queuePositions(all))
}

/** A project-qualified key. A tuple, so no project id or run id can forge a delimiter. */
const qualified = (projectId: string, id: string) => JSON.stringify([projectId, id])

/**
 * The global tasks' groups. Each row's run id, variant group id and worker parent id are
 * qualified by project before `groupRuns` sees them, so two projects' `r1` never merge into one
 * variant tile or adopt each other's worker. Queue numbers come from each project's FULL queue in
 * `all` (the index before any filter), since every project drains its own.
 */
export function groupIndexedTasks<T extends { run: RunIndexEntry }>(
  tasks: readonly T[],
  view: ListView,
  all: readonly RunIndexEntry[],
): TaskStatusGroup<T>[] {
  const byKey = new Map<string, T>()
  const namespaced = tasks.map((task) => {
    const { run } = task
    const id = qualified(run.projectId, run.id)
    byKey.set(id, task)
    const delegation = run.delegation
    return {
      ...run,
      id,
      ...(run.groupId === undefined ? {} : { groupId: qualified(run.projectId, run.groupId) }),
      ...(delegation && 'parentRunId' in delegation
        ? { delegation: { ...delegation, parentRunId: qualified(run.projectId, delegation.parentRunId) } }
        : {}),
    }
  })
  const perProject = new Map<string, RunIndexEntry[]>()
  for (const run of all) {
    const list = perProject.get(run.projectId)
    if (list) list.push(run)
    else perProject.set(run.projectId, [run])
  }
  const positions = new Map<string, number>()
  for (const [projectId, runs] of perProject) {
    for (const [id, position] of queuePositions(runs)) positions.set(qualified(projectId, id), position)
  }
  const back = (run: RunSummary) => byKey.get(run.id) as T
  return groupRuns(namespaced, view, positions).map((group) => ({
    label: group.label,
    rows: group.rows.map((row): TaskGroupRow<T> =>
      row.kind === 'run'
        ? { kind: 'run', run: back(row.run), queuePosition: row.queuePosition }
        : { kind: 'group', groupId: row.groupId, title: row.title, members: row.members.map(back), lead: back(row.lead) },
    ),
  }))
}

/** A row's tasks in display order: one run, or a variant group's members (A, B, C). */
export function rowTasks<R>(row: TaskGroupRow<R>): R[] {
  return row.kind === 'run' ? [row.run] : row.members
}
