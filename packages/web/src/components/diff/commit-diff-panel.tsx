import { SearchXIcon } from 'lucide-react'
import { ArrowLeftIcon, GitCommitHorizontalIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { RepoCommitPayload } from '@open-mercato/cezar-api-client'

import { ApiError } from '@/api/client'
import { CenteredState } from '@/components/centered-state'
import { Diff, type DiffMode } from '@/components/diff'
import { DiffStatLabel } from '@/components/diff-stat'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { useIsDesktop } from '@/lib/use-desktop'
import { DiffViewToggles } from '@/routes/task-git/diff-controls'

type CommitDiffPanelProps = {
  commit: UseQueryResult<RepoCommitPayload, Error>
  sha: string
  backTo: string
  backLabel: string
  slot: string
  className: string
  diffClassName: string
}

export function CommitDiffPanel({ commit, sha, backTo, backLabel, slot, className, diffClassName }: CommitDiffPanelProps) {
  const desktop = useIsDesktop()
  const [mode, setMode] = useState<DiffMode>('unified')
  const [wrap, setWrap] = useState(false)

  // 409 = the server's answer (unknown sha, not a hash) — a dead link, not an outage.
  const refused = commit.isError && commit.error instanceof ApiError && commit.error.status === 409

  const effectiveMode: DiffMode = desktop ? mode : 'unified'
  const effectiveWrap = desktop ? wrap : true

  return (
    <section data-slot={slot} data-sha={sha} className={className}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-2 md:px-6">
        <Button asChild variant="ghost" size="sm" data-slot="commit-back">
          <Link to={backTo}>
            <ArrowLeftIcon size={16} aria-hidden="true" />
            {backLabel}
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
            <div className={diffClassName}>
              <Diff files={commit.data.files} mode={effectiveMode} wrap={effectiveWrap} className="min-w-0" />
            </div>
          )}
        </>
      )}
    </section>
  )
}
