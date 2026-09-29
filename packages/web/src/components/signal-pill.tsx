import type { ProjectSignal, SignalTone } from '@/lib/project-signal'
import { cn } from '@/lib/utils'

/**
 * The rail's pill, shared by every surface that shows a project's signal: the desktop rail (#618)
 * and the mobile menu button and drawer rows (#620). One form and one colour set, so a mark reads
 * the same wherever it appears; only placement and the ring colour change, through `className`.
 */

/** Fill and ink per segment. The inks are tokens (`--signal-ink*`) because the light theme flips
 *  them: dark ink on amber only, white on the darker red, violet and green. */
export const SEGMENT_CLASS: Record<SignalTone, string> = {
  amber: 'bg-pending text-signal-ink-amber',
  red: 'bg-danger text-signal-ink',
  violet: 'bg-status-running text-signal-ink',
  green: 'bg-success text-signal-ink',
}

/** Segment width in fixed px: 18 alone, 14 each when split, and `9+` widens to 22. */
function segmentWidth(count: number, segments: number, compact: boolean): number {
  // `compact` (the mobile menu button, 64px wide): a split pill never widens, so it stays 32px and
  // clear of the menu icon. `9+` still fits 14px at 10px bold.
  if (count > 9 && !(compact && segments > 1)) return 22
  return segments === 1 ? 18 : 14
}

/**
 * One pill. Same form top and bottom; only the position and the segment order differ. A 2px
 * border in the surface's own colour reads as a cut-out where it overhangs the mark. Decorative:
 * the mark's accessible name already spells the counts out in words.
 */
export function SignalPill({
  position,
  segments,
  className,
  compact = false,
}: {
  position: 'top' | 'bottom'
  segments: readonly { tone: SignalTone; count: number }[]
  /** Placement and ring colour for a mark that is not the rail's: merged over the rail's defaults. */
  className?: string
  compact?: boolean
}) {
  const shown = segments.filter((segment) => segment.count > 0)
  if (shown.length === 0) return null
  return (
    <span
      aria-hidden="true"
      data-slot={`rail-pill-${position}`}
      // `right: -4px` puts the pill's right edge 4px past the mark's; `y = -6px` at the top and
      // `markHeight - 11px` (25px) at the bottom. `pointer-events-none`: the pill sits over the
      // mark's link and must not eat its click.
      className={cn(
        'pointer-events-none absolute -right-[4px] box-border flex h-[17px] overflow-hidden rounded-[9px] border-2 border-background',
        position === 'top' ? '-top-[6px]' : 'top-[25px]',
        className,
      )}
    >
      {shown.map(({ tone, count }) => (
        <span
          key={tone}
          data-segment={tone}
          data-count={count}
          style={{ width: segmentWidth(count, shown.length, compact) }}
          className={cn('flex items-center justify-center text-[10px] leading-[13px] font-bold tabular-nums', SEGMENT_CLASS[tone])}
        >
          {count > 9 ? '9+' : count}
        </span>
      ))}
    </span>
  )
}

/** The two pills' segments for one signal: top "for you", bottom "in motion and new". */
export function signalPillSegments(signal: ProjectSignal | undefined) {
  return {
    top: [
      { tone: 'amber', count: signal?.needsYou ?? 0 },
      { tone: 'red', count: signal?.failedUnread ?? 0 },
    ],
    bottom: [
      { tone: 'violet', count: signal?.inMotion ?? 0 },
      { tone: 'green', count: signal?.finishedUnread ?? 0 },
    ],
  } as const satisfies Record<'top' | 'bottom', readonly { tone: SignalTone; count: number }[]>
}
