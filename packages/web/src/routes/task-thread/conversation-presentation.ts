import { runTitle } from '@/lib/task-groups'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import type { ThreadConversationMessage } from './thread-state'

export type TaskTitleMap = Readonly<Record<string, string>>

export function titlesFromRuns(current: ApiRun, runs: readonly ApiRun[] | undefined): Record<string, string> {
  const titles: Record<string, string> = { [current.id]: runTitle(current) }
  for (const run of runs ?? []) titles[run.id] = runTitle(run)
  return titles
}

export function taskTitleFor(runId: string, titles: TaskTitleMap | undefined): string {
  return titles?.[runId] ?? 'Task'
}

export function conversationDirection(
  message: Pick<ThreadConversationMessage, 'senderRunId'>,
  viewerRunId: string,
): 'outbound' | 'inbound' {
  return message.senderRunId === viewerRunId ? 'outbound' : 'inbound'
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
    default:
      return kind
  }
}

export function conversationOutcomeLabel(status: NonNullable<ThreadConversationMessage['outcome']>['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'replied':
      return 'Replied'
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
    default:
      return status
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
    default:
      return delivery
  }
}
