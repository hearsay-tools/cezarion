import type { ActivityProject, ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'

import { counter, since } from './activity-format'
import { isLiveStatus } from './now-box'

/**
 * What the activity view derives from one project's snapshot, besides each card's now box: who
 * every run id is, the text form of each line, the summary chips and the rail's request rows.
 * Pure (spec 2026-11-05-live-activity-view, "What the user sees" and "Size, motion and access").
 */

/**
 * Why a project's lists are empty although it may have work: the project is not loaded in this
 * cockpit, or its run store cannot open. Undefined when the lists are the truth.
 */
export function projectNotice(project: Pick<ActivityProject, 'loaded' | 'unavailable'>): string | undefined {
  if (project.unavailable) return project.unavailable.error
  if (!project.loaded) return 'Not loaded in this cockpit'
  return undefined
}

/** The name a line shows for a task the snapshot cannot name (its record could not be read). */
export const UNREADABLE_TASK = 'Unreadable task'

export interface RunEntry {
  title: string
  /** The card the run is drawn in: its own id for a root, its parent's for a worker. */
  cardId: string
  role: 'root' | 'worker'
}

/** Every run on the view by id: the roots and their workers. */
export function runIndex(project: ActivityProject): Map<string, RunEntry> {
  const index = new Map<string, RunEntry>()
  for (const task of project.tasks) {
    index.set(task.runId, { title: task.title, cardId: task.runId, role: 'root' })
    for (const worker of task.workers) index.set(worker.runId, { title: worker.title, cardId: task.runId, role: 'worker' })
  }
  return index
}

/** A run's name: from the view, else from the request that names it, else the placeholder. */
export function nameOf(index: ReadonlyMap<string, RunEntry>, runId: string, fallback?: string): string {
  return index.get(runId)?.title ?? fallback ?? UNREADABLE_TASK
}

export const senderName = (index: ReadonlyMap<string, RunEntry>, request: ActivityRequest) => nameOf(index, request.senderRunId, request.senderTitle)
export const recipientName = (index: ReadonlyMap<string, RunEntry>, request: ActivityRequest) => nameOf(index, request.recipientRunId, request.recipientTitle)

/**
 * An open peer wait (`cez message wait --peer`): a root task waits until a named peer writes to it
 * or settles. One link for each named peer. Its line runs from the peer to the waiter, the way the
 * awaited message will travel. Only a root registers a peer wait, and its peers are roots.
 */
export interface PeerWait {
  /** `wait:<waiter>:<peer>`: the key of its line, its label and its motion. */
  id: string
  waiterRunId: string
  peerRunId: string
  since: string
  deadline: string
}

export const peerWaitId = (waiterRunId: string, peerRunId: string) => `wait:${waiterRunId}:${peerRunId}`

/** The open peer waits of the cards: every peer named by a live root whose top wait is a peer wait. */
export function peerWaits(tasks: readonly ActivityRun[]): PeerWait[] {
  const waits: PeerWait[] = []
  for (const task of tasks) {
    const wait = task.wait
    if (!isLiveStatus(task.status) || wait?.kind !== 'peers') continue
    for (const peerRunId of new Set(wait.detail.peerRunIds)) {
      if (peerRunId === task.runId) continue
      waits.push({ id: peerWaitId(task.runId, peerRunId), waiterRunId: task.runId, peerRunId, since: wait.since, deadline: wait.deadline })
    }
  }
  return waits
}

/** The cards a peer wait links to `runId`: the peers it waits on and the tasks that wait on it. */
export function linkedByWaits(runId: string, waits: readonly PeerWait[]): Set<string> {
  const linked = new Set<string>()
  for (const wait of waits) {
    if (wait.waiterRunId === runId) linked.add(wait.peerRunId)
    if (wait.peerRunId === runId) linked.add(wait.waiterRunId)
  }
  return linked
}

/** The peer waits a card holds: the narrow layout's "⋯ waits on <task>" links. */
export function sentPeerWaits(cardId: string, waits: readonly PeerWait[]): PeerWait[] {
  return waits.filter((wait) => wait.waiterRunId === cardId)
}

/**
 * The text form of the lines that touch one row (a card's root or one worker row): "Waiting for a
 * reply from <task>" for each request it sent, "<task> waits for your reply" for each it owes;
 * "Waiting for a message from <task>" for each peer it waits on, "<task> waits for you to write"
 * for each task that waits on it.
 */
export function lineTexts(runId: string, requests: readonly ActivityRequest[], index: ReadonlyMap<string, RunEntry>, waits: readonly PeerWait[] = []): string[] {
  const texts: string[] = []
  for (const request of requests) {
    if (request.senderRunId === runId) texts.push(`Waiting for a reply from ${recipientName(index, request)}`)
    if (request.recipientRunId === runId) texts.push(`${senderName(index, request)} waits for your reply`)
  }
  for (const wait of waits) {
    if (wait.waiterRunId === runId) texts.push(`Waiting for a message from ${nameOf(index, wait.peerRunId)}`)
    if (wait.peerRunId === runId) texts.push(`${nameOf(index, wait.waiterRunId)} waits for you to write`)
  }
  return texts
}

/** The open question a worker asks its parent, the worker-only "Asks parent" row. */
export function askOf(workerId: string, parentId: string, requests: readonly ActivityRequest[]): ActivityRequest | undefined {
  return requests.find((request) => request.relationship === 'family' && request.senderRunId === workerId && request.recipientRunId === parentId)
}

/** A reply deadline as the rail says it: a countdown, then "reply overdue" from the deadline on. */
export function replyDueText(deadline: string, now: number): string {
  const left = -since(deadline, now)
  return left >= 1000 ? `reply due in ${counter(left)}` : 'reply overdue'
}

/** The peer requests a card sent: the narrow layout's "→ <task>" links. */
export function sentPeerRequests(cardId: string, requests: readonly ActivityRequest[]): ActivityRequest[] {
  return requests.filter((request) => request.relationship === 'peer' && request.senderRunId === cardId)
}

/** The rail's words for a request's direction. */
export function directionOf(request: ActivityRequest, index: ReadonlyMap<string, RunEntry>): { kind: 'Request' | 'Question'; relation: string } {
  if (request.relationship === 'peer') return { kind: 'Request', relation: 'Peer' }
  return { kind: 'Question', relation: FAMILY_RELATION[familyAsker(request, index)] }
}

const FAMILY_RELATION = { worker: 'Worker → parent', parent: 'Parent → worker', unknown: 'Family' } as const

/** Who asks in a family request: read from the sender's role, or, when the sender is not on the
 *  view (an unreadable worker), from the recipient's. */
function familyAsker(request: ActivityRequest, index: ReadonlyMap<string, RunEntry>): keyof typeof FAMILY_RELATION {
  const sender = index.get(request.senderRunId)?.role
  if (sender) return sender === 'worker' ? 'worker' : 'parent'
  const recipient = index.get(request.recipientRunId)?.role
  if (recipient) return recipient === 'root' ? 'worker' : 'parent'
  return 'unknown'
}

export interface ActivitySummary {
  needsYou: number
  working: number
  waiting: number
  queued: number
  activeWorkers: number
  openRequests: number
  inReview: number
}

const NEEDS_YOU = new Set(['needs-you', 'needs-permission'])
const QUEUED = new Set(['queued', 'waiting-for-capacity'])

function bucketOf(task: ActivityRun): keyof Pick<ActivitySummary, 'needsYou' | 'working' | 'waiting' | 'queued'> | undefined {
  // A retained root (review, failed, done, cancelled with a live worker) is on the view for its
  // workers; it is none of the four.
  if (!isLiveStatus(task.status)) return undefined
  if (NEEDS_YOU.has(task.rung)) return 'needsYou'
  if (task.rung === 'running') return 'working'
  if (QUEUED.has(task.rung)) return 'queued'
  return 'waiting'
}

/** The summary chips, counted over the cards of every project in the snapshot. */
export function summarize(projects: readonly ActivityProject[]): ActivitySummary {
  const summary: ActivitySummary = { needsYou: 0, working: 0, waiting: 0, queued: 0, activeWorkers: 0, openRequests: 0, inReview: 0 }
  for (const project of projects) {
    summary.inReview += project.inReview
    summary.openRequests += project.requests.length
    for (const task of project.tasks) {
      const bucket = bucketOf(task)
      if (bucket) summary[bucket] += 1
      summary.activeWorkers += task.workers.filter((worker) => isLiveStatus(worker.status)).length
    }
  }
  return summary
}

/** Workers that settled and leave their row: `done`, `failed` and `cancelled`. A `review` worker
 *  stays a row, because the parent still owes it a decision. A worker that just settled (`held`)
 *  stays a row for a moment before it folds. */
export function foldedWorkers(task: ActivityRun, held: (runId: string) => boolean = () => false): { finished: number; failed: number } {
  let finished = 0
  let failed = 0
  for (const worker of task.workers) {
    if (held(worker.runId)) continue
    if (worker.status === 'done' || worker.status === 'cancelled') finished += 1
    if (worker.status === 'failed') {
      finished += 1
      failed += 1
    }
  }
  return { finished, failed }
}

/** "✓ N workers finished", or "✓ N finished · 1 failed". */
export function finishedText({ finished, failed }: { finished: number; failed: number }): string | undefined {
  if (finished === 0) return undefined
  if (failed > 0) return `✓ ${finished} finished · ${failed} failed`
  return `✓ ${finished} worker${finished === 1 ? '' : 's'} finished`
}
