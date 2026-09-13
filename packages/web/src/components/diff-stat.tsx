import type { DiffStat } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'

/**
 * `+128 −14` — a run's aggregate diff numbers, the mockup's `.adds`/`.dels` pair
 * (`tasks-home.html`): mono, tabular, adds in the success token, deletions in the danger token.
 * One component so the table's ± column, the sidebar quick-list and the mobile cards can never
 * disagree about what a diff stat looks like.
 *
 * Renders only when a `DiffStat` exists — the caller owns its own absent state (the table's
 * honest `—`, the quick-list's nothing), because what absence means differs per surface.
 * The `−` is U+2212 (minus sign), as in the mockup — a hyphen is not a math sign.
 *
 * `stat.repointed` (#751) marks a number measured against a branch the agent checked out into
 * the task's worktree — every review and QA run does that, and so does every skill that opens
 * its work on a named branch. Those runs used to report that branch's entire history as their
 * own; the number counts only what the run itself did to it now, but
 * it is right for a *different* reason than the one next to it, so it says so: a dotted
 * underline and `cursor-help` advertise the explanation, the `title` carries it, and
 * `data-repointed` lets a surface style or assert on it without re-deriving the rule.
 *
 * That caveat also gets an `aria-label`, which the plain case deliberately does NOT: `title`
 * is unreliable for screen readers and unreachable on touch, and here it carries meaning
 * (*what these numbers measure*) rather than a restatement of the visible text. Without it,
 * assistive tech would read the narrowed number as if it were an ordinary one.
 *
 * The wording is deliberately past-tense ("measured with…") rather than a claim about the
 * worktree right now. `diffStat` is a snapshot taken at turn-end and is never recomputed or
 * cleared afterwards — not when the run finishes, and not when retention reclaims the
 * worktree — so a present-tense sentence would keep asserting a checkout that may have
 * stopped existing hours ago. What the flag can honestly say is what was true when the
 * numbers were taken.
 */
function compactDiffCount(count: number): string {
  if (count < 1_000) return String(count)
  const units = ['k', 'M', 'B', 'T'] as const
  const unit = Math.floor(Math.log10(count) / 3)
  if (unit > units.length) return count.toExponential(0).replace('+', '')
  return `${Math.floor(count / 1_000 ** unit)}${units[unit - 1]}`
}

export function DiffStatLabel({
  stat,
  className,
  compact = false,
}: {
  stat: DiffStat
  className?: string
  /** A bounded table representation; the exact counts remain in the tooltip and accessible name. */
  compact?: boolean
}) {
  const counts = `+${stat.adds} −${stat.dels} across ${stat.files} ${stat.files === 1 ? 'file' : 'files'}`
  const caveat = stat.repointed
    ? `${counts} — measured against another branch checked out in this task's worktree, as this task found it`
    : undefined
  return (
    <span
      data-slot="diff-stat"
      {...(caveat ? { 'data-repointed': 'true', 'aria-label': caveat } : {})}
      {...(compact && !caveat ? { 'aria-label': counts } : {})}
      title={caveat ?? counts}
      className={cn(
        'font-mono text-xs font-semibold tabular-nums',
        stat.repointed && 'cursor-help underline decoration-dotted underline-offset-2',
        className
      )}
    >
      <span className="text-success">+{compact ? compactDiffCount(stat.adds) : stat.adds.toLocaleString('en-US')}</span>{' '}
      <span className="text-danger">−{compact ? compactDiffCount(stat.dels) : stat.dels.toLocaleString('en-US')}</span>
    </span>
  )
}
