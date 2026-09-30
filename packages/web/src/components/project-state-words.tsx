import { projectSignalParts, type ProjectSignal, type SignalTone } from '@/lib/project-signal'
import { cn } from '@/lib/utils'

/**
 * A project's signal as coloured words (#711): the state line under a project's name on the
 * mobile drawer (#620) and the expanded desktop rail. One component, so the two surfaces word and
 * ink a state identically.
 *
 * The inks are text inks, not the pills' fills: 11px words need 4.5:1 on the default, hover and
 * selected rows, which `--danger` and `--pending-strong` miss on the selected row. See the
 * `--signal-word-*` tokens in `styles/index.css` for the measured ratios.
 */
export const SIGNAL_WORD_CLASS: Record<SignalTone, string> = {
  amber: 'text-signal-word-amber',
  red: 'text-signal-word-red',
  violet: 'text-status-running',
  green: 'text-success',
}

export function ProjectStateWords({
  signal,
  known,
  truncated,
  current,
  maxParts,
  slot,
  className,
}: {
  signal: ProjectSignal | undefined
  /** False while the runs index has not loaded: the line says "activity unknown", not "idle". */
  known: boolean
  /** Adds "recent runs only" when the index capped this project's runs. */
  truncated: boolean
  /** The current project's row. Its selected fill takes `--soft-foreground` to 4.45:1 (dark) and
   *  4.25:1 (light), so the neutral words (idle, unknown, separators) step up to `--muted-foreground`. */
  current: boolean
  /** Keep only the first N parts, in `projectSignalParts` priority order. The accessible name
   *  still carries all of them; this is only what fits on screen. */
  maxParts?: number
  slot: string
  /** Size, gap and wrapping: the drawer wraps at 11.5px, the rail stays on one 11px line. */
  className?: string
}) {
  const parts = projectSignalParts(signal).slice(0, maxParts)
  return (
    <span data-slot={slot} className={cn('flex min-w-0 items-center font-medium', current ? 'text-muted-foreground' : 'text-soft-foreground', className)}>
      {!known ? 'activity unknown' : parts.length === 0 ? 'idle' : parts.map((part, index) => (
        <span key={part.tone} className="flex items-center gap-x-[inherit]">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span data-tone={part.tone} className={SIGNAL_WORD_CLASS[part.tone]}>{part.text}</span>
        </span>
      ))}
      {known && truncated ? <span>· recent runs only</span> : null}
    </span>
  )
}
