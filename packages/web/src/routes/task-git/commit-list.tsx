import { FileDiffIcon, GitCommitHorizontalIcon, SearchIcon } from '@/components/design-icons'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Virtualizer } from 'virtua'

import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * The commit log list, shared by the task Commits tab and the repo Commits segment — one
 * `sha · subject · author·when` row per commit, deep-linking to that commit's structured diff.
 *
 * Same two-tier rule as the transcript and the diff (`components/diff/diff-scroll.ts` §"THE
 * PERFORMANCE RULE"): flat with `content-visibility: auto` up to
 * {@link COMMIT_VIRTUALIZE_THRESHOLD} rows, virtua past it. Rows have a fixed two-line layout, which
 * makes this the easy case — `ROW_HEIGHT_PX` is exact rather than an estimate, so the flat
 * tier's placeholders and virtua's initial guesses are right the first time.
 *
 * WHICH CONSUMER ACTUALLY NEEDS THE VIRTUAL TIER — they are not symmetric, and it would be easy
 * to assume they are:
 *  - The TASK Commits tab is why this exists. `collectRunCommits` (src/server/git-changes.ts)
 *    runs `git log <merge-base>..HEAD` with NO cap, and cezar autosaves a commit per turn, so a
 *    long-running task genuinely reaches hundreds of rows.
 *  - The REPO Commits segment cannot reach the threshold today: `getLog` (src/server/git.ts)
 *    defaults to 20 and `server.ts` calls it without a count, so that list is 20 rows, full
 *    stop. It shares this component for one renderer rather than two, and for the flat tier's
 *    `content-visibility` — not because 20 rows need windowing. If that cap is ever lifted,
 *    this is already correct; until then, don't read the virtual branch as protecting it.
 */

/** Commit rows past which the list goes through virtua. */
export const COMMIT_VIRTUALIZE_THRESHOLD = 150

/** Desktop history-row estimate. Virtua measures expanded mobile rows after mounting. */
const ROW_HEIGHT_PX = 77

export interface CommitListItem {
  sha: string
  subject: string
  author: string
  when: string
  /** Where the row links to — the two consumers have different route prefixes. */
  href: string
  /** The sha as displayed; the task list abbreviates, the repo log is already short. */
  shaLabel: string
}

export function CommitList({ slot, commits, className, heading }: { slot: string; commits: CommitListItem[]; className?: string; heading?: ReactNode }) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery ? commits.filter(commit => commit.subject.toLowerCase().includes(normalizedQuery)) : commits
  const virtual = filtered.length > COMMIT_VIRTUALIZE_THRESHOLD
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollElRef = useRef<HTMLElement | null>(null)

  // Same measured `startMargin` as the thread and the diff: the distance from the shell
  // scroller's content start down to this list (headers, toolbars). See diff-view.tsx.
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    if (!virtual) return
    const measure = () => {
      const container = containerRef.current
      const scroller = scrollElRef.current
      if (!container || !scroller) return
      setStartMargin(
        Math.max(
          0,
          Math.round(
            container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
          ),
        ),
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [virtual])

  const rows = filtered.map((commit) => <CommitRow key={commit.sha} commit={commit} detailed={slot === 'task-commits' && commits.length === 1} />)

  return (
    <>
      <label className="relative mb-[22px] block">
        <SearchIcon size={16} aria-hidden="true" className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
        <Input aria-label="Search commit messages" placeholder="Search commit messages…" value={query} onChange={event => setQuery(event.target.value)} className="h-11 bg-card pl-10" />
      </label>
      <div
        ref={(el) => {
          containerRef.current = el
          if (el) scrollElRef.current = el.closest<HTMLElement>('[data-slot="main"]')
        }}
        data-slot={slot}
        data-virtualized={virtual}
        className={cn('flex flex-col divide-y divide-border rounded-xl border border-border bg-card px-4 py-1 md:px-5', className)}
      >
        {heading ? <div className="flex min-h-14 flex-wrap items-center gap-2 py-4">{heading}</div> : null}
        {filtered.length === 0 ? <p role="status" className="py-5 text-sm text-muted-foreground">No loaded commits match your search.</p> : null}
        {virtual ? (
          // No `shift`: commit logs are newest-first and only ever grow at the start on a
          // refetch that REPLACES the list, so there is no prepend to anchor against.
          <Virtualizer scrollRef={scrollElRef} startMargin={startMargin} itemSize={ROW_HEIGHT_PX}>
            {rows}
          </Virtualizer>
        ) : (
          rows
        )}
      </div>
    </>
  )
}

function CommitRow({ commit, detailed }: { commit: CommitListItem; detailed: boolean }) {
  return (
    // Not a <ul>/<li>: virtua inserts its own positioned wrapper between the list and the
    // items, which would break that parent/child contract. A plain list of links reads the
    // same to a screen reader here — each row's accessible name is its own link text.
    <div className="[contain-intrinsic-block-size:auto_77px] [content-visibility:auto]">
      <Link
        data-slot="commit-row"
        data-sha={commit.sha}
        to={commit.href}
        className={cn("flex min-h-[76px] min-w-0 flex-col items-start gap-3 rounded-sm py-4 hover:bg-muted", !detailed && "md:flex-row md:items-center md:py-3")}
      >
        <GitCommitHorizontalIcon size={16} aria-hidden="true" className={cn("shrink-0 text-accent-text", detailed ? "size-[22px]" : "size-4")} />
        <span className={cn("min-w-0 w-full", !detailed && "md:w-auto md:flex-1")}>
          <span className={cn("block font-normal", detailed ? "text-[22px] leading-snug" : "text-[13px] md:truncate")}>{commit.subject}</span>
          <span className="mt-1 block truncate text-[11px] text-soft-foreground">
            {commit.author} · {commit.when}
          </span>
        </span>
        <span className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">{commit.shaLabel}</span>
        {detailed ? <span className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-action px-3 text-xs font-medium text-action-foreground"><FileDiffIcon size={16} aria-hidden="true" className="size-4" />View changes</span> : null}
      </Link>
    </div>
  )
}
