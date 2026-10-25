import type { RunSummary } from '@open-mercato/cezar-api-client'
import type * as React from 'react'
import { ArchiveIcon } from '@/components/design-icons'
import { PinToggle } from '@/components/pin-toggle'
import { StatusDot } from '@/components/status-dot'
import type { useSwipeToArchive } from '@/components/use-swipe-to-archive'
import { unreadMarkerTone } from '@/lib/read-state'
import { isSweepable } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'

const ROW_PIN_CLASS =
  'opacity-0 group-hover/task-row:opacity-100 focus-visible:opacity-100' +
  // Keyboard focus anywhere in the row (the title link, a reference) reveals it too; `:focus`
  // alone would keep it up on the current task after a click, whose link stays focused.
  ' group-has-[:focus-visible]/task-row:opacity-100' +
  // A device that CANNOT hover, where none of the above ever fires: always visible, 44px.
  ' no-hover:opacity-100'

/** The archive button's reveal (#780): the pin's, minus the always-visible touch rule — a device
 *  that cannot hover swipes instead and never renders the button. */
const ROW_ARCHIVE_CLASS =
  'opacity-0 group-hover/task-row:opacity-100 focus-visible:opacity-100 group-has-[:focus-visible]/task-row:opacity-100'

/** The unread marker hides wherever the pin shows — the two share the slot. On a no-hover device
 *  (or a narrow viewport) the pin never hides, so the marker steps to the slot's leading edge and
 *  both stay readable. Only applied to a row that HAS a pin; otherwise the marker simply sits there. */
const ROW_UNREAD_WITH_PIN_CLASS =
  'transition-opacity motion-reduce:transition-none' +
  ' group-hover/task-row:opacity-0 group-has-[:focus-visible]/task-row:opacity-0' +
  ' max-md:absolute max-md:top-1/2 max-md:left-0 max-md:-translate-y-1/2 max-md:opacity-100' +
  ' no-hover:absolute no-hover:top-1/2 no-hover:left-0 no-hover:-translate-y-1/2 no-hover:opacity-100'

/**
 * The trailing slot of a sidebar task row: the unread marker, the pin and the archive button.
 *
 * THE TRAILING SLOT (#617) is 16px and ALWAYS reserved. The pin used to appear on hover by
 * taking width from the title, which rewrapped it and made the row jump under the cursor; now
 * the pin and the unread marker share one fixed slot and only swap opacity, so hovering changes
 * no geometry at all. On a device that cannot hover (and on a narrow viewport, where the pin is a
 * 44px target) the slot is 44px wide instead — permanently, so nothing reflows there either.
 */
export function RunRowActions({
  run,
  title,
  unread,
  inertReferences,
  onTogglePin,
  onArchiveRun,
}: {
  run: RunSummary
  /** The row's full stored title: the archive button's accessible name. */
  title: string
  unread: boolean
  /** References are inert on a device that cannot hover, and in the mobile shell. */
  inertReferences: boolean
  onTogglePin?: ((run: RunSummary, pinned: boolean) => void) | undefined
  onArchiveRun?: (run: RunSummary) => void | Promise<unknown>
}) {
  // The trailing slot — reserved on every row, whether or not anything is in it (#617).
  return (
    <span
      data-slot="task-row-trailing"
      className="relative flex h-[19px] w-[16px] shrink-0 items-center justify-center max-md:h-auto max-md:w-11 max-md:self-stretch no-hover:h-auto no-hover:w-11 no-hover:self-stretch"
    >
      {unread ? (
        <StatusDot
          tone={unreadMarkerTone(run)}
          role="img"
          aria-label="unread"
          title="Unread — not opened since it finished"
          data-slot="unread-marker"
          className={onTogglePin ? ROW_UNREAD_WITH_PIN_CLASS : undefined}
        />
      ) : null}
      {/* The pin (#935), a SIBLING of the Link: a button inside an anchor is invalid, and this
          one has its own target. Centred over the slot rather than sized by it, so its 20px
          target never widens the slot; where it is a 44px target the slot is 44px wide and
          stretches to the row's height, so the target stays inside its own row. */}
      {onTogglePin ? (
        <PinToggle
          pinned={Boolean(run.pinned)}
          onToggle={(pinned) => onTogglePin(run, pinned)}
          className={cn('absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2', ROW_PIN_CLASS)}
        />
      ) : null}
      {/* The archive button (#780): line 2 of the same 16px column, under the pin. 20px target
          hung from the slot's line-1 bottom edge, so it never overlaps the pin's own, and the
          glyph is nudged up to sit on line 2's centre. Absolute, so the slot, the title and the
          row height are the same at rest and under the pointer. */}
      {onArchiveRun && !inertReferences && isSweepable(run) ? (
        <button
          type="button"
          data-action="archive-run"
          aria-label={`Archive ${title}`}
          title="Archive task"
          onClick={(event) => {
            event.stopPropagation()
            onArchiveRun(run)
          }}
          className={cn(
            'absolute top-[19.5px] left-1/2 inline-flex size-5 -translate-x-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none',
            ROW_ARCHIVE_CLASS,
          )}
        >
          <ArchiveIcon className="size-[12px] -translate-y-[2.5px]" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
}

/**
 * The swipe surface around a row where references are inert (touch, the mobile shell): a pointer
 * that can hover gets the row and no wrapper. Where references are inert the wrapper is ALWAYS
 * there, swipeable or not: a row that starts swiping (its run just finished) must keep its
 * element tree, or React remounts it and the focused link goes with it.
 *
 * The swipe state stays with the row (it paints `swipe.bind` and `swipe.offset` on its own
 * element), so this only wraps what the row hands it.
 */
export function RunRowSwipeFrame({
  inertReferences,
  swipeable,
  swipe,
  title,
  onArchive,
  children,
}: {
  inertReferences: boolean
  swipeable: boolean
  swipe: Pick<ReturnType<typeof useSwipeToArchive>, 'surfaceRef' | 'offset' | 'past'>
  title: string
  onArchive: () => void
  children: React.ReactNode
}) {
  if (!inertReferences) return children
  return (
    <div
      ref={swipe.surfaceRef}
      data-slot="task-row-swipe"
      data-swipe={swipeable ? 'on' : undefined}
      // `pan-y pinch-zoom`: the browser keeps vertical scrolling and pinch zoom; the gesture only
      // ever reads horizontal moves.
      className={cn('relative rounded-[6px]', swipeable && 'touch-pan-y touch-pinch-zoom overflow-hidden')}
    >
      {/* Tapping the parked action leaves the row parked until the list drops it. */}
      {swipe.offset < 0 ? <SwipeArchiveAction width={-swipe.offset} past={swipe.past} title={title} onArchive={onArchive} /> : null}
      {children}
    </div>
  )
}

/**
 * What a swipe uncovers behind a finished row (#780 §7): an 88px `Archive` action while short,
 * the whole uncovered width in `--info` with `Release to archive` once past the commit point.
 * Hidden from assistive tech: the row stays ONE link, and the thread's own Archive is the path
 * that does not need a gesture.
 */
function SwipeArchiveAction({ width, past, title, onArchive }: { width: number; past: boolean; title: string; onArchive: () => void }) {
  return (
    <div
      data-slot="task-row-swipe-action"
      data-past={past ? 'true' : undefined}
      aria-hidden="true"
      style={{ width }}
      className={cn(
        'absolute inset-y-0 right-0 flex items-stretch justify-end overflow-hidden rounded-[6px]',
        // Ink on --info is the violet pill's pair (`--signal-ink`): #121722 dark, #FFFFFF light.
        past ? 'bg-info text-signal-ink' : 'bg-muted text-foreground',
      )}
    >
      {past ? (
        <span className="flex w-full items-center justify-center gap-2 text-[12px] font-semibold whitespace-nowrap">
          <ArchiveIcon className="size-[16px] shrink-0" aria-hidden="true" />
          Release to archive
        </span>
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Archive ${title}`}
          onClick={(event) => {
            event.stopPropagation()
            onArchive()
          }}
          className="flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 text-[12px] font-semibold"
        >
          <ArchiveIcon className="size-[16px]" aria-hidden="true" />
          Archive
        </button>
      )}
    </div>
  )
}
