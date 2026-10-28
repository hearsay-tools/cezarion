import type { ApiRun, Wait } from '@open-mercato/cezar-api-client'

import { isHttpUrl } from '@/lib/utils'
import type { TaskReference } from '@/lib/tasks-table'

/**
 * The run's wait details (spec 2026-10-17-unified-waits): every open CI, timer, worker, process and
 * peer wait, then the last settled CI observation or the retained recovery error, and the last settled
 * process wait's outcome. Snapshot-only status: none
 * of it starts a browser watcher. Lived in the run header until hearsay-tools/cezarion#1333 moved
 * it into the Session activity card's first row.
 */
type CiWait = Extract<Wait, { kind: 'pr' }>
type TimerWait = Extract<Wait, { kind: 'timer' }>
type WorkerWait = Extract<Wait, { kind: 'worker' }>
type ProcessWait = Extract<Wait, { kind: 'process' }>
type PeerWait = Extract<Wait, { kind: 'peer' }>
type ListedWait = CiWait | TimerWait | WorkerWait | ProcessWait | PeerWait

/** Only these statuses can have a wait in flight; a finished run's leftovers are history. */
const IN_FLIGHT_STATUSES: readonly ApiRun['status'][] = ['running', 'queued', 'waiting']

/** The kinds listed here: CI, timer, worker, process and peer waits. Streamed records were only
 *  checked for `id`. A human wait shows as Needs you and its question card, through the pill, never
 *  in this list. A worker or peer wait shows only while open: its result is not owed in a line of its own. */
function renderableWaits(value: unknown): ListedWait[] {
  return Array.isArray(value)
    ? value.filter((wait): wait is ListedWait => wait?.kind === 'pr' || wait?.kind === 'timer' || wait?.kind === 'worker' || wait?.kind === 'process' || wait?.kind === 'peer')
    : []
}

function formatInstant(value: string | undefined) {
  const date = value ? new Date(value) : undefined
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date)
    : undefined
}

/** A resolved wait's result is owed to the agent: mid-turn it waits for the turn end, otherwise
 *  for the wake turn to be admitted. */
function owedLabel(prefix: string, run: ApiRun) {
  return `${prefix} — ${run.status === 'running' ? 'current turn still working' : 'waiting for capacity'}`
}


/** What the details would show, or undefined when there is nothing. The settled observation (or
 *  the retained recovery error) stays beside an open timer, and gives way only to a CI wait of its own. */
function waitView(run: ApiRun) {
  const listed = renderableWaits(run.waits)
  const open = IN_FLIGHT_STATUSES.includes(run.status)
    ? listed.filter(wait => wait.kind === 'worker' || wait.kind === 'peer' ? wait.phase === 'open' : wait.phase === 'open' || wait.phase === 'resolved')
    : []
  const ciOpen = open.some(wait => wait.kind === 'pr')
  // `lastWaits` is newest last; a settled entry still in `waits` is newer than all of them.
  const settled = [...renderableWaits(run.lastWaits), ...listed.filter(wait => !open.includes(wait) && wait.phase !== 'open')]
  const lastCi = ciOpen ? undefined : settled.filter((wait): wait is CiWait => wait.kind === 'pr').at(-1)
  const error = ciOpen ? undefined : run.lastWaitsError
  // The last process outcome is the agent's to act on; an open process wait takes its place.
  const lastProcess = open.some(wait => wait.kind === 'process') ? undefined
    : settled.filter((wait): wait is ProcessWait => wait.kind === 'process').at(-1)
  return open.length || lastCi || error || lastProcess ? { open, lastCi, error, lastProcess } : undefined
}

/** True when `RunWaitDetails` renders anything for this run. */
export function hasWaitDetails(run: ApiRun): boolean {
  return waitView(run) !== undefined
}

/** Only current CI waits belong beside the live status; settled observations stay in details. */
export function ciWaitReferences(run: ApiRun): TaskReference[] {
  return (waitView(run)?.open ?? []).filter((wait): wait is CiWait => wait.kind === 'pr')
    .map(wait => ({ kind: 'PR', number: wait.prNumber, url: wait.prUrl }))
}

export function RunWaitDetails({ run }: { run: ApiRun }) {
  const view = waitView(run)
  if (!view) return null
  const { open, lastCi, error, lastProcess } = view
  return (
    <div data-slot="open-waits" className="flex min-w-0 flex-col gap-1">
      {open.map(wait => wait.kind === 'pr'
        ? <CiWaitStatus key={wait.id} run={run} wait={wait} />
        : wait.kind === 'worker'
          ? <WorkerWaitStatus key={wait.id} wait={wait} />
          : wait.kind === 'process'
            ? <ProcessWaitStatus key={wait.id} run={run} wait={wait} />
            : wait.kind === 'peer'
              ? <PeerWaitStatus key={wait.id} wait={wait} />
              : <TimerWaitStatus key={wait.id} run={run} wait={wait} />)}
      {error ? (
        <div data-slot="ci-wait-status" role="status" aria-live="polite" aria-atomic="true"
          className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {error}
        </div>
      ) : lastCi ? <CiWaitStatus run={run} wait={lastCi} settled /> : null}
      {lastProcess ? <ProcessWaitStatus run={run} wait={lastProcess} settled /> : null}
    </div>
  )
}

function CiWaitStatus({ run, wait, settled = false }: { run: ApiRun; wait: CiWait; settled?: boolean }) {
  const result = wait.result
  // A merge wait (hearsay-tools/cezarion#1425) waits for GitHub's merge, never for checks.
  const merge = wait.until === 'merge'
  const outcomes: Record<NonNullable<typeof result>['outcome'], string> = {
    passed: 'CI checks passed — observed checks only; not merge approval',
    failed: 'CI checks failed — inspect the PR checks',
    conflicting: merge ? 'PR has merge conflicts — inspect the PR; not merged' : 'PR has merge conflicts — inspect the PR; not merge approval',
    cancelled: merge ? 'Merge wait cancelled' : 'CI wait cancelled',
    skipped: 'CI checks skipped — inspect the PR checks',
    no_checks: 'No CI checks found — inspect the PR workflows',
    deadline: merge ? 'Merge wait timed out — merge not confirmed' : 'CI wait timed out — inspect the PR checks',
    error: merge ? 'Merge wait unavailable — inspect access and the PR' : 'CI wait unavailable — inspect access and the PR checks',
    head_changed: `CI head changed — ${result?.headSha.slice(0, 7)} → ${result?.observedHeadSha?.slice(0, 7) ?? 'unknown'}`,
    merged: 'PR merged',
    closed: 'PR closed without merge — inspect the PR',
  }
  const noun = merge ? 'Merge' : 'CI'
  const cancelled = settled && wait.phase === 'cancelled'
  const label = !settled
    ? wait.phase === 'resolved' ? owedLabel(`${noun} result ready`, run) : merge ? 'Waiting for merge' : 'Waiting for CI'
    : cancelled ? `${noun} wait cancelled` : result ? outcomes[result.outcome] : `${noun} wait unavailable`
  const timestamp = !settled ? wait.deadline : cancelled ? wait.cancelledAt : result?.observedAt
  const dateLabel = formatInstant(timestamp)
  const prLabel = `${wait.repository}#${wait.prNumber}`
  return (
    <div data-slot="ci-wait-status" role="status" aria-live="polite" aria-atomic="true"
      className="min-w-0 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
        <dt className="font-medium text-foreground">Status</dt><dd>{label}</dd>
        <dt className="font-medium text-foreground">Pull request</dt><dd className="min-w-0">
        {isHttpUrl(wait.prUrl) ? (
          <a href={wait.prUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm px-1 font-medium text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-muted">
            {prLabel}
          </a>
        ) : <span>{prLabel}</span>}
        </dd>
        {dateLabel ? <>
          <dt className="font-medium text-foreground">{!settled ? 'Deadline' : cancelled ? 'Cancelled' : 'Observed'}</dt>
          <dd><time dateTime={timestamp}>{dateLabel}</time></dd>
        </> : !settled ? <><dt className="font-medium text-foreground">Deadline</dt><dd>{noun} deadline unavailable</dd></> : null}
      </dl>
    </div>
  )
}

/** "Waiting on N workers" / "N request replies": the ids not yet reported, with the deadline. */
function WorkerWaitStatus({ wait }: { wait: WorkerWait }) {
  const byWorker = wait.workerIds !== undefined
  const reported = new Set((byWorker ? wait.outcomes : wait.requestOutcomes)?.map(outcome => 'workerId' in outcome ? outcome.workerId : outcome.requestId))
  const count = (wait.workerIds ?? wait.requestIds ?? []).filter(id => !reported.has(id)).length
  const noun = byWorker ? (count === 1 ? 'worker' : 'workers') : (count === 1 ? 'request reply' : 'request replies')
  const dateLabel = formatInstant(wait.deadline)
  return (
    <div data-slot="worker-wait-status" role="status" aria-live="polite" aria-atomic="true"
      className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <p>Waiting on {count} {noun}</p>
      {dateLabel ? <p>Deadline{' '}<time dateTime={wait.deadline}>{dateLabel}</time></p> : <p>Worker wait deadline unavailable</p>}
    </div>
  )
}

/** "Waiting on N tasks": the peer tasks a peer wait names, with its deadline (hearsay-tools/cezarion#1995). */
function PeerWaitStatus({ wait }: { wait: PeerWait }) {
  const count = wait.peerIds.length
  const dateLabel = formatInstant(wait.deadline)
  return (
    <div data-slot="peer-wait-status" role="status" aria-live="polite" aria-atomic="true"
      className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <p>Waiting on {count} {count === 1 ? 'task' : 'tasks'}</p>
      {dateLabel ? <p>Deadline{' '}<time dateTime={wait.deadline}>{dateLabel}</time></p> : <p>Peer wait deadline unavailable</p>}
    </div>
  )
}

function TimerWaitStatus({ run, wait }: { run: ApiRun; wait: TimerWait }) {
  const dateLabel = formatInstant(wait.deadline)
  return (
    <div data-slot="monitoring-schedule" role="status" aria-live="polite" aria-atomic="true"
      className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {wait.phase === 'resolved' ? <p>{owedLabel('Automatic check due', run)}</p> : dateLabel ? (
        <p>
          Next automatic check{' '}
          <time dateTime={wait.deadline} className="font-medium text-foreground">
            {dateLabel}
          </time>
        </p>
      ) : <p>Automatic check time unavailable</p>}
      {wait.note ? <p>{wait.note}</p> : null}
    </div>
  )
}

/** What the process wait found, in the words of the agent's wake text (hearsay-tools/cezarion#1446). */
function processOutcome(wait: ProcessWait) {
  const result = wait.result
  if (!result) return `PID ${wait.pid} still running at the deadline`
  if (result.outcome === 'exit_file') {
    return result.exitCode !== undefined
      ? `PID ${wait.pid} exited with code ${result.exitCode}`
      : `PID ${wait.pid} wrote an exit file that is not an exit code`
  }
  if (result.outcome === 'exited') return `PID ${wait.pid} exited, code unknown`
  if (result.outcome === 'deadline') return `PID ${wait.pid} still running at the deadline`
  return `PID ${wait.pid} could not be checked`
}

function ProcessWaitStatus({ run, wait, settled = false }: { run: ApiRun; wait: ProcessWait; settled?: boolean }) {
  const cancelled = settled && wait.phase === 'cancelled'
  const label = cancelled ? `Process wait on PID ${wait.pid} cancelled`
    : settled ? processOutcome(wait)
    : wait.phase === 'resolved' ? owedLabel(processOutcome(wait), run)
    : `Waiting for PID ${wait.pid}${wait.note ? ` — ${wait.note}` : ''}`
  const dateLabel = !settled && wait.phase === 'open' ? formatInstant(wait.deadline) : undefined
  return (
    <div data-slot="process-wait-status" role="status" aria-live="polite" aria-atomic="true"
      className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <p>{label}</p>
      {dateLabel ? <p>Until{' '}<time dateTime={wait.deadline}>{dateLabel}</time></p> : null}
    </div>
  )
}
