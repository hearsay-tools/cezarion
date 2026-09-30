import { SearchXIcon } from 'lucide-react'
import { ArrowLeftIcon, GitCommitHorizontalIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRepoCommit } from '@/api/queries'
import type { LogEntry } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { useIsDesktop } from '@/lib/use-desktop'

import { DiffViewToggles } from '../task-git/diff-controls'

import { GIT_PHONE_MAIN_PATH, groupCommitsByDay, shortGitAge } from './git-sections'

/**
 * Recently on main (issue 06 §3): the recent-commit log `GET /api/repo` already carries, grouped
 * by day, each 52px row (subject, then `sha · author · age`) deep-linking to `/git/commits/:sha`,
 * where the structured commit diff renders through the same `<Diff>` facade as everything else.
 * The task/PR source on each commit is issue 08. Same mobile rule: unified+wrap forced below `md`.
 */
export function RepoCommitsSection({ log }: { log: LogEntry[] }) {
  const { sha } = useParams<{ sha: string }>()
  const days = useMemo(() => groupCommitsByDay(log), [log])
  if (sha) return <CommitDiffView sha={sha} />

  if (log.length === 0) {
    return (
      <CenteredState
        icon={<GitCommitHorizontalIcon size={16} />}
        tone="neutral"
        heading="h2"
        title="No commits yet"
        subtitle="The log is empty — this repository has no commits to show."
      />
    )
  }
  return (
    <div data-slot="repo-commits" className="flex flex-col gap-[2px] px-[8px] pt-[12px] pb-[20px] md:px-[20px]">
      {days.map((day) => (
        <section key={day.label} data-slot="repo-commit-day" aria-label={day.label} className="flex flex-col">
          <h2 className="px-[10px] pt-[14px] pb-[4px] text-[11px] font-medium text-soft-foreground">{day.label}</h2>
          <ul className="flex flex-col">
            {day.commits.map((commit) => (
              <li key={commit.hash}>
                <Link
                  to={`/git/commits/${commit.hash}`}
                  data-slot="commit-row"
                  data-sha={commit.hash}
                  className="flex min-h-[52px] flex-col justify-center gap-[3px] rounded-[6px] px-[10px] py-[6px] hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span data-slot="commit-subject" className="truncate text-[13px] text-foreground">{commit.subject}</span>
                  <span data-slot="commit-meta" className="flex min-w-0 items-center gap-[6px] text-[11px] text-soft-foreground">
                    <span className="shrink-0 font-mono">{commit.hash}</span>
                    <span className="truncate">· {commit.author} · {shortGitAge(commit.when)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
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
