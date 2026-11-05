import type { ActivityPrProgress, ActivityRun, ActivityWait, ActivityWorker } from '@open-mercato/cezar-api-client/contract/activity'

import { attentionOfRung, type AttentionTone } from '@/lib/attention'

import { clockOf, counter, since, span } from './activity-format'

/**
 * The now box (spec 2026-11-05-live-activity-view, "What the user sees", the state table): what a
 * card says its task is doing or waiting for. Pure: the same snapshot and `now` give the same box.
 */

/** Which glyph leads the box. The view maps each to a lucide icon. */
export type NowIcon =
  | 'tool' | 'user' | 'workers' | 'reply' | 'peer' | 'subagents' | 'ci' | 'merge' | 'command'
  | 'timer' | 'pause' | 'queued' | 'review' | 'failed' | 'done' | 'cancelled'

export interface NowBox {
  verb: string
  tone: AttentionTone
  icon: NowIcon
  main: string
  /** The main line is a tool call title, set in the mono face. */
  mono?: true
  detail?: string
  /** The base of the live age counter beside the verb. */
  since?: string
  /** Workers settled over workers named, 0 to 1. */
  bar?: number
  /** One segment for each check, in name order. */
  checks?: ActivityPrProgress['checks']
  /** The button under the box: Answer opens the question, Open the task. */
  action?: 'answer' | 'open'
}

export interface NowContext {
  now: number
  /** A task's display title; the view falls back to "a task" for an id it cannot name. */
  titleOf: (runId: string) => string
}

/** A tool call that ended this long ago no longer names what the task is doing. */
export const THINKING_AFTER_MS = 10_000

const LIVE = new Set(['queued', 'running', 'waiting'])
const SETTLED_VERB: Record<string, string> = { review: 'In review', failed: 'Failed', done: 'Done', cancelled: 'Cancelled' }
const SETTLED_ICON: Record<string, NowIcon> = { review: 'review', failed: 'failed', done: 'done', cancelled: 'cancelled' }

export const isLiveStatus = (status: string) => LIVE.has(status)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const toneOf = (run: Pick<ActivityRun, 'rung'>) => attentionOfRung(run.rung).tone
const deadlineDetail = (deadline: string | undefined, word = 'Deadline') => (deadline ? `${word} ${clockOf(deadline)}` : undefined)

/** "From <task>" or "From N tasks", and the peer wait's "For …". */
function namesLine(lead: string, runIds: readonly string[], ctx: NowContext): string {
  if (runIds.length === 1 && runIds[0] !== undefined) return `${lead} ${ctx.titleOf(runIds[0])}`
  return `${lead} ${plural(runIds.length, 'task')}`
}

function doing(run: ActivityRun, ctx: NowContext): NowBox {
  const tool = run.tool
  const base = { verb: 'Doing', tone: toneOf(run), icon: 'tool' as const }
  const ended = tool?.endedAt !== undefined && since(tool.endedAt, ctx.now) > THINKING_AFTER_MS
  if (tool === undefined) return { ...base, main: 'Thinking', ...(run.startedAt ? { since: run.startedAt } : {}) }
  const detail = `Last tool ${span(since(tool.endedAt ?? tool.startedAt, ctx.now))} ago`
  if (ended) return { ...base, main: 'Thinking', detail, since: tool.endedAt ?? tool.startedAt }
  return { ...base, main: tool.title, mono: true, detail, since: tool.startedAt }
}

function needsYou(run: ActivityRun, wait: Extract<ActivityWait, { kind: 'human' }> | undefined): NowBox {
  const base = { verb: 'Needs you', tone: toneOf(run), icon: 'user' as const, ...(wait ? { since: wait.since } : {}) }
  if (wait?.detail.reason === 'question') {
    return wait.detail.question ? { ...base, main: wait.detail.question, action: 'answer' } : { ...base, main: 'Your turn', action: 'answer' }
  }
  if (wait?.detail.reason === 'budget') {
    const queued = wait.detail.queuedMessages
    return { ...base, main: queued ? `Automatic wakes used up · ${plural(queued, 'queued message')}` : 'Automatic wakes used up', action: 'open' }
  }
  return { ...base, main: 'Your turn', action: 'open' }
}

/** The record holds only `hasPendingPermission`, never the tool it asks about. */
function permission(run: ActivityRun): NowBox {
  return { verb: 'Needs you', tone: toneOf(run), icon: 'user', main: 'Permission', action: 'open' }
}

function workers(run: ActivityRun, wait: Extract<ActivityWait, { kind: 'workers' }>, ctx: NowContext): NowBox {
  const { owed, total, settled, replies, mode, recipientRunIds } = wait.detail
  const bar = total > 0 ? settled / total : 0
  const base = { tone: toneOf(run), since: wait.since }
  if (replies) {
    return { ...base, verb: 'Waiting for reply', icon: 'reply', main: namesLine('From', recipientRunIds, ctx), ...defined('detail', deadlineDetail(wait.deadline, 'Reply due')) }
  }
  const mixed = recipientRunIds.length > 0
  const main = mixed ? `${owed} owed · ${settled} settled` : mode ? `${MODE_WORD[mode]} of ${total} · ${settled} settled` : `${owed} owed`
  return { ...base, verb: 'Waiting for workers', icon: 'workers', main, bar, ...defined('detail', deadlineDetail(wait.deadline)) }
}

const MODE_WORD = { one: 'One', any: 'Any', all: 'All' } as const

function checksLine(wait: Extract<ActivityWait, { kind: 'pr' }>): string {
  const counts = wait.detail.counts
  if (counts === undefined) return `PR ${wait.detail.number} checks`
  const counted = counts.pass + counts.fail + counts.pending
  return `PR ${wait.detail.number} checks · ${counts.pass} of ${counted} passed`
}

function pullRequest(run: ActivityRun, wait: Extract<ActivityWait, { kind: 'pr' }>): NowBox {
  const base = { tone: toneOf(run), since: wait.since, ...defined('detail', deadlineDetail(wait.deadline)) }
  if (wait.detail.target !== 'checks') return { ...base, verb: 'Waiting for merge', icon: 'merge', main: `PR ${wait.detail.number}` }
  const checks = wait.detail.checks ? [...wait.detail.checks].sort((a, b) => a.name.localeCompare(b.name)) : undefined
  return { ...base, verb: 'Waiting for CI', icon: 'ci', main: checksLine(wait), ...defined('checks', checks) }
}

function defined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

function parked(run: ActivityRun, wait: ActivityWait, ctx: NowContext): NowBox | undefined {
  const tone = toneOf(run)
  switch (wait.kind) {
    case 'workers': return workers(run, wait, ctx)
    case 'peers': return { verb: 'Waiting for a peer', tone, icon: 'peer', since: wait.since, main: namesLine('For', wait.detail.peerRunIds, ctx), detail: `Deadline ${clockOf(wait.deadline)}` }
    case 'subagents': return { verb: 'Waiting for subagents', tone, icon: 'subagents', since: wait.since, main: plural(wait.detail.running, 'native subagent'), detail: `Deadline ${clockOf(wait.deadline)}` }
    case 'pr': return pullRequest(run, wait)
    case 'process': return { verb: 'Waiting for command', tone, icon: 'command', since: wait.since, main: wait.detail.note ?? `Process ${wait.detail.pid}`, detail: `Running ${counter(since(wait.since, ctx.now))} · deadline ${clockOf(wait.deadline)}` }
    case 'timer': return { verb: 'Waiting for timer', tone, icon: 'timer', since: wait.since, main: wait.detail.note ?? 'Timer', detail: `Wakes ${clockOf(wait.detail.wakeAt)} · in ${counter(-since(wait.detail.wakeAt, ctx.now))}` }
    case 'usage-limit': return paused(run, wait.detail.resumeAt, ctx)
    case 'human': return undefined
  }
}

function paused(run: ActivityRun, resumeAt: string, ctx: NowContext): NowBox {
  const at = Date.parse(resumeAt)
  const detail = Number.isNaN(at) ? `Resumes ${resumeAt}` : `Resumes ${clockOf(resumeAt)} · in ${counter(at - ctx.now)}`
  return { verb: 'Paused', tone: toneOf(run), icon: 'pause', main: 'Usage limit', detail }
}

function queued(run: ActivityRun, ctx: NowContext): NowBox {
  const start = run.wait && 'since' in run.wait ? run.wait.since : run.startedAt
  return { verb: 'Queued', tone: toneOf(run), icon: 'queued', main: 'Waiting for a free slot', ...(start ? { since: start, detail: `Waiting ${span(since(start, ctx.now))}` } : {}) }
}

function settledBox(run: ActivityRun | ActivityWorker, main: string): NowBox {
  return { verb: SETTLED_VERB[run.status] ?? run.status, tone: toneOf(run), icon: SETTLED_ICON[run.status] ?? 'done', main }
}

/** The root card's box: one row of the state table, or the retained-root row (D8). */
export function rootNow(run: ActivityRun, ctx: NowContext): NowBox {
  if (!isLiveStatus(run.status)) return settledBox(run, plural(run.workers.filter((worker) => isLiveStatus(worker.status)).length, 'live worker'))
  return liveNow(run, ctx)
}

function liveNow(run: ActivityRun, ctx: NowContext): NowBox {
  const wait = run.wait
  switch (run.rung) {
    case 'running': return doing(run, ctx)
    case 'needs-permission': return permission(run)
    case 'needs-you': return needsYou(run, wait?.kind === 'human' ? wait : undefined)
    case 'usage-limit': return wait?.kind === 'usage-limit' ? paused(run, wait.detail.resumeAt, ctx) : { verb: 'Paused', tone: toneOf(run), icon: 'pause', main: 'Usage limit' }
    case 'queued':
    case 'waiting-for-capacity': return queued(run, ctx)
    default: return (wait && parked(run, wait, ctx)) ?? queued(run, ctx)
  }
}

/** The one line of a worker row: the state table's short form, a settled worker's row, or the
 *  worker-only "Asks parent" when it has an open request to its parent. */
export interface WorkerLine {
  verb: string
  tone: AttentionTone
  main: string
  mono?: true
  /** Tinted in the family tone: the worker asks its parent. */
  asks?: true
}

export function workerLine(worker: ActivityWorker, ctx: NowContext, askText?: string): WorkerLine {
  if (askText !== undefined && isLiveStatus(worker.status)) return { verb: 'Asks parent', tone: toneOf(worker), main: `“${askText}”`, asks: true }
  const box = workerBox(worker, ctx)
  return { verb: box.verb, tone: box.tone, main: box.main, ...(box.mono ? { mono: true as const } : {}) }
}

function workerBox(worker: ActivityWorker, ctx: NowContext): NowBox {
  switch (worker.status) {
    case 'done': return settledBox(worker, worker.collected ? 'Collected' : 'Ready to collect')
    case 'review': return settledBox(worker, 'Waiting for the parent’s review')
    case 'failed':
    case 'cancelled': return settledBox(worker, worker.error ?? SETTLED_VERB[worker.status] ?? worker.status)
    default: return liveNow({ ...worker, workers: [] }, ctx)
  }
}
