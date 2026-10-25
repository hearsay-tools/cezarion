import { isValidElement, type ReactNode } from 'react'

import { ChevronDownIcon } from '@/components/design-icons'
import { cn } from '@/lib/utils'

/**
 * One row of the Session activity accordion (#402, mockups `pasted-2/3.png`): a tinted section
 * glyph, the bold section title, its muted meter, and a chevron — the whole row is the
 * toggle. Its list nests underneath on a faintly lifted surface, so an open section reads as
 * part of the same card rather than as another dock stacked on top of it.
 *
 * It lives in its own module because the workers section builds its row from inside
 * `run-relationships.tsx` (it owns the relationships query), and importing the dock back
 * would close an import cycle.
 */
/**
 * A section meter, in the two lengths the mockups show: `Step 1 of 2` / `2 of 2 complete` on a
 * desktop row, the bare `1 / 2` odometer when the row is narrow and the title needs the space.
 */
export function meterText(done: number, total: number, desktop: boolean, noun?: 'step'): string {
  if (!desktop) return `${done} / ${total}`
  return noun === 'step' ? `Step ${done} of ${total}` : `${done} of ${total} complete`
}

/** A row meta in two parts; see `ActivityRow`'s `meta`. */
export interface MetaParts {
  keep: ReactNode
  drop?: ReactNode
}

function isMetaParts(meta: ReactNode | MetaParts): meta is MetaParts {
  return typeof meta === 'object' && meta !== null && !isValidElement(meta) && 'keep' in meta
}

export function ActivityRow({
  slot,
  icon,
  title,
  meta,
  summary,
  aside,
  open,
  onToggle,
  className,
  children,
}: {
  /** `status-row` | `workflow` | `subagents` | `workers` | `plan` | `usage` | `workspace` — the
   *  row's `data-slot` suffix. */
  slot: string
  icon: ReactNode
  title: ReactNode
  /** A plain meta truncates with an ellipsis. `{ keep, drop }` never cuts text: `keep` always
   *  shows whole, `drop` shows before it only while all of it fits, and is gone otherwise. */
  meta?: ReactNode | MetaParts
  /** A summary that manages its own whole-item overflow. */
  summary?: ReactNode
  /** A value that stays visible beside the section meter, including when folded. */
  aside?: ReactNode
  open: boolean
  /** Absent: the row has nothing to disclose and renders as a plain, non-interactive line. */
  onToggle?: (() => void) | undefined
  className?: string | undefined
  children?: ReactNode
}) {
  const head = (
    <>
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-accent-text">{icon}</span>
      {/* A plain label (`Workspace`) keeps its width and the meta truncates; a composed title
          (`Workflow · <name>`) can be long, so it shares the row. */}
      <span className={cn('truncate text-[14px] font-semibold text-foreground', typeof title === 'string' ? 'shrink-0' : 'min-w-0 shrink')}>{title}</span>
      {summary ?? (isMetaParts(meta) ? (
        // `contents`: both parts sit in the row itself. Inside a wrapper box, the drop's unbreakable
        // width would become that box's minimum and push the kept part out of the row.
        <span data-slot="run-activity-meta" className="contents text-[13px] text-muted-foreground tabular-nums">
          {meta.drop !== undefined ? (
            // One line tall and clipped: a zero-width, full-height first item holds the line, so a
            // `drop` too wide for what is left wraps whole onto the hidden second line instead of
            // being cut. Without the height the empty first line collapses and the second shows.
            <span className="flex h-[1lh] min-w-0 shrink-[2] flex-wrap overflow-hidden">
              <span aria-hidden className="h-[1lh] w-0" />
              <span data-slot="run-activity-meta-drop" className="whitespace-nowrap">
                {meta.drop}
                <span className="text-soft-foreground"> ·</span>
              </span>
            </span>
          ) : null}{' '}
          <span data-slot="run-activity-meta-keep" className="shrink-0 whitespace-nowrap">{meta.keep}</span>
        </span>
      ) : meta !== undefined ? (
        <span
          data-slot="run-activity-meta"
          className="min-w-0 shrink-[2] truncate text-[13px] text-muted-foreground tabular-nums"
        >
          {meta}
        </span>
      ) : null)}
    </>
  )
  const disclosable = onToggle !== undefined
  return (
    <div
      data-slot={`run-activity-${slot}`}
      data-state={disclosable && open ? 'open' : 'collapsed'}
      className={cn('min-w-0 border-t border-border first:border-t-0', className)}
    >
      {disclosable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3.5 py-2 text-start hover:bg-muted/40 active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        >
          {head}
          {aside}
          <ChevronDownIcon
            aria-hidden
            className={cn('size-4 shrink-0 text-soft-foreground motion-safe:transition-transform motion-reduce:transition-none', !aside && 'ms-auto', open && 'rotate-180')}
          />
        </button>
      ) : (
        <div className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3.5 py-2">{head}{aside}</div>
      )}
      {disclosable && open ? (
        <div data-slot="run-activity-body" className="min-w-0 border-t border-border/60 bg-muted/30 px-3.5 py-2.5">
          {children}
        </div>
      ) : null}
    </div>
  )
}
