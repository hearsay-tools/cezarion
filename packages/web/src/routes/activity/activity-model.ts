import type { ActivityProject, ActivityRequest, ActivityRun } from '@open-mercato/cezar-api-client/contract/activity'

import { isLiveStatus } from './now-box'

/**
 * What the activity view derives from one project's snapshot, besides each card's now box: who
 * every run id is, the text form of each line, the summary chips and the rail's request rows.
 * Pure (spec 2026-11-05-live-activity-view, "What the user sees" and "Size, motion and access").
 */

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
 * The text form of the lines that touch one row (a card's root or one worker row): "Waiting for a
 * reply from <task>" for each request it sent, "<task> waits for your reply" for each it owes.
 */
export function lineTexts(runId: string, requests: readonly ActivityRequest[], index: ReadonlyMap<string, RunEntry>): string[] {
  const texts: string[] = []
  for (const request of requests) {
    if (request.senderRunId === runId) texts.push(`Waiting for a reply from ${recipientName(index, request)}`)
    if (request.recipientRunId === runId) texts.push(`${senderName(index, request)} waits for your reply`)
  }
  return texts
}

/** The open question a worker asks its parent, the worker-only "Asks parent" row. */
export function askOf(workerId: string, parentId: string, requests: readonly ActivityRequest[]): ActivityRequest | undefined {
  return requests.find((request) => request.relationship === 'family' && request.senderRunId === workerId && request.recipientRunId === parentId)
}

/** The peer requests a card sent: the narrow layout's "→ <task>" links. */
export function sentPeerRequests(cardId: string, requests: readonly ActivityRequest[]): ActivityRequest[] {
  return requests.filter((request) => request.relationship === 'peer' && request.senderRunId === cardId)
}

/** The rail's words for a request's direction. */
export function directionOf(request: ActivityRequest, index: ReadonlyMap<string, RunEntry>): { kind: 'Request' | 'Question'; relation: string } {
  if (request.relationship === 'peer') return { kind: 'Request', relation: 'Peer' }
  return { kind: 'Question', relation: index.get(request.senderRunId)?.role === 'worker' ? 'Worker → parent' : 'Parent → worker' }
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
 *  stays a row, because the parent still owes it a decision. */
export function foldedWorkers(task: ActivityRun): { finished: number; failed: number } {
  let finished = 0
  let failed = 0
  for (const worker of task.workers) {
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
