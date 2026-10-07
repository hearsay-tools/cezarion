import { useState } from 'react'
import { ArrowUpRightIcon, CircleCheckIcon, CircleIcon, CircleSlashIcon, CircleXIcon, GitBranchIcon } from '@/components/design-icons'
import { LoaderCircleIcon } from 'lucide-react'
import { useIsDesktop } from '@/lib/use-desktop'
import { delegationWaitLabel } from '@/lib/attention'
import { runTitle } from '@/lib/task-groups'
import type { ApiRun, RunRelationships, WorkerDestroy, WorkerInspection } from '@open-mercato/cezar-api-client'

import { useDestroyWorker, useRun, useRunRelationships, useRuns } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { relativeIn } from '@/lib/automation-format'

import { ActivityRow } from './run-activity-row'

/** The run's own delegation metadata, and the wait note's half of it — read off `ApiRun` so the
 *  Workers section and dock header never drift from whichever schema the record actually carries. */
type Delegation = NonNullable<ApiRun['delegation']>
type DelegationWait = NonNullable<Exclude<Delegation, { role: 'invalid' }>['wait']>

const linkClass = 'flex min-h-11 min-w-0 items-center rounded-md px-2 text-sm text-foreground hover:bg-muted break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** The worker ids this run is known to link, receipts first — the durable list that survives a
 *  failed or offline relationships lookup (a fetched-only list would blink the links away). */
function workerIdsOf(metadata: Delegation | undefined, data: RunRelationships | undefined): string[] {
  const known = metadata?.role === 'root' ? metadata.receipts.map(receipt => receipt.workerId) : []
  // #816: receipts are bounded by the 1,024 creation ceiling, so nothing is sliced away here.
  return [...new Set([...known, ...(data?.workers ?? []).map(worker => worker.workerId)])]
}

/**
 * The Workers section's verdict for the dock header (#402), in three values because the
 * header has three things to say:
 *
 * - `complete` — every linked worker settled well. `cancelled` counts: someone stopped that
 *   worker on purpose and the run carried on, exactly as `planCounts` leaves cancelled
 *   entries out of its total. A done parent whose only oddity was a cancelled worker used to
 *   read "In progress" forever, which is the report this split answers.
 * - `pending` — an answer is on its way: the lookup is in flight, or a worker is queued,
 *   running, waiting or parked at its review gate. Unknown is deliberately not complete;
 *   claiming it would flip the green line under the reader.
 * - `unknown` — no answer is coming: the lookup failed, or it is paused offline with nothing
 *   cached. Distinct from `pending` because nothing further arrives on its own, so a header
 *   that read "In progress" for a pending lookup would keep saying it after the run ended.
 * - `issue` — settled badly and will not change again: a worker that failed, or a receipt
 *   whose record is gone. Not complete, but not in progress either.
 *
 * It lives here because `workerIdsOf` does: receipts outlive a failed lookup, and the dock
 * must judge the same id set the section lists.
 */
export type WorkersVerdict = 'complete' | 'pending' | 'unknown' | 'issue'

export function useWorkersVerdict(run: ApiRun): WorkersVerdict {
  const metadata = run.delegation
  const delegated = metadata !== undefined && metadata.role !== 'invalid'
  const query = useRunRelationships(run.id, { enabled: delegated })
  if (!delegated || !metadata) return 'complete'
  if (!query.isSuccess) return query.isError || query.fetchStatus === 'paused' ? 'unknown' : 'pending'
  const workers = new Map(query.data.workers.map(worker => [worker.workerId, worker]))
  const verdicts = workerIdsOf(metadata, query.data).map(id => {
    const status = workers.get(id)?.status
    if (status === 'done' || status === 'cancelled') return 'complete'
    // A record that never arrived is gone for good; a live status still moves.
    if (status === undefined || status === 'failed') return 'issue'
    return 'pending'
  })
  if (verdicts.includes('pending')) return 'pending'
  return verdicts.includes('issue') ? 'issue' : 'complete'
}

/**
 * The **Workers** row of the Run activity accordion (#402, mockups `pasted-2/3.png`): relationships
 * rendered as one accordion section — `Workers · 2 linked · 1 done · 1 cancelled`, opening
 * to a row per worker with its status and a jump control to the worker task.
 *
 * It builds its own `ActivityRow` rather than handing the dock a body, because the meter in
 * the head is fetched data: only the component holding the query knows it. The dock still owns
 * the open state, so one map remembers every section of a run.
 */
export function WorkerActivitySection({ run, open, onToggle }: { run: ApiRun; open: boolean; onToggle: () => void }) {
  const query = useRunRelationships(run.id)
  const runs = useRuns()
  const desktop = useIsDesktop()
  const metadata = run.delegation
  const parentId = metadata?.role === 'worker' ? metadata.parentRunId : query.data?.parentRunId
  const workers = new Map(query.data?.workers.map(worker => [worker.workerId, worker]))
  const ids = workerIdsOf(metadata, query.data)
  const wait = metadata && metadata.role !== 'invalid' ? metadata.wait : undefined
  const dependencyLabel = delegationWaitLabel(metadata)
  return (
    <ActivityRow
      slot="workers"
      icon={<GitBranchIcon className="size-4" />}
      title="Workers"
      meta={workerMeta({ ids, workers, parentId, desktop, query })}
      open={open}
      onToggle={onToggle}
    >
      <div aria-label="Task relationships" className="min-w-0 text-[13px] text-muted-foreground" role="group">
        {metadata?.role === 'worker' && metadata.destroy ? <Cleanup state={metadata.destroy} /> : null}
        {wait ? <WaitNote wait={wait} dependencyLabel={dependencyLabel} /> : null}
        {query.data?.capacity ? <CapacityNote capacity={query.data.capacity} /> : null}
        {parentId ? <ParentLink id={parentId} /> : null}
        {ids.length > 0 ? (
          <ul className="grid max-h-64 min-w-0 gap-0.5 overflow-y-auto">
            {ids.map(id => {
              const worker = workers.get(id)
              // The run list carries only the newest archived runs (#864); the answer names the rest.
              const record = runs.data?.find(candidate => candidate.id === id) ?? query.data?.titles?.find(candidate => candidate.id === id)
              const status = worker ? workerStatusLabel(worker.status) : query.isSuccess ? 'Record unavailable or deleted' : 'Status unavailable'
              return (
                <li key={id} data-slot="worker-item" data-status={worker?.status} className="min-w-0">
                  <Link
                    to={`/tasks/${id}`}
                    aria-label={`Worker task ${id}`}
                    className="group flex min-h-11 min-w-0 items-center gap-2.5 rounded-md px-1 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <WorkerGlyph status={worker?.status} />
                    <span className="min-w-0 flex-1 truncate">{record ? runTitle(record) : `Worker ${id.slice(0, 8)}`}</span>
                    <span className={cn('max-w-[45%] shrink-0 truncate text-xs', statusTone(worker?.status))}>{status}</span>
                    <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-soft-foreground" />
                  </Link>
                  {worker ? <CleanUpWorker parentRunId={run.id} worker={worker} /> : null}
                  {worker?.destroy ? <Cleanup state={worker.destroy} /> : null}
                </li>
              )
            })}
          </ul>
        ) : metadata?.role === 'root' && query.isSuccess ? <p className="px-1 py-1">No workers</p> : null}
        {query.fetchStatus === 'paused' ? <p role="status" className="px-1 py-1">Offline — relationship details will refresh when connected.</p>
          : query.isPending ? <p role="status" className="px-1 py-1">Loading relationships…</p> : null}
        {query.isError ? <div className="flex flex-wrap items-center gap-2 px-1 py-1">
          <p role="status">Could not load relationships. Known task links are retained.</p>
          <Button variant="outline" className="min-h-11" onClick={() => void query.refetch()}>Retry relationships</Button>
        </div> : null}
      </div>
    </ActivityRow>
  )
}

/** `2 linked · 1 done · 1 cancelled` on a desktop row; the bare odometer when the row is narrow
 *  (the phone mockup shows `2 linked` alone). Zero-count outcomes are left out rather than
 *  spelled `0 failed`, and a list that has not arrived says so instead of claiming none. */
function workerMeta({
  ids,
  workers,
  parentId,
  desktop,
  query,
}: {
  ids: string[]
  workers: Map<string, WorkerInspection>
  parentId: string | undefined
  desktop: boolean
  query: { isSuccess: boolean; isError: boolean; isPending: boolean }
}): string {
  if (ids.length === 0) {
    if (query.isError) return 'Unavailable'
    if (query.isPending) return 'Linking…'
    return parentId ? 'Parent linked' : 'No workers'
  }
  const linked = `${ids.length} linked`
  if (!desktop) return linked
  const tally = new Map<string, number>()
  for (const id of ids) {
    const status = workers.get(id)?.status
    if (status !== undefined) tally.set(status, (tally.get(status) ?? 0) + 1)
  }
  const parts = [...tally.entries()].map(([status, count]) => `${count} ${status}`)
  return [linked, ...parts].join(' · ')
}

/** The worker row's glyph — shape first, color second, the language the plan and agent rows use. */
function WorkerGlyph({ status }: { status?: WorkerInspection['status'] }) {
  const base = 'size-[15px] shrink-0'
  if (status === 'done') return <CircleCheckIcon aria-hidden className={cn(base, 'text-success')} />
  if (status === 'failed') return <CircleXIcon aria-hidden className={cn(base, 'text-danger')} />
  if (status === 'cancelled') return <CircleSlashIcon aria-hidden className={cn(base, 'text-soft-foreground')} />
  if (status === 'running' || status === 'waiting' || status === 'review') {
    return (
      <LoaderCircleIcon
        role="status"
        aria-label="Worker running"
        className={cn(base, 'animate-spin stroke-pending motion-reduce:animate-none')}
      />
    )
  }
  return <CircleIcon aria-hidden className={cn(base, 'text-soft-foreground')} />
}

/** `done` → `Done`. A label, not a CSS `capitalize`: that rule title-cases every word, so the
 *  fallback sentence for a deleted record came out as "Record Unavailable Or Deleted". */
function workerStatusLabel(status: WorkerInspection['status']): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`
}

function statusTone(status?: WorkerInspection['status']): string {
  if (status === 'done') return 'text-success'
  if (status === 'failed') return 'text-danger'
  return 'text-muted-foreground'
}

function WaitNote({ wait, dependencyLabel }: { wait: DelegationWait; dependencyLabel: string | undefined }) {
  return <p className="px-2 break-words">
    {wait.phase === 'parked' && dependencyLabel ? `${dependencyLabel.charAt(0).toUpperCase()}${dependencyLabel.slice(1)}`
      : wait.requestIds ? (wait.phase === 'parked' ? 'Waiting on request replies' : wait.phase === 'wake-pending'
      ? 'Conversation update queued for this task' : 'Request wait registered — the agent is finishing its turn')
      : wait.phase === 'parked' ? 'Waiting on workers' : wait.phase === 'wake-pending'
      ? 'Worker update queued for the parent' : 'Worker wait registered — the agent is finishing its turn'}.
    {' '}Deadline: <time dateTime={wait.deadline}>{wait.deadline}</time>
  </p>
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

/**
 * The parent's worker capacity (#816): outstanding allocations against the fixed limit. A
 * slot comes back only when a worker's cleanup is verified complete, so at the limit the note
 * names the one recovery a human has here — cleaning up finished workers.
 */
function CapacityNote({ capacity }: { capacity: NonNullable<RunRelationships['capacity']> }) {
  const full = capacity.outstanding >= capacity.limit
  return <p role="status" className={cn('px-2 break-words', full && 'text-foreground')}>
    {full ? `All ${capacity.limit} worker slots are in use. Clean up finished workers to free a slot.`
      : `Capacity ${capacity.outstanding} of ${capacity.limit} in use`}
  </p>
}

const SETTLED = new Set<WorkerInspection['status']>(['review', 'done', 'failed', 'cancelled'])

/**
 * Verified cleanup of one settled worker through the human destroy route (#816). Offered only
 * once the worker has stopped and until its cleanup is proven complete. Cleanup removes the
 * worker's worktree AND branch — work a reviewer may not have read yet — so it takes an inline
 * confirmation. Its result is checkpointed first, and it never accepts a review gate. A refusal
 * is reported in the server's own words, because some (history deletion under way) cannot be
 * fixed by clicking again.
 */
function CleanUpWorker({ parentRunId, worker }: { parentRunId: string; worker: WorkerInspection }) {
  const destroy = useDestroyWorker(parentRunId)
  const [confirming, setConfirming] = useState(false)
  if (!SETTLED.has(worker.status) || (worker.destroy?.phase === 'complete' && worker.destroy.remaining.length === 0)) return null
  const short = worker.workerId.slice(0, 8)
  // A destroy already under way retries on its own; this runs one now and restarts its backoff (hearsay-tools/cezarion#879).
  const retrying = !!worker.destroy && worker.destroy.phase !== 'complete'
  return <div className="flex min-w-0 flex-wrap items-center gap-2 px-1">
    {confirming ? <>
      <span className="break-words text-xs">Removes this worker's worktree and branch. Its result is saved first.</span>
      <Button
        variant="danger-ghost"
        size="sm"
        className="min-h-11"
        aria-label={`Confirm clean up of worker ${short}`}
        onClick={() => { setConfirming(false); destroy.mutate(worker.workerId) }}
      >
        Clean up
      </Button>
      <Button variant="outline" size="sm" className="min-h-11" onClick={() => setConfirming(false)}>Cancel</Button>
    </> : <Button
      variant="outline"
      size="sm"
      className="min-h-11"
      aria-label={retrying ? `Retry clean up of worker ${short}` : `Clean up worker ${short}`}
      disabled={destroy.isPending}
      onClick={() => setConfirming(true)}
    >
      {destroy.isPending ? 'Cleaning up…' : retrying ? 'Retry clean up' : 'Clean up'}
    </Button>}
    {destroy.isError && !confirming ? <span role="status" className="break-words text-xs">Cleanup did not finish: {destroy.error.message}</span> : null}
  </div>
}

/**
 * Teardown, reported only when there is something to report (#402 feedback). A cleanup that
 * reached `complete` with nothing remaining and no error is the expected end of every
 * destroyed worker, so a line saying so appeared on every worker row and carried no
 * information — it just pushed the rows that DO carry some off the first screen.
 *
 * A pending cleanup retries on its own, backing off to hourly; once its retries see nothing
 * change it needs attention (hearsay-tools/cezarion#879). The line says which, when the next check is, and that
 * Retry clean up tries at once.
 */
function Cleanup({ state }: { state: WorkerDestroy }) {
  const tidy = state.phase === 'complete' && state.remaining.length === 0 && state.error === undefined
  if (tidy) return null
  const retry = state.phase === 'complete' ? undefined : state.retry
  const next = retry && <time dateTime={retry.nextAt} title={new Date(retry.nextAt).toLocaleString()}>{relativeIn(Date.now(), Date.parse(retry.nextAt))}</time>
  return <p className="px-2 pb-2 break-words">
    {retry?.needsAttention ? 'Cleanup needs attention' : state.phase === 'incomplete' ? 'Cleanup incomplete' : state.phase === 'complete' ? 'Cleanup complete' : `Cleanup ${state.phase}`}
    {state.remaining.length ? ` — remaining: ${state.remaining.join(', ')}` : ''}
    {state.error ? ` — ${retry ? state.error.replace(/\.$/, '') : state.error}` : ''}
    {retry?.needsAttention ? <>. Nothing changed after {retry.attempts} automatic attempts; checking hourly, next check {next}. Retry clean up to try now.</>
      : retry ? <>. Retrying automatically, next attempt {next}.</> : null}
  </p>
}
