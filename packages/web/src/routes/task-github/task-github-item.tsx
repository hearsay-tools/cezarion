import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, LinkIcon, SearchXIcon } from 'lucide-react'
import { CircleDotIcon, GitPullRequestIcon, TriangleAlertIcon } from '@/components/design-icons'
import { useParams } from 'react-router'

import { Link } from '@/lib/project-router'

import { getGithubItem } from '@/api/client'
import { queryKeys, useGithubItem, useHealth, useProjectRepoBase, useProjects, useRun } from '@/api/queries'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { GithubItemDetail } from '@/components/github-item-detail'
import { Button } from '@/components/ui/button'
import { taskItemTabs, taskReferences } from '@/lib/tasks-table'
import { isHttpUrl } from '@/lib/utils'

import { GitTabLoadError } from '../task-git/git-tab-loading'
import { RunHeader } from '../task-thread/run-header'
import { TaskGithubItemLoading } from './task-github-loading'

const KIND_LABEL = { issue: 'Issue', pr: 'Pull request' } as const

/**
 * `/tasks/:id/issue/:n` and `/tasks/:id/pr/:n` (spec #692) — one of the task's linked issues or
 * PRs, read in place: the run header with that item's tab active, then the same detail the GitHub
 * view shows, minus its list chrome (no back link, no Conversation/Changes sub-nav).
 *
 * Only a number the task is linked to is fetched. `taskItemTabs` is the same list the header's
 * tabs come from, so a hand-typed `/pr/99` cannot turn the task page into a viewer for any PR of
 * the repository — and cannot ask GitHub about it either.
 */
export function TaskGithubItemRoute({ kind }: { kind: 'issue' | 'pr' }) {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <TaskGithubItemLoading kind={kind} />
  if (run.isError) return <GitTabLoadError tab="github-item" error={run.error} />
  return <ItemView run={run.data} kind={kind} />
}

function ItemView({ run, kind }: { run: ApiRun; kind: 'issue' | 'pr' }) {
  const { n } = useParams<{ n: string }>()
  const number = Number(n)
  const repoBase = useProjectRepoBase()
  // `repoBase` decides which URL references count as own. Until the registry and health have
  // answered it is unknown, and judging "not linked" then would flash a refusal for a real tab.
  const settling = useProjects().isPending || useHealth().isPending
  const linked = taskItemTabs(run, repoBase).some((tab) => tab.kind === kind && tab.number === number)
  const item = useGithubItem(kind, number, linked)

  return (
    <div data-route="task-github-item" className="flex min-h-full flex-col">
      <RunHeader run={run} tab={{ kind, number }} />
      {linked ? (
        <ItemBody run={run} kind={kind} number={number} repoBase={repoBase} item={item} />
      ) : settling ? (
        <TaskGithubItemLoading kind={kind} number={number} heading="h2" />
      ) : (
        <CenteredState
          icon={<LinkIcon size={16} />}
          tone="neutral"
          heading="h2"
          title={`#${n} is not linked to this task`}
          subtitle="Only the issues and pull requests this task references open here."
          actions={
            <Button asChild variant="outline">
              <Link to={`/tasks/${run.id}`}>Back to the session</Link>
            </Button>
          }
        />
      )}
    </div>
  )
}

function ItemBody({
  run,
  kind,
  number,
  repoBase,
  item,
}: {
  run: ApiRun
  kind: 'issue' | 'pr'
  number: number
  repoBase: string | undefined
  item: ReturnType<typeof useGithubItem>
}) {
  const queryClient = useQueryClient()
  // Retry asks gh again rather than the server's cache — the cached answer is what just failed.
  const retry = useMutation({
    mutationFn: () => getGithubItem(kind, number, { refresh: true }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.githubItem(kind, number), data),
  })
  const label = `${KIND_LABEL[kind]} #${number}`
  const KindIcon = kind === 'pr' ? GitPullRequestIcon : CircleDotIcon

  if (item.isPending) return <TaskGithubItemLoading kind={kind} number={number} heading="h2" />
  if (item.isError) {
    const error = retry.error ?? item.error
    return (
      <CenteredState
        icon={<TriangleAlertIcon size={16} />}
        tone="danger"
        heading="h2"
        title={`Could not load ${KIND_LABEL[kind].toLowerCase()} #${number}`}
        subtitle={error.message}
        actions={
          <Button variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
            Retry
          </Button>
        }
      />
    )
  }
  const data = item.data
  if (!data.available) {
    const url = taskReferences(run, repoBase).find(
      (reference) => (reference.kind === 'PR') === (kind === 'pr') && reference.number === number,
    )?.url
    return (
      <CenteredState
        icon={<KindIcon size={16} />}
        tone="neutral"
        heading="h2"
        title="GitHub is unavailable"
        subtitle={data.reason}
        actions={
          url && isHttpUrl(url) ? (
            <Button asChild variant="outline">
              <a href={url} target="_blank" rel="noopener noreferrer">
                open on GitHub
                <ExternalLinkIcon aria-hidden="true" />
              </a>
            </Button>
          ) : undefined
        }
      />
    )
  }
  if (!data.item) {
    return (
      <CenteredState
        icon={<SearchXIcon />}
        tone="neutral"
        heading="h2"
        title={`${label} was not found in ${repoName(repoBase)}`}
        subtitle="It may have been deleted, or the number points at a different repository."
      />
    )
  }
  return (
    // The detail's own padding is the GitHub pane's; nudged so its edge lines up with the header's.
    <div className="min-w-0 px-0.5 md:px-2">
      <GithubItemDetail item={data.item} colors={{}} backLink={null} subNav={null} />
    </div>
  )
}

/** `owner/repo` of the project's repository, for the not-found sentence. */
function repoName(repoBase: string | undefined): string {
  if (!repoBase) return 'this repository'
  try {
    return new URL(repoBase).pathname.split('/').filter(Boolean).slice(0, 2).join('/') || 'this repository'
  } catch {
    return 'this repository'
  }
}
