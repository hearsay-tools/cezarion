import { useId, useMemo } from 'react'
import { queryScope } from '@open-mercato/cezar-api-client'

import { useProjectRuns } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { runTitle } from '@/lib/task-groups'
import { linkedIssueTasks } from './github-sidebar-model'

/** Shares the project runs cache with the sidebar and its existing live updates. */
export function IssueLinkedTasks({ number, repo }: { number: number; repo?: string }) {
  const headingId = useId()
  const scope = queryScope()
  const query = useProjectRuns(scope, true, scope === 'default')
  const tasks = useMemo(
    () => linkedIssueTasks(query.data ?? [], number, repo, scope),
    [query.data, number, repo, scope],
  )
  return (
    <section aria-labelledby={headingId} className="mt-4 min-w-0 rounded-lg border border-border p-3">
      <h3 id={headingId} className="text-xs font-semibold text-muted-foreground">
        Linked tasks{query.data ? ` (${tasks.length})` : ''}
      </h3>
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
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                to={`/tasks/${encodeURIComponent(task.id)}`}
                className="flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-md px-2 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="text-sm font-medium break-words [overflow-wrap:anywhere]">{runTitle(task)}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>{task.status}</span>
                  {task.archived ? <span className="rounded border border-border px-1">Archived</span> : null}
                  <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleDateString()}</time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
