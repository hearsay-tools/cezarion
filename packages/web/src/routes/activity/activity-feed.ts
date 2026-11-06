import type { ActivityRequest, ActivitySnapshot } from '@open-mercato/cezar-api-client/contract/activity'

import { attentionOfRung, type AttentionTone } from '@/lib/attention'

import type { ActivityTrigger } from './activity-diff'
import { nameOf, runIndex, type RunEntry } from './activity-model'
import { rootNow } from './now-box'

/**
 * The rail's "Just now" feed (spec 2026-11-05-live-activity-view, "Right rail"): the last six
 * changes the client saw since the view opened, newest first, each with its age. Pure: triggers
 * in, entries out.
 */

/** How many changes the feed keeps. */
export const FEED_SIZE = 6

/** A feed dot: an attention tone, or one of the two line tones. */
export type FeedTone = AttentionTone | 'peer' | 'family'

export interface FeedEntry {
  id: number
  /** The server time the change was seen: the snapshot's `generatedAt`. */
  at: number
  tone: FeedTone
  text: string
}

/** Every run either snapshot names, so a feed line can name a run that just left the view. */
export function feedNames(previous: ActivitySnapshot | undefined, next: ActivitySnapshot): Map<string, RunEntry> {
  const names = new Map<string, RunEntry>()
  for (const project of [...(previous?.projects ?? []), ...next.projects]) for (const [id, entry] of runIndex(project)) names.set(id, entry)
  return names
}

const CLOSED_WORDS: Record<string, string> = {
  'timed-out': 'timed out',
  cancelled: 'was cancelled',
  destroyed: 'closed: the recipient was destroyed',
  failed: 'closed: the recipient failed',
  'completed-without-reply': 'closed without a reply',
  'sender-closed': 'was closed by its sender',
  'human-fallback': 'went to a human',
  deleted: 'closed: the recipient was deleted',
}

function closedText(request: ActivityRequest, status: string | undefined, who: (id: string, title?: string) => string): string {
  const sender = who(request.senderRunId, request.senderTitle)
  const recipient = who(request.recipientRunId, request.recipientTitle)
  if (status === 'replied') return `${recipient} replied to ${sender}`
  return `${sender}’s request to ${recipient} ${CLOSED_WORDS[status ?? ''] ?? 'closed'}`
}

const SETTLED: Record<string, { tone: AttentionTone; word: string }> = {
  done: { tone: 'success', word: 'finished' },
  failed: { tone: 'danger', word: 'failed' },
  cancelled: { tone: 'neutral', word: 'was cancelled' },
  review: { tone: 'info', word: 'waits for review' },
}

const lineTone = (request: ActivityRequest): FeedTone => (request.relationship === 'peer' ? 'peer' : 'family')

/** The feed line of one trigger, or undefined for a trigger the feed does not list (a new tool
 *  call, a chip count). */
export function feedLine(trigger: ActivityTrigger, names: ReadonlyMap<string, RunEntry>, now: number): Omit<FeedEntry, 'id' | 'at'> | undefined {
  const who = (runId: string, title?: string) => nameOf(names, runId, title)
  switch (trigger.kind) {
    case 'request-opened': return { tone: lineTone(trigger.request), text: `${who(trigger.request.senderRunId, trigger.request.senderTitle)} asked ${who(trigger.request.recipientRunId, trigger.request.recipientTitle)}` }
    case 'request-closed': return { tone: trigger.status === 'replied' ? 'success' : 'neutral', text: closedText(trigger.request, trigger.status, who) }
    case 'rung-changed': return { tone: attentionOfRung(trigger.task.rung).tone, text: `${trigger.task.title}: ${rootNow(trigger.task, { now, titleOf: (id) => who(id) }).verb}` }
    case 'worker-started': return { tone: 'running', text: `${trigger.worker.title} started` }
    case 'worker-settled': {
      const settled = SETTLED[trigger.worker.status] ?? { tone: 'neutral' as const, word: 'settled' }
      return { tone: settled.tone, text: `${trigger.worker.title} ${settled.word}` }
    }
    case 'card-entered': return { tone: attentionOfRung(trigger.task.rung).tone, text: `${trigger.task.title} started` }
    case 'card-left': return { tone: 'neutral', text: `${trigger.task.title} left active work` }
    case 'check-passed': return { tone: 'success', text: `PR ${trigger.pr}: check “${trigger.name}” passed` }
    default: return undefined
  }
}

/** The feed after one snapshot's triggers: their lines first (in trigger order), then the older
 *  entries, cut to `FEED_SIZE`. `nextId` numbers the new entries. */
export function pushFeed(feed: readonly FeedEntry[], lines: readonly Omit<FeedEntry, 'id' | 'at'>[], at: number, nextId: number): FeedEntry[] {
  const added = lines.map((line, i) => ({ ...line, id: nextId + i, at }))
  return [...added, ...feed].slice(0, FEED_SIZE)
}

/** A feed age: "now" for the first 5 s, then seconds, then minutes. */
export function feedAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min`
}
