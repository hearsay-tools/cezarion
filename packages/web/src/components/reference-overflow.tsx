import * as React from 'react'
import { createPortal } from 'react-dom'
import { ReferenceChip } from '@/components/reference-chip'
import { ResolveConflictsForRun } from '@/components/reference-conflict-action'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { taskItemPath, isOwnRepoReference, referenceKey, type TaskReference } from '@/lib/tasks-table'

const HOVER_CLOSE_DELAY_MS = 220

export function ReferenceOverflow({
  references,
  taskTitle,
  visibleCount,
  plain = false,
  projectId,
  runId,
  repoBase,
}: {
  references: readonly TaskReference[]
  taskTitle: string
  visibleCount: number
  plain?: boolean
  projectId?: string
  runId: string
  repoBase?: string
}) {
  const [open, setOpen] = React.useState(false)
  // How it was opened decides whether focus moves into the list. A CLICK should hand the keyboard
  // the links; a hover must not yank focus out of whatever the reader was doing.
  const openedByHover = React.useRef(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(closeTimer.current), [])

  // Touch has no hover: a tap fires `pointerenter` first, so without this guard the list would
  // open under the finger and then be toggled shut again by the click that follows. Excluded
  // rather than allow-listing `mouse`, so a pen (which does hover) and any device that reports
  // nothing still get the hover behaviour.
  const isHover = (event: React.PointerEvent) => event.pointerType !== 'touch'
  const cancelClose = () => clearTimeout(closeTimer.current)
  const onPointerEnter = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    if (!open) openedByHover.current = true
    setOpen(true)
  }
  // On a DELAY, and the same handler on the trigger and the content: the two are separate
  // elements with a 4px gap between them, so an instant close would make the list impossible to
  // reach with the pointer.
  const onPointerLeave = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }

  const hidden = references.length - visibleCount
  const names = references.slice(visibleCount).map(reference => {
    const collision = references.some(other => other !== reference && other.kind === reference.kind && other.number === reference.number)
    const repo = collision && reference.url ? new URL(reference.url).pathname.split('/').slice(1, 3).join('/') : ''
    return `${reference.kind} #${reference.number}${repo ? ` (${repo})` : ''}`
  }).join(', ')
  if (hidden <= 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="reference-overflow"
          title={names}
          aria-label={`Show all ${references.length} references for ${taskTitle}`}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          // A real press — mouse, tap or keyboard — is not a hover, whatever happened before it.
          onPointerDown={(event) => {
            event.stopPropagation()
            openedByHover.current = false
          }}
          onClick={(event) => {
            event.stopPropagation()
            openedByHover.current = false
          }}
          className="no-hover:min-h-[44px] no-hover:min-w-[44px] max-md:min-h-[44px] max-md:min-w-[44px] shrink-0 rounded-full px-1 text-[11px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          +{hidden}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-auto min-w-40 max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain p-1.5"
        data-slot="reference-overflow-list"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          // Start at the list, so focusing its first chip does not open a nested status card.
          if (!openedByHover.current && event.target instanceof HTMLElement) event.target.focus()
        }}
        onKeyDownCapture={(event) => {
          // Escape from a chip's portaled status card closes the reference list too.
          if (event.key !== 'Escape') return
          event.preventDefault()
          openedByHover.current = false
          setOpen(false)
        }}
        onCloseAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
      >
        <p className="px-1 pb-1.5 text-[11px] text-soft-foreground">References</p>
        <span className="flex flex-col items-start gap-1">
          {references.map((reference) => (
            <ReferenceChip
              key={referenceKey(reference)}
              reference={reference}
              taskTitle={taskTitle}
              projectId={projectId}
              repoBase={repoBase}
              to={projectId !== undefined ? taskItemPath(projectId, runId, reference, repoBase) : undefined}
              plain={plain}
              className="no-hover:min-h-[44px] max-md:min-h-[44px]"
              conflictAction={projectId && isOwnRepoReference(reference, repoBase) ? <ResolveConflictsForRun projectId={projectId} runId={runId} prNumber={reference.number} /> : undefined}
            />
          ))}
        </span>
      </PopoverContent>
    </Popover>
  )
}


/** Both surfaces share partitioning, so hidden counts and destinations cannot diverge. */
export function ReferenceList({ references, maxVisible, taskTitle, projectId, runId, repoBase,
  plain = false, compact = false, inertInline = false, fitContainer = false, overflowContainer,
}: {
  references: readonly TaskReference[]; maxVisible: number; taskTitle: string; projectId?: string;
  runId: string; repoBase?: string; plain?: boolean; compact?: boolean; inertInline?: boolean; fitContainer?: boolean; overflowContainer?: HTMLElement | null;
}) {
  const container = React.useRef<HTMLSpanElement>(null)
  const [visibleCount, setVisibleCount] = React.useState(maxVisible)
  const widths = React.useRef(new Map<string, number>())
  const signature = references.map(referenceKey).join('|')
  React.useLayoutEffect(() => {
    const element = container.current
    if (!fitContainer || !element?.parentElement) { setVisibleCount(maxVisible); return }
    const parent = element.parentElement
    const measure = () => {
      const children = [...element.querySelectorAll<HTMLElement>(':scope > [data-slot="pr-chip"], :scope > [data-slot="issue-chip"]')]
      children.forEach((child, index) => {
        const width = child.getBoundingClientRect().width
        if (width) widths.current.set(referenceKey(references[index]!), width)
      })
      const rect = parent.getBoundingClientRect()
      if (!rect.width) return // jsdom or a hidden section
      // The age policy measures the preferred inline content even after fitting hides chips.
      // Otherwise collapsing references makes the age return and steal their space again.
      const preferred = Math.min(maxVisible, references.length)
      element.dataset.referenceWidth = String(references.slice(0, preferred).reduce((sum, reference) =>
        sum + (widths.current.get(referenceKey(reference)) ?? 48), 0) + Math.max(0, preferred - 1) * 4)
      // Overflow rendered into a row's protected sibling already reserves its own width.
      // Keep trailing tokens out of the inline budget. Age and its separator drop first.
      let trailing = 0
      for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.getAttribute('data-slot') === 'task-row-age' ||
          (sibling.getAttribute('aria-hidden') === 'true' && sibling.nextElementSibling?.getAttribute('data-slot') === 'task-row-age')) continue
        const style = getComputedStyle(sibling)
        trailing += sibling.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0)
      }
      const available = rect.right - element.getBoundingClientRect().left - trailing
      const overflowWidth = element.querySelector('[data-slot="reference-overflow"]')?.getBoundingClientRect().width || (inertInline ? 44 : 26)
      let count = Math.min(maxVisible, references.length)
      // Cached intrinsic widths survive removing a chip; thresholds do not oscillate on resize.
      while (count > 0) {
        const needed = references.slice(0, count).reduce((sum, reference) => sum + (widths.current.get(referenceKey(reference)) ?? 48) + 4, 0)
          + (overflowContainer === undefined && count < references.length ? overflowWidth : 0)
        // Showing the last reference removes the protected overflow button. Its current width
        // must be returned to that candidate's budget, or a narrow row can stay stuck at +1.
        const reclaimed = count === references.length ? overflowContainer?.getBoundingClientRect().width ?? 0 : 0
        if (needed <= available + reclaimed) break
        count--
      }
      setVisibleCount(count)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    observer.observe(element)
    return () => observer.disconnect()
  }, [fitContainer, maxVisible, signature, inertInline, references, overflowContainer])
  const count = Math.min(visibleCount, maxVisible, references.length)
  const overflow = <ReferenceOverflow references={references} visibleCount={count} taskTitle={taskTitle} projectId={projectId}
    runId={runId} repoBase={repoBase} plain={plain} />
  return <span ref={container} data-slot="reference-list" className="inline-flex max-w-full flex-nowrap items-center gap-1 align-middle">
      {references.slice(0, count).map(reference => <ReferenceChip key={referenceKey(reference)} reference={reference}
        taskTitle={taskTitle} projectId={projectId} repoBase={repoBase} to={projectId !== undefined ? taskItemPath(projectId, runId, reference, repoBase) : undefined}
        plain={plain} compact={compact} inert={inertInline} className="shrink-0"
        conflictAction={projectId && isOwnRepoReference(reference, repoBase) ? <ResolveConflictsForRun projectId={projectId} runId={runId} prNumber={reference.number} /> : undefined} />)}
      {overflowContainer === undefined ? overflow : overflowContainer ? createPortal(overflow, overflowContainer) : null}
    </span>
}
