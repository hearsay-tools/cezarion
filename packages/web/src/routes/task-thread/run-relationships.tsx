import { useId, useState } from 'react'
import { BotIcon, ChevronDownIcon, GitBranchIcon } from '@/components/design-icons'
import { useIsDesktop } from '@/lib/use-desktop'
import { runTitle } from '@/lib/task-groups'
import type { ApiRun, WorkerDestroy } from '@open-mercato/cezar-api-client'
import { useRun, useRunRelationships, useRuns } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'

const linkClass = 'flex min-h-11 min-w-0 items-center rounded-md px-2 text-sm text-foreground hover:bg-muted break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** Ordinary records mount no query and retain their existing header. */
export function RunRelationshipsPanel({ run }: { run: ApiRun }) {
  if (!run.delegation || run.delegation.role === 'invalid') return null
  return <Relationships run={run} />
}

function Relationships({ run }: { run: ApiRun }) {
  const query = useRunRelationships(run.id)
  const desktop = useIsDesktop()
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const expanded = desktop || expandedRun === run.id
  const navigationId = useId()
  const runs = useRuns()
  const metadata = run.delegation
  const parentId = metadata?.role === 'worker' ? metadata.parentRunId : query.data?.parentRunId
  const knownIds = metadata?.role === 'root' ? metadata.receipts.map(receipt => receipt.workerId) : []
  const workers = new Map(query.data?.workers.map(worker => [worker.workerId, worker]))
  const ids = [...new Set([...knownIds, ...workers.keys()])].slice(0, 32)
  const wait = metadata && metadata.role !== 'invalid' ? metadata.wait : undefined
  return (
    <section aria-label="Task relationships" className="min-w-0 border-t border-border py-2 text-sm text-muted-foreground">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 text-left text-xs md:hidden"
        aria-expanded={expanded}
        aria-controls={navigationId}
        onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
      >
        <GitBranchIcon aria-hidden="true" className="size-4 text-accent-text" />
        {metadata?.role === 'worker' ? 'Worker session' : 'Parent'}
        <BotIcon aria-hidden="true" className="ml-1 size-4" />
        {metadata?.role === 'worker' ? 'Parent & workers' : ids.length > 0 ? `Workers ${ids.length}` : query.isSuccess ? 'Workers 0' : query.isError ? 'Workers unavailable' : 'Workers…'}
        <ChevronDownIcon aria-hidden="true" className={`ml-auto size-4 ${expanded ? 'rotate-180' : ''}`} />
      </button>
        {metadata?.role === 'worker' && metadata.destroy ? <Cleanup state={metadata.destroy} /> : null}
        {wait ? <p className="px-2 break-words">
          {wait.requestIds ? (wait.phase === 'parked' ? 'Waiting on request replies' : wait.phase === 'wake-pending'
            ? 'Conversation update queued for this task' : 'Request wait registered — the agent is finishing its turn')
            : wait.phase === 'parked' ? 'Waiting on workers' : wait.phase === 'wake-pending'
            ? 'Worker update queued for the parent' : 'Worker wait registered — the agent is finishing its turn'}.
          {' '}Deadline: <time dateTime={wait.deadline}>{wait.deadline}</time>
        </p> : null}
      <div id={navigationId} hidden={!expanded}>
        {parentId ? <ParentLink id={parentId} /> : null}
        {ids.length > 0 ? (
          <ul className="grid max-h-64 min-w-0 gap-1 overflow-y-auto">
            {ids.map(id => {
              const worker = workers.get(id)
              const record = runs.data?.find(candidate => candidate.id === id)
              return <li key={id} className="min-w-0 rounded-md bg-muted/40 px-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <Link to={`/tasks/${id}`} aria-label={`Worker task ${id}`} className={linkClass}>{record ? runTitle(record) : `Worker ${id.slice(0, 8)}`}</Link>
                  <span className="px-2 text-xs">{worker?.status ?? (query.isSuccess ? 'Record unavailable or deleted' : 'Status unavailable')}</span>
                </div>
                {worker?.destroy ? <Cleanup state={worker.destroy} /> : null}
              </li>
            })}
          </ul>
        ) : metadata?.role === 'root' && query.isSuccess ? <p className="px-2">No workers</p> : null}
        {query.fetchStatus === 'paused' ? <p role="status" className="px-2">Offline — relationship details will refresh when connected.</p>
          : query.isPending ? <p role="status" className="px-2">Loading relationships…</p> : null}
        {query.isError ? <div className="flex flex-wrap items-center gap-2 px-2">
          <p role="status">Could not load relationships. Known task links are retained.</p>
          <Button variant="outline" className="min-h-11" onClick={() => void query.refetch()}>Retry relationships</Button>
        </div> : null}
      </div>
    </section>
  )
}

function ParentLink({ id }: { id: string }) {
  const parent = useRun(id)
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2">
    <Link to={`/tasks/${id}`} aria-label={`Parent task ${id}`} className={linkClass}>{parent.data ? `Parent · ${runTitle(parent.data)}` : `Parent task ${id}`}</Link>
    {parent.isError ? <>
      <span className="px-2 text-xs">Parent record unavailable or deleted</span>
      <Button variant="outline" className="min-h-11" onClick={() => void parent.refetch()}>Retry parent task</Button>
    </> : null}
  </div>
}

function Cleanup({ state }: { state: WorkerDestroy }) {
  return <p className="px-2 pb-2 break-words">
    {state.phase === 'incomplete' ? 'Cleanup incomplete' : state.phase === 'complete' ? 'Cleanup complete' : `Cleanup ${state.phase}`}
    {state.remaining.length ? ` — remaining: ${state.remaining.join(', ')}` : ''}
    {state.error ? ` — ${state.error}` : ''}
  </p>
}
