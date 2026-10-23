import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon } from 'lucide-react'
import { useParams } from 'react-router'

import { ApiError } from '@/api/client'
import { queryKeys, useGroup, useRuns } from '@/api/queries'
import { Link } from '@/lib/project-router'
import { deriveAttention } from '@/lib/attention'
import { groupTitle } from '@/lib/task-groups'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { CompareLoading } from './compare-loading'
import './task-flows.css'

/** Old comparison bookmarks remain a read-only route into retained task history. */
export function RetainedVariantsRoute() {
  const { groupId } = useParams<{ groupId: string }>()
  const group = useGroup(groupId)
  const runs = useRuns()
  const queryClient = useQueryClient()
  const memberStates = (runs.data ?? []).filter(run => run.groupId === groupId)
    .map(run => `${run.id}:${run.status}:${run.archived}`).sort().join(',')
  useEffect(() => {
    if (groupId) void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(groupId) })
  }, [queryClient, groupId, memberStates])

  if (group.isPending) return <CompareLoading />
  if (group.isError) {
    const missing = group.error instanceof ApiError && group.error.status === 404
    return (
      <div data-route="compare" className="task-flow-page flex min-h-full flex-col">
        <CenteredState
          icon={<ArchiveIcon />}
          tone={missing ? 'neutral' : 'danger'}
          title={missing ? 'No retained results for this group' : 'Could not load retained results'}
          subtitle={missing
            ? 'Parallel variants are removed. No retained tasks match this link. Open Tasks to find individual results, or start a task that compares approaches with owned workers.'
            : group.error.message}
          actions={<div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className="min-h-11"><Link to="/">Back to tasks</Link></Button>
            {!missing ? <Button variant="outline" className="min-h-11" onClick={() => void group.refetch()}>Retry</Button> : null}
          </div>}
        />
      </div>
    )
  }

  return (
    <div data-route="compare" className="task-flow-page flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Retained results</h1>
        <p className="text-sm text-muted-foreground">Parallel variants are removed. These tasks remain available. Open each task to read its transcript, diff and commits.</p>
        <p className="text-sm text-muted-foreground">For new comparisons, ask a task to spawn owned workers, collect their results and compare their diffs. Choose and integrate commits explicitly, then destroy the workers. There is no automatic winner selection or cleanup.</p>
      </header>
      <section aria-label="Retained tasks" className="flex min-w-0 flex-col gap-3">
        {group.data.runs.map(run => (
          <article key={run.id} data-slot="retained-variant" className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1 wrap-anywhere">
              <h2 className="font-medium">{groupTitle(run)} · {run.variant}</h2>
              <p className="text-sm text-muted-foreground">{deriveAttention(run).label}{run.archived ? ' · archived' : ''}</p>
            </div>
            <Button asChild variant="outline" className="min-h-11"><Link to={`/tasks/${run.id}`}>Open task {run.variant}</Link></Button>
          </article>
        ))}
      </section>
      <Button asChild variant="outline" className="min-h-11 self-start"><Link to="/">Back to tasks</Link></Button>
    </div>
  )
}
