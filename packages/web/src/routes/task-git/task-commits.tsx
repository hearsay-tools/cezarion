import { FileCodeIcon, GitCommitHorizontalIcon } from '@/components/design-icons'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { ApiError } from '@/api/client'
import { useRun, useRunChanges, useRunCommit, useRunCommits } from '@/api/queries'
import type { ApiRun, RunCommit } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CommitDiffPanel } from '@/components/diff/commit-diff-panel'

import { engineOwnsRun } from '@open-mercato/cezar-api-client/contract/run-predicates'
import { RunHeader } from '../task-thread/run-header'
import { CommitList } from './commit-list'
import { GitTabLoadError, GitTabLoading } from './git-tab-loading'

/**
 * `/tasks/:id/commits` — the run's own commits (`<base>..HEAD`), each opening its structured diff
 * at `/tasks/:id/commits/:sha` through the SAME `<Diff>` facade the Changes tab and repo commit
 * view use. Mirrors the repo Commits segment, scoped to the task worktree.
 */
export function TaskCommitsRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="changes" />
  if (run.isError) return <GitTabLoadError tab="changes" error={run.error} />
  return <CommitsView run={run.data} />
}

function CommitsView({ run }: { run: ApiRun }) {
  const { sha } = useParams<{ sha: string }>()
  const commits = useRunCommits(run.id, engineOwnsRun(run))

  return (
    <div data-route="task-commits" className="flex min-h-full flex-col">
      <RunHeader run={run} tab="commits" />
      {sha ? (
        <CommitDiffView runId={run.id} sha={sha} />
      ) : commits.isPending ? (
        <p data-slot="commits-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading commits…
        </p>
      ) : commits.isError ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon size={16} />}
          tone={commits.error instanceof ApiError && commits.error.status === 409 ? 'neutral' : 'danger'}
          heading="h2"
          title={
            commits.error instanceof ApiError && commits.error.status === 409
              ? 'No commits to show'
              : 'Could not load the commits'
          }
          subtitle={commits.error.message}
        />
      ) : commits.data.commits.length === 0 ? (
        <CenteredState
          icon={<GitCommitHorizontalIcon size={16} />}
          tone="neutral"
          heading="h2"
          title="No commits yet"
          subtitle="This task hasn't committed anything on its branch. Autosave commits and any the agent makes appear here."
        />
      ) : (
        <div className="px-[18px] py-[22px] md:px-9">
          <CommitList
            slot="task-commits"
            heading={<h2 className="text-base font-semibold">{commits.data.commits.length} {commits.data.commits.length === 1 ? 'commit' : 'commits'} in this task</h2>}
            className="w-full"
            commits={commits.data.commits.map((commit: RunCommit) => ({
              ...commit,
              shaLabel: commit.sha.slice(0, 8),
              href: `/tasks/${run.id}/commits/${commit.sha}`,
            }))}
          />
          <TaskChangedFiles run={run} />
        </div>
      )}
    </div>
  )
}

function CommitDiffView({ runId, sha }: { runId: string; sha: string }) {
  const commit = useRunCommit(runId, sha)

  return (
    <CommitDiffPanel
      commit={commit}
      sha={sha}
      backTo={`/tasks/${runId}/commits`}
      backLabel="All commits"
      slot="task-commit"
      className="mx-auto flex min-h-0 w-full max-w-[var(--measure)] flex-1 flex-col"
      diffClassName="px-4 py-4 [--diff-sticky-top:0px] md:[--diff-sticky-top:1rem] md:px-6"
    />
  )
}

/** Reuses the task diff payload; paths lead to the existing structured Changes view. */
function TaskChangedFiles({ run }: { run: ApiRun }) {
  const changes = useRunChanges(run.id, engineOwnsRun(run))
  if (changes.isPending) return <p className="mt-[22px] text-xs text-muted-foreground">Loading changed files…</p>
  if (changes.isError) return <p role="status" className="mt-[22px] text-xs text-danger">Could not load changed files: {changes.error.message}</p>
  if (changes.data.files.length === 0) return null
  return <section data-slot="task-commit-files" className="mt-[22px] rounded-[10px] border border-border bg-card p-5">
    <h2 className="mb-4 text-[16px] font-semibold">{changes.data.files.length} changed files</h2>
    <ul className="space-y-4">
      {changes.data.files.map(file => <li key={file.path}>
        <Link to={`/tasks/${run.id}/changes`} className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <FileCodeIcon size={16} aria-hidden="true" className="size-[15px] shrink-0" /><span className="break-all">{file.path}</span>
        </Link>
      </li>)}
    </ul>
  </section>
}
