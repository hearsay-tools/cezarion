import { runTitle } from '@/lib/task-groups'
import type { ApiRun, RelatedRunTitle, Runner, RunSummary } from '@open-mercato/cezar-api-client'

import type { ThreadConversationMessage } from './thread-state'

export type TaskTitleMap = Readonly<Record<string, string>>
export type RecipientBackendMap = Readonly<Record<string, Runner | undefined>>

/** The current session's backend can override the run's original runner. List rows are
 *  summaries (#817) that carry it pre-derived; the open run is a full record. */
export function recipientBackendsFromRuns(current: ApiRun, runs: readonly RunSummary[] | undefined): RecipientBackendMap {
  const backends: Record<string, Runner | undefined> = {}
  for (const run of runs ?? []) backends[run.id] = run.currentStepBackend ?? run.runner
  backends[current.id] = current.steps.find(step => step.id === current.currentStepId)?.backend ?? current.runner
  return backends
}

/** `related` is the relationships answer's titles (#864): the parent and workers the run list no
 *  longer carries once they are archived. A run list row wins, as the fresher of the two. */
export function titlesFromRuns(current: ApiRun, runs: readonly RunSummary[] | undefined, related: readonly RelatedRunTitle[] = []): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const run of related) titles[run.id] = runTitle(run)
  for (const run of runs ?? []) titles[run.id] = runTitle(run)
  titles[current.id] = runTitle(current)
  return titles
}

export function taskTitleFor(runId: string, titles: TaskTitleMap | undefined): string {
  return titles?.[runId] ?? 'Task'
}

/** The title text a card can know without a server read: a peer the run list lacks stays unnamed. */
export function counterpartTitle(runId: string, peer: boolean, titles: TaskTitleMap | undefined): string {
  return peer ? titles?.[runId] ?? 'peer task' : taskTitleFor(runId, titles)
}

export function conversationDirection(
  message: Pick<ThreadConversationMessage, 'senderRunId'>,
  viewerRunId: string,
): 'outbound' | 'inbound' {
  return message.senderRunId === viewerRunId ? 'outbound' : 'inbound'
}

/** A message between two root tasks of one project. An absent field reads as `family`. */
export function isPeerMessage(message: Pick<ThreadConversationMessage, 'relationship'> | undefined): boolean {
  return message?.relationship === 'peer'
}

export function conversationKindLabel(kind: ThreadConversationMessage['messageKind']): string {
  switch (kind) {
    case 'request':
      return 'Request'
    case 'progress':
      return 'Progress'
    case 'follow-up':
      return 'Follow-up'
    case 'reply':
      return 'Reply'
  }
}

export function conversationOutcomeLabel(status: NonNullable<ThreadConversationMessage['outcome']>['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'replied':
      return 'Replied'
    case 'replied-late':
      return 'Replied late'
    case 'timed-out':
      return 'Timed out'
    case 'cancelled':
      return 'Cancelled'
    case 'completed-without-reply':
      return 'Completed without reply'
    case 'failed':
      return 'Failed'
    case 'destroyed':
      return 'Destroyed'
    case 'sender-closed':
      return 'Sender closed'
    case 'human-fallback':
      return 'Sent to a human'
    case 'deleted':
      return 'Recipient deleted'
  }
}

/** What the card says happened to a request: its recorded (or synthesized pending) outcome,
 *  or — for a request the engine never enqueued — the delivery that ended it. Anything else
 *  carries no status of its own. */
export function conversationStatusLabel(
  message: Pick<ThreadConversationMessage, 'messageKind' | 'delivery' | 'outcome'>,
): string | undefined {
  if (message.outcome) return conversationOutcomeLabel(message.outcome.status)
  if (message.delivery === 'not-delivered') {
    return conversationDeliveryLabel('not-delivered')
  }
  return undefined
}

export function conversationDeliveryLabel(delivery: ThreadConversationMessage['delivery']): string {
  switch (delivery) {
    case 'queued':
      return 'Queued'
    case 'delivered':
      return 'Delivered'
    case 'consumed':
      return 'Read'
    case 'not-delivered':
      return 'Not delivered'
  }
}

/** Why a message is waiting or was not delivered, and what comes next. The server's own
 *  `instruction` wins. Otherwise the text follows the message's state and, for a queued one, the
 *  recipient's backend, since it decides whether delivery waits for a turn to end. */
export function conversationDeliveryExplanation(
  message: Pick<ThreadConversationMessage, 'instruction' | 'delivery' | 'state' | 'relationship'>,
  recipientBackend: Runner | undefined,
): string | undefined {
  if (message.instruction !== undefined) return message.instruction
  if (message.delivery === 'queued') {
    const timing = recipientBackend === 'cursor'
      ? 'Queued for delivery. If Cursor is in a turn, delivery waits for that turn to end.'
      : recipientBackend
        ? 'Queued for delivery. This agent can receive messages during its current turn.'
        : 'Queued for delivery. Timing depends on the recipient agent.'
    return `${timing} Pending messages are batched within the size limit; human questions and scheduler capacity can delay delivery.`
  }
  if (message.state === 'continuation-required') {
    return isPeerMessage(message)
      ? 'Not delivered. The recipient is not running. Only its human can continue it.'
      : 'Not delivered. The recipient needs a new instruction to resume. A parent can resume its owned worker with cez worker resume; workers cannot resume parents.'
  }
  return message.state === 'destroyed' ? 'Not delivered. This worker was destroyed.' : undefined
}
