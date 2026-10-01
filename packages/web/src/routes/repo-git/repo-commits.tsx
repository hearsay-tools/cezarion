import { ArrowDownToLineIcon, LoaderCircleIcon, SearchXIcon } from 'lucide-react'
import { ArrowDownIcon, ArrowLeftIcon, BotIcon, GitCommitHorizontalIcon, GitMergeIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useMemo, useRef, useState } from 'react'
import { queryScope } from '@open-mercato/cezar-api-client'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRepoCommit } from '@/api/queries'
import type { LogEntry, RepoInfo, RepoResponse, RepoTracking } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { useIsDesktop } from '@/lib/use-desktop'
import { cn } from '@/lib/utils'

import { DiffViewToggles } from '../task-git/diff-controls'

import { PullConfirmDialog } from './git-checkout-block'
import { checkoutTracking, GIT_PHONE_MAIN_PATH, groupCommitsByDay, shortGitAge } from './git-sections'
import { useGitCheckout } from './use-git-checkout'

/**
 * Recently on main (issue 06 §3, issue 08 §C): the recent-commit log `GET /api/repo` carries,
 * grouped by the commit's own day (`at`), each 52px row (subject, then `sha · author · age`)
 * deep-linking to `/git/commits/:sha`, where the structured commit diff renders through the same
 * `<Diff>` facade as everything else. A row names where the commit came from when the server knows
 * (`source`: the PR and the task, linking to the task) and says "no task found" when it does
 * not. When the base is behind its upstream, an Incoming bar offers the pull first. Same mobile
 * rule: unified+wrap forced below `md`.
 */
export function RepoCommitsSection({ repo, info }: { repo: RepoResponse; info: RepoInfo }) {
  const { sha } = useParams<{ sha: string }>()
  const log = repo.log
  const days = useMemo(() => groupCommitsByDay(log), [log])
  if (sha) return <CommitDiffView sha={sha} />

  const tracking = checkoutTracking(repo, info)
  const incoming = tracking && tracking.behind > 0 ? <IncomingBar info={info} tracking={tracking} /> : null
  if (log.length === 0) {
    return (
      <>
        {incoming ? <div className="px-[8px] pt-[12px] md:px-[20px]">{incoming}</div> : null}
        <CenteredState
          icon={<GitCommitHorizontalIcon size={16} />}
          tone="neutral"
          heading="h2"
          title="No commits yet"
          subtitle="The log is empty — this repository has no commits to show."
        />
      </>
    )
  }
  return (
    <div data-slot="repo-commits" className="flex flex-col gap-[2px] px-[8px] pt-[12px] pb-[20px] md:px-[20px]">
      {incoming}
      {days.map((day) => (
        <section key={day.label} data-slot="repo-commit-day" aria-label={day.label} className="flex flex-col">
          <h2 className="px-[10px] pt-[14px] pb-[4px] text-[11px] font-medium text-soft-foreground">{day.label}</h2>
          <ul className="flex flex-col">
            {day.commits.map((commit) => (
              <li key={commit.hash} className="flex min-h-[52px] items-center gap-[14px] rounded-[6px] hover:bg-sidebar-row-hover">
                <Link
                  to={`/git/commits/${commit.hash}`}
                  data-slot="commit-row"
                  data-sha={commit.hash}
                  className="flex min-h-[52px] min-w-0 flex-1 flex-col justify-center gap-[3px] rounded-[6px] px-[10px] py-[6px] focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span data-slot="commit-row-subject" className="truncate text-[13px] text-foreground">{commit.subject}</span>
                  <span data-slot="commit-row-meta" className="flex min-w-0 items-center gap-[6px] text-[11px] text-soft-foreground">
                    <span className="shrink-0 font-mono">{commit.hash}</span>
                    <span className="truncate">· {commit.author} · {shortGitAge(commit.when)}</span>
                  </span>
                </Link>
                <CommitSource source={commit.source} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** `⑂ PR #698 🤖 Picker pill prefixes`, linking to the task; `no task found` otherwise. An absent
 *  `source` only means `attributeLog`'s best-effort match found no run (a cherry-pick, a merge
 *  subject it does not recognise), never that a person wrote the commit, so it claims nothing about
 *  authorship. Hidden below `md`, where the row has no room beside its subject. */
function CommitSource({ source }: { source: LogEntry['source'] }) {
  const cell = 'hidden max-w-[45%] shrink-0 items-center gap-[5px] pr-[10px] text-[11.5px] text-soft-foreground md:flex'
  if (!source) {
    return (
      <span data-slot="commit-source" data-source="unknown" className={cell}>
        no task found
      </span>
    )
  }
  return (
    <Link
      to={`/tasks/${source.runId}`}
      data-slot="commit-source"
      data-source="task"
      aria-label={`From the task ${source.title}${source.prNumber !== null ? `, pull request #${source.prNumber}` : ''}`}
      className={cn(cell, 'rounded-[4px] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring')}
    >
      {source.prNumber !== null ? (
        <>
          <GitMergeIcon aria-hidden="true" className="size-[11px] shrink-0 text-merged-text" />
          <span className="shrink-0 text-muted-foreground">PR #{source.prNumber}</span>
        </>
      ) : null}
      <BotIcon aria-hidden="true" className="size-[12px] shrink-0" />
      <span className="min-w-0 truncate">{source.title}</span>
    </Link>
  )
}

/** "2 commits on origin/main are not in your checkout yet" + Pull (issue 08 §C), as of the last
 *  fetch. Pulls the checked-out branch through the same hook and confirmation as the checkout block,
 *  so it only renders while the base IS the checked-out branch (`checkoutTracking`). */
function IncomingBar({ info, tracking }: { info: RepoInfo; tracking: RepoTracking }) {
  const checkout = useGitCheckout(queryScope(), info)
  const pullRef = useRef<HTMLButtonElement>(null)
  return (
    <div data-slot="git-incoming" className="mb-[4px] flex min-h-[40px] items-center gap-[8px] rounded-[8px] border border-border px-[10px] py-[6px]">
      <ArrowDownToLineIcon aria-hidden="true" className="size-[14px] shrink-0 text-inbox-count-foreground" />
      <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
        {tracking.behind} commit{tracking.behind === 1 ? '' : 's'} on {tracking.ref} {tracking.behind === 1 ? 'is' : 'are'} not in your checkout yet
      </span>
      <button
        ref={pullRef}
        type="button"
        data-action="repo-pull-incoming"
        disabled={!checkout.hasRemote || checkout.pulling}
        onClick={() => void checkout.pull()}
        className="inline-flex h-[26px] shrink-0 items-center gap-[4px] rounded-[6px] bg-muted px-[10px] text-[12px] font-medium text-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 max-md:h-11 [&>svg]:size-[12px]"
      >
        {checkout.pulling ? <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" /> : <ArrowDownIcon aria-hidden="true" />}
        Pull
      </button>
      <PullConfirmDialog checkout={checkout} returnFocus={pullRef} />
    </div>
  )
}

function CommitDiffView({ sha }: { sha: string }) {
  const commit = useRepoCommit(sha)
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)

  // 409 = the server's answer (unknown sha, not a hash) — a dead link, not an outage.
  const refused = commit.isError && commit.error instanceof ApiError && commit.error.status === 409

  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  return (
    <section data-slot="repo-commit" data-sha={sha} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-2 md:px-6">
        <Button asChild variant="ghost" size="sm" data-slot="commit-back">
          <Link to={desktop ? '/git' : GIT_PHONE_MAIN_PATH}>
            <ArrowLeftIcon size={16} aria-hidden="true" />
            All recent commits
          </Link>
        </Button>
        {commit.data ? <DiffStatLabel stat={commit.data.stat} /> : null}
        <span className="ml-auto hidden items-center gap-1 md:flex">
          <DiffViewToggles mode={mode} wrap={wrap} onModeChange={setMode} onWrapChange={setWrap} />
        </span>
      </div>

      {commit.isPending ? (
        <p data-slot="commit-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading commit…
        </p>
      ) : commit.isError ? (
        <CenteredState
          icon={refused ? <SearchXIcon /> : <TriangleAlertIcon size={16} />}
          tone={refused ? 'neutral' : 'danger'}
          heading="h2"
          title={refused ? 'Commit not found' : 'Could not load the commit'}
          subtitle={commit.error.message}
        />
      ) : (
        <>
          <div data-slot="commit-meta" className="border-b border-border px-4 py-3 md:px-6">
            <h2 className="text-sm font-semibold">{commit.data.subject}</h2>
            <p className="mt-0.5 text-[11px] text-soft-foreground">
              {commit.data.author} · {commit.data.when} ·{' '}
              <span className="font-mono select-all">{commit.data.sha}</span>
            </p>
          </div>
          {commit.data.files.length === 0 ? (
            <CenteredState
              icon={<GitCommitHorizontalIcon size={16} />}
              tone="neutral"
              heading="h2"
              title="No file changes"
              subtitle="This commit carries no diff of its own — a merge commit's changes live on the commits it merged."
            />
          ) : (
            <div className="px-4 py-4 [--diff-sticky-top:1rem] md:px-6">
              <Diff files={commit.data.files} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
