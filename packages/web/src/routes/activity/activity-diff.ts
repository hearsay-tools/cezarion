import type {
  ActivityClosedRequest,
  ActivityProject,
  ActivityRequest,
  ActivityRun,
  ActivitySnapshot,
  ActivityWorker,
} from '@open-mercato/cezar-api-client/contract/activity'

import { peerWaits, projectNotice, summarize, type ActivitySummary, type PeerWait } from './activity-model'
import { isLiveStatus } from './now-box'

/**
 * The animation triggers of the activity view (spec 2026-11-05-live-activity-view, "Live
 * transport"): every change the client animates is a difference between two snapshots. No event
 * stream feeds the motion. Pure: two snapshots in, a list of triggers out. The first snapshot has
 * no previous one, so it never animates.
 */

export type ActivityTrigger =
  | { kind: 'request-opened'; projectId: string; request: ActivityRequest }
  /** A request left the open list. `status` is its stored outcome, when the snapshot lists one:
   *  only `replied` plays the reply comet; every other closure fades. */
  | { kind: 'request-closed'; projectId: string; request: ActivityRequest; status?: ActivityClosedRequest['status'] }
  | { kind: 'rung-changed'; projectId: string; task: ActivityRun; from: ActivityRun['rung'] }
  /** A new tool call on a card: its main line slides in. */
  | { kind: 'tool-started'; projectId: string; runId: string }
  | { kind: 'worker-started'; projectId: string; parentId: string; worker: ActivityWorker }
  | { kind: 'worker-settled'; projectId: string; parentId: string; worker: ActivityWorker }
  | { kind: 'card-entered'; projectId: string; task: ActivityRun }
  /** `task` is the card as the previous snapshot drew it: the view collapses that card. */
  | { kind: 'card-left'; projectId: string; task: ActivityRun }
  | { kind: 'check-passed'; projectId: string; runId: string; pr: number; name: string }
  | { kind: 'chip-changed'; chip: keyof ActivitySummary; from: number; to: number }
  /** A root started waiting on a peer: its wait line fades in. */
  | { kind: 'wait-opened'; projectId: string; wait: PeerWait }
  /** A peer wait ended. The snapshot does not say why (the peer wrote or settled, the wait timed
   *  out or was cancelled), so the line only fades. */
  | { kind: 'wait-closed'; projectId: string; wait: PeerWait }

type Emit = (trigger: ActivityTrigger) => void

const byRunId = <T extends { runId: string }>(runs: readonly T[]) => new Map(runs.map((run) => [run.runId, run]))

/** A project whose lists cannot be trusted (not loaded, or its store unavailable) has nothing to
 *  compare: empty lists there are not an idle project, so nothing left or entered. */
const readable = (project: ActivityProject | undefined): project is ActivityProject => project !== undefined && projectNotice(project) === undefined

function diffWorkers(projectId: string, before: ActivityRun, after: ActivityRun, emit: Emit) {
  const previous = byRunId(before.workers)
  for (const worker of after.workers) {
    const was = previous.get(worker.runId)
    // A worker first seen settled never moved on screen: it only joins the finished count.
    if (!was && isLiveStatus(worker.status)) emit({ kind: 'worker-started', projectId, parentId: after.runId, worker })
    if (was && isLiveStatus(was.status) && !isLiveStatus(worker.status)) emit({ kind: 'worker-settled', projectId, parentId: after.runId, worker })
  }
}

/** Checks of one PR that moved from `pending` to `pass`. */
function diffChecks(projectId: string, before: ActivityRun, after: ActivityRun, emit: Emit) {
  if (before.wait?.kind !== 'pr' || after.wait?.kind !== 'pr' || before.wait.detail.number !== after.wait.detail.number) return
  const pending = new Set((before.wait.detail.checks ?? []).filter((check) => check.bucket === 'pending').map((check) => check.name))
  for (const check of after.wait.detail.checks ?? []) {
    if (check.bucket === 'pass' && pending.has(check.name)) emit({ kind: 'check-passed', projectId, runId: after.runId, pr: after.wait.detail.number, name: check.name })
  }
}

const newTool = (before: ActivityRun, after: ActivityRun) =>
  after.tool !== undefined && (after.tool.startedAt !== before.tool?.startedAt || after.tool.title !== before.tool?.title)

function diffCard(projectId: string, before: ActivityRun, after: ActivityRun, emit: Emit) {
  if (before.rung !== after.rung) emit({ kind: 'rung-changed', projectId, task: after, from: before.rung })
  if (newTool(before, after)) emit({ kind: 'tool-started', projectId, runId: after.runId })
  diffWorkers(projectId, before, after, emit)
  diffChecks(projectId, before, after, emit)
}

function diffCards(before: ActivityProject, after: ActivityProject, emit: Emit) {
  const previous = byRunId(before.tasks)
  const next = byRunId(after.tasks)
  for (const task of after.tasks) {
    const was = previous.get(task.runId)
    if (was) diffCard(after.projectId, was, task, emit)
    else emit({ kind: 'card-entered', projectId: after.projectId, task })
  }
  for (const task of before.tasks) if (!next.has(task.runId)) emit({ kind: 'card-left', projectId: after.projectId, task })
}

function diffRequests(before: ActivityProject, after: ActivityProject, emit: Emit) {
  const previous = new Set(before.requests.map((request) => request.requestId))
  const open = new Set(after.requests.map((request) => request.requestId))
  const outcomes = new Map(after.closed.map((closed) => [closed.requestId, closed.status]))
  for (const request of after.requests) if (!previous.has(request.requestId)) emit({ kind: 'request-opened', projectId: after.projectId, request })
  for (const request of before.requests) {
    if (open.has(request.requestId)) continue
    const status = outcomes.get(request.requestId)
    emit({ kind: 'request-closed', projectId: after.projectId, request, ...(status ? { status } : {}) })
  }
}

function diffWaits(before: ActivityProject, after: ActivityProject, emit: Emit) {
  const previous = peerWaits(before.tasks)
  const next = peerWaits(after.tasks)
  const was = new Set(previous.map((wait) => wait.id))
  const open = new Set(next.map((wait) => wait.id))
  for (const wait of next) if (!was.has(wait.id)) emit({ kind: 'wait-opened', projectId: after.projectId, wait })
  for (const wait of previous) if (!open.has(wait.id)) emit({ kind: 'wait-closed', projectId: after.projectId, wait })
}

const CHIPS: readonly (keyof ActivitySummary)[] = ['needsYou', 'working', 'waiting', 'queued', 'activeWorkers', 'openRequests', 'inReview']

function diffChips(before: readonly ActivityProject[], after: readonly ActivityProject[], emit: Emit) {
  const was = summarize(before)
  const now = summarize(after)
  for (const chip of CHIPS) if (was[chip] !== now[chip]) emit({ kind: 'chip-changed', chip, from: was[chip], to: now[chip] })
}

/**
 * Every animation trigger between two snapshots of one scope, in a stable order: per project in
 * the next snapshot's order, its cards (entered, changed, left), then its requests (opened,
 * closed), then its peer waits (opened, closed), then the summary chips. No previous snapshot: no triggers.
 */
export function diffActivity(previous: ActivitySnapshot | undefined, next: ActivitySnapshot): ActivityTrigger[] {
  if (previous === undefined) return []
  const triggers: ActivityTrigger[] = []
  const emit: Emit = (trigger) => triggers.push(trigger)
  const before = new Map(previous.projects.map((project) => [project.projectId, project]))
  for (const project of next.projects) {
    const was = before.get(project.projectId)
    if (!readable(was) || !readable(project)) continue
    diffCards(was, project, emit)
    diffRequests(was, project, emit)
    diffWaits(was, project, emit)
  }
  diffChips(previous.projects, next.projects, emit)
  return triggers
}
