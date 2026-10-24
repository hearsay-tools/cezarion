import * as React from 'react'

import { useTaskPreviewHandoff } from '@/api/queries'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/design-icons'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import type { AttentionTone } from '@/lib/attention'
import type { BucketLabel } from '@/lib/task-groups'
import { TASK_ORIGINS, type TaskOrigin } from '@/lib/task-origin'
import { progressPreview } from '@/lib/task-preview'
import { cn } from '@/lib/utils'

/**
 * The Tasks pages' shared controls (hearsay-tools/cezarion#1616): the origin chips, the foldable
 * status groups, the origin line under a title, and a row's inline preview. Project tasks and All
 * tasks render the same pieces, so the two pages read as one surface.
 */

/** All / Direct tasks / Automations, each with the count it would show. Independent of the
 *  Active / Archived tabs: switching tabs keeps the origin. */
export function OriginFilter({
  origin,
  counts,
  onChange,
}: {
  origin: TaskOrigin
  counts: Record<TaskOrigin, number>
  onChange: (origin: TaskOrigin) => void
}) {
  return (
    <div role="group" aria-label="Task origin" data-slot="origin-filter" className="flex flex-wrap items-center gap-1.5">
      {TASK_ORIGINS.map((option) => {
        const pressed = option.value === origin
        return (
          <button
            key={option.value}
            type="button"
            data-origin={option.value}
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground',
              pressed && 'border-accent-strong bg-accent-strong/10 text-accent-text',
            )}
          >
            {option.label}{' '}
            <span className="tabular-nums">{counts[option.value]}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Expand groups / Collapse groups: visibility only. Neither changes what the list holds. Shown
 * from `md`: on a phone each heading toggles its own group, and the first task stays above the
 * fold.
 */
export function GroupFoldControls({ onExpand, onCollapse }: { onExpand: () => void; onCollapse: () => void }) {
  return (
    <div data-slot="group-fold-controls" className="hidden flex-wrap items-center gap-2 md:ml-auto md:flex">
      <Button type="button" variant="ghost" className="min-h-11" data-action="expand-groups" onClick={onExpand}>Expand groups</Button>
      <Button type="button" variant="ghost" className="min-h-11" data-action="collapse-groups" onClick={onCollapse}>Collapse groups</Button>
    </div>
  )
}

/**
 * The row under the toolbar: the origin chips, and the fold controls while there are groups to
 * fold.
 */
export function TaskOriginRow({ origin, counts, onChange, labels, onSetAll }: {
  origin: TaskOrigin
  counts: Record<TaskOrigin, number>
  onChange: (origin: TaskOrigin) => void
  /** The groups on screen, which the fold controls open or close together. */
  labels: readonly BucketLabel[]
  onSetAll: (labels: readonly BucketLabel[], folded: boolean) => void
}) {
  return (
    <div data-slot="task-origin-row" className="flex flex-wrap items-center gap-2.5">
      <OriginFilter origin={origin} counts={counts} onChange={onChange} />
      {labels.length > 0 ? <GroupFoldControls onExpand={() => onSetAll(labels, false)} onCollapse={() => onSetAll(labels, true)} /> : null}
    </div>
  )
}

/** What the heading dot says, for a reader who cannot see its colour. */
const TONE_LABELS: Partial<Record<AttentionTone, string>> = {
  pending: 'needs you',
  running: 'working',
  success: 'finished',
  danger: 'contains failed tasks',
  neutral: 'archived',
}

/**
 * One status group: a disclosure heading that keeps its name, count and dot when folded, and its
 * rows. `folded` is the reader's saved choice; `collapsed` is what renders, which a search can
 * override to show a match without changing the saved choice.
 */
export function StatusGroupSection({
  id,
  label,
  count,
  tone,
  folded,
  collapsed,
  onToggle,
  children,
}: {
  id: string
  label: BucketLabel
  count: number
  tone: AttentionTone
  folded: boolean
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const Disclosure = collapsed ? ChevronRightIcon : ChevronDownIcon
  return (
    <section data-slot="task-status-group" data-bucket={label} data-folded={folded} data-tone={tone} aria-labelledby={`${id}-heading`} className="flex flex-col gap-2.5">
      <h2 id={`${id}-heading`} className="text-[13px] font-semibold text-foreground">
        <button
          type="button"
          data-slot="status-group-toggle"
          aria-expanded={!collapsed}
          aria-controls={`${id}-rows`}
          // The sidebar's `Finished 3` grammar, plus the one fact the dot's colour carries.
          aria-label={`${label} ${count}${tone === 'danger' ? ', contains failed tasks' : ''}`}
          onClick={onToggle}
          className="inline-flex min-h-11 items-center gap-2 rounded-md pr-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link-foreground"
        >
          <Disclosure className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <StatusDot tone={tone} role="img" aria-label={TONE_LABELS[tone]} title={TONE_LABELS[tone]} />
          <span>{label}</span>{' '}
          <span className="font-normal tabular-nums text-muted-foreground">{count}</span>
        </button>
      </h2>
      <div id={`${id}-rows`} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
    </section>
  )
}

/**
 * The line under a task title: its project (on All tasks) and who started it. An automation task
 * names its automation, falling back to the recorded id when the definition is gone or the names
 * could not be read, so the task's history never depends on the definition still existing.
 */
export function TaskOriginLine({
  automationId,
  automationName,
  project,
}: {
  automationId: string | undefined
  automationName: string | undefined
  project?: React.ReactNode
}) {
  const origin = automationId === undefined ? 'Direct task' : automationName ?? automationId
  return (
    <span data-slot="task-origin" data-origin={automationId === undefined ? 'direct' : 'automation'} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {project ? <>{project}<span aria-hidden="true">·</span></> : null}
      <span className="min-w-0 break-words" title={automationId === undefined ? undefined : `Automation ${automationId}`}>{origin}</span>
    </span>
  )
}

/**
 * A row's inline preview, read only once the row is open: the latest progress from the task's
 * handoff journal, the error a failed run recorded, and Open task. Loading and an unreadable
 * journal say so rather than leaving a gap.
 */
export function TaskPreview({
  projectId,
  runId,
  status,
  error,
  open,
}: {
  /** Another project's run (All tasks); absent reads the active project. */
  projectId?: string
  runId: string
  /** The status label the row's pill shows, repeated as the preview's first fact. */
  status: string
  error?: string
  /** The Open task link, built by the caller's router. */
  open: React.ReactNode
}) {
  const handoff = useTaskPreviewHandoff(projectId, runId, true)
  const lines = handoff.data === undefined ? [] : progressPreview(handoff.data)
  return (
    <div data-slot="task-preview" className="flex flex-col gap-3 rounded-md bg-muted/50 p-4 text-xs">
      <p className="font-medium text-foreground first-letter:uppercase">{status}</p>
      {error ? <p data-slot="task-preview-error" className="break-words text-danger">{error}</p> : null}
      {handoff.isPending ? (
        <p role="status" className="text-muted-foreground">Loading latest progress…</p>
      ) : handoff.isError ? (
        <p data-slot="task-preview-unavailable" className="text-muted-foreground">Latest progress is unavailable.</p>
      ) : lines.length === 0 ? (
        <p className="text-muted-foreground">No progress recorded yet.</p>
      ) : (
        <ul aria-label="Latest progress" className="flex flex-col gap-1 text-muted-foreground">
          {lines.map((line, index) => <li key={index} className="break-words">{line}</li>)}
        </ul>
      )}
      <div>{open}</div>
    </div>
  )
}
