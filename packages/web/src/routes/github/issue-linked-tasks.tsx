import { useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { queryScope } from '@open-mercato/cezar-api-client'

import { useArchivedRuns, useProjectRuns } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { runTitle, withArchivedPages } from '@/lib/task-groups'
import { linkedIssueTasks } from './github-sidebar-model'

/** Shares the project runs cache with the sidebar and its existing live updates. */
export function IssueLinkedTasks({ number, repo }: { number: number; repo?: string }) {
  const scope = queryScope()
  // Reset disclosure state on identity changes without interrupting the shared query cache.
  return <LinkedTasks key={JSON.stringify([scope, repo, number])} number={number} repo={repo} scope={scope} />
}

function LinkedTasks({ number, repo, scope }: { number: number; repo?: string; scope: string }) {
  const headingId = useId()
  const contentId = useId()
  const [expanded, setExpanded] = useState(false)
  const Chevron = expanded ? ChevronDown : ChevronRight
  const query = useProjectRuns(scope, true, scope === 'default')
  // The run list carries only the newest archived tasks (#864), so an issue's older, archived
  // tasks come from the server's search for its number. The list's own row wins a duplicate.
  const archived = useArchivedRuns(`#${number}`, true)
  const tasks = useMemo(
    () => linkedIssueTasks(withArchivedPages(query.data ?? [], archived.data?.pages.flatMap((page) => page.runs) ?? []), number, repo, scope),
    [query.data, archived.data, number, repo, scope],
  )
  return (
    <section aria-labelledby={headingId} className="mt-4 min-w-0 rounded-lg border border-border p-3">
      <h3 id={headingId} className="text-xs font-semibold text-muted-foreground">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Chevron aria-hidden="true" className="size-4 shrink-0" />
          {/* `+` while the server has older archived matches this list has not paged in yet. */}
          <span>Linked tasks{query.data ? ` (${tasks.length}${archived.hasNextPage ? '+' : ''})` : ''}</span>
        </button>
      </h3>
      <div id={contentId}>
        {expanded ? <>
          {query.isPending ? <p role="status" className="mt-2 text-xs text-muted-foreground">Loading linked tasks…</p> : null}
          {query.isError ? (
            <div className="mt-2 text-xs text-muted-foreground">
              <p role="status">Couldn’t load linked tasks. Check your connection and try again.</p>
              <Button variant="outline" className="mt-2 min-h-11" onClick={() => void query.refetch()} disabled={query.isFetching}>
                Retry linked tasks
              </Button>
            </div>
          ) : null}
          {query.data && tasks.length === 0 && !query.isError ? (
            <p className="mt-2 text-xs text-muted-foreground">No linked tasks yet.</p>
          ) : null}
          {tasks.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {tasks.map((task) => {
                const attention = deriveAttention(task)
                return (
                  <li key={task.id}>
                    <Link
                      to={`/tasks/${encodeURIComponent(task.id)}`}
                      className="flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-md px-2 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className="text-sm font-medium break-words [overflow-wrap:anywhere]">{runTitle(task)}</span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <StatusDot tone={attention.tone} shape={attention.shape} pulse={attention.pulse} role="img" aria-label={attention.label} title={attention.label} />
                        {task.archived ? <span className="rounded border border-border px-1">Archived</span> : null}
                        <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleDateString()}</time>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {archived.hasNextPage ? (
            <Button variant="outline" className="mt-2 min-h-11" onClick={() => void archived.fetchNextPage()} disabled={archived.isFetchingNextPage}>
              {archived.isFetchingNextPage ? 'Loading older linked tasks…' : 'Show older linked tasks'}
            </Button>
          ) : null}
        </> : null}
      </div>
    </section>
  )
}
