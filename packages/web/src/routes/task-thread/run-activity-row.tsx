import type { ReactNode } from 'react'

import { ChevronDownIcon } from '@/components/design-icons'
import { cn } from '@/lib/utils'

/**
 * One row of the Run activity accordion (#402, mockups `pasted-2/3.png`): a tinted section
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

export function ActivityRow({
  slot,
  icon,
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  /** `workflow` | `subagents` | `workers` | `plan` — the row's `data-slot` suffix. */
  slot: string
  icon: ReactNode
  title: string
  meta: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div
      data-slot={`run-activity-${slot}`}
      data-state={open ? 'open' : 'collapsed'}
      className="min-w-0 border-t border-border first:border-t-0"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-3.5 py-2 text-left hover:bg-muted/40"
      >
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-accent-text">{icon}</span>
        <span className="min-w-0 shrink truncate text-[14px] font-semibold text-foreground">{title}</span>
        <span
          data-slot="run-activity-meta"
          className="min-w-0 shrink-[2] truncate text-[13px] text-muted-foreground tabular-nums"
        >
          {meta}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn('ml-auto size-4 shrink-0 text-soft-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div data-slot="run-activity-body" className="min-w-0 border-t border-border/60 bg-muted/30 px-3.5 py-2.5">
          {children}
        </div>
      ) : null}
    </div>
  )
}
