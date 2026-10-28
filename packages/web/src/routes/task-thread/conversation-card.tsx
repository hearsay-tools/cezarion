import { ChevronRightIcon } from '@/components/design-icons'
import { useContext, useState, type ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { ConversationNavigation } from './conversation-navigation'
import {
  conversationDeliveryExplanation,
  conversationDeliveryLabel,
  conversationDirection,
  conversationKindLabel,
  conversationStatusLabel,
  isPeerMessage,
  counterpartTitle,
  type RecipientBackendMap,
  type TaskTitleMap,
} from './conversation-presentation'
import { Counterpart, type CounterpartView } from './counterpart-task'
import { Markdown } from './markdown'
import type { WorkerConversationBatch, WorkerConversationBlock } from './thread-groups'
import { useThreadCardCache } from './thread-open-cards'
import { clockLabel, MessageTime } from './thread-time'
import type { ThreadConversationMessage } from './thread-state'

/** Parent/worker and peer conversation cards: one card per batch of messages in the task thread. */

const CONVERSATION_SURFACE = {
  outbound: {
    classes: 'border-message-outbound-border bg-message-outbound-bg [html:not(.light)_&]:border-s-[3px] [html:not(.light)_&]:border-s-message-outbound-accent',
    accent: 'text-message-outbound-accent',
  },
  inbound: {
    classes: 'border-message-inbound-border bg-message-inbound-bg [html:not(.light)_&]:border-s-[3px] [html:not(.light)_&]:border-s-message-inbound-accent',
    accent: 'text-message-inbound-accent',
  },
  // A message between two root tasks. One surface for both directions: the heading and
  // `data-direction` still say who sent it, and the "Peer" chip says it is not a worker.
  peer: {
    classes: 'border-message-peer-border bg-message-peer-bg [html:not(.light)_&]:border-s-[3px] [html:not(.light)_&]:border-s-message-peer-accent',
    accent: 'text-message-peer-accent',
  },
} as const

const conversationLinkClass =
  'inline-flex min-h-11 max-w-full items-center break-words underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function WorkerConversationGroup({
  block,
  runId,
  taskTitles,
  recipientBackends,
}: {
  block: WorkerConversationBlock
  runId: string
  taskTitles?: TaskTitleMap | undefined
  recipientBackends?: RecipientBackendMap | undefined
}) {
  return (
    <div data-slot="worker-conversation" className="flex min-w-0 flex-col gap-2">
      {block.batches.map((batch) => (
        <WorkerConversationBatchCard key={batch.id} batch={batch} runId={runId} taskTitles={taskTitles} recipientBackends={recipientBackends} />
      ))}
    </div>
  )
}

function WorkerConversationBatchCard({
  batch,
  runId,
  taskTitles,
  recipientBackends,
}: {
  batch: WorkerConversationBatch
  runId: string
  taskTitles?: TaskTitleMap | undefined
  recipientBackends?: RecipientBackendMap | undefined
}) {
  const direction = conversationDirection(batch.messages[0] ?? { senderRunId: batch.senderRunId }, runId)
  // `groupWorkerConversation` never mixes relationships in one batch, so the first decides.
  const peer = isPeerMessage(batch.messages[0])
  const surface = CONVERSATION_SURFACE[peer ? 'peer' : direction]
  const counterpartIds = uniqueIds(
    batch.messages.map((message) => (direction === 'outbound' ? message.recipientRunId : message.senderRunId)),
  )
  const headingPrefix = direction === 'outbound' ? 'SENT to' : 'RECEIVED from'
  const heading = `${headingPrefix} ${counterpartIds.map((id) => counterpartTitle(id, peer, taskTitles)).join(', ')}`
  const soleMessage = batch.messages[0]
  const sentAt = soleMessage?.createdAt ?? soleMessage?.recordedAt
  return (
    <article
      data-slot="worker-conversation-card"
      data-direction={direction}
      data-relationship={peer ? 'peer' : 'family'}
      data-kind={batch.kind}
      className={cn('flex w-full min-w-0 flex-col gap-2 rounded-[8px] border p-3 md:px-4 md:py-[14px]', surface.classes)}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className={cn('m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] leading-[1.2] font-semibold tracking-[0.6px] uppercase', surface.accent)}>
            <span>{headingPrefix}</span>
            {counterpartIds.map((id, index) => (
              <span key={id} className="inline-flex min-w-0 items-center gap-x-2 normal-case tracking-normal">
                {index > 0 ? <span aria-hidden>,</span> : null}
                <Counterpart id={id} peer={peer} taskTitles={taskTitles}>
                  {view => <CounterpartLink view={view} to={`/tasks/${id}`} label={`${headingPrefix} ${view.title}`} />}
                </Counterpart>
              </span>
            ))}
          </p>
          {peer ? (
            <span data-slot="conversation-relationship" className="rounded-full border border-message-peer-border px-2 py-0.5 text-[11px] font-semibold tracking-[0.05em] text-foreground uppercase">
              Peer
            </span>
          ) : null}
          <span data-slot="conversation-kind" className="rounded-full bg-background/60 px-2 py-0.5 text-[11px] font-semibold tracking-[0.05em] text-foreground uppercase">
            {conversationKindLabel(batch.kind)}
          </span>
          {batch.messages.length === 1 && soleMessage ? <SoleMessageStatus message={soleMessage} /> : null}
        </div>
        <SentTime at={sentAt} className="flex shrink-0 items-center justify-self-end gap-1 whitespace-nowrap text-[11px] text-soft-foreground">
          {batch.messages.length > 1 ? 'First sent' : null}
        </SentTime>
      </div>
      <ConversationBody key={`${runId}:${soleMessage?.messageId ?? batch.id}`} batch={batch} />
      {[...new Set(batch.messages.map(message => conversationDeliveryExplanation(message, recipientBackends?.[message.recipientRunId])))].map(explanation => explanation ? <p key={explanation} data-slot="conversation-delivery-explanation" className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{explanation}</p> : null)}
      {batch.kind === 'request' && batch.messages.length > 1 ? (
        <BatchRecipients messages={batch.messages} peer={peer} runId={runId} taskTitles={taskTitles} />
      ) : null}
      {batch.messages.length === 1 && soleMessage ? (
        <ConversationReference message={soleMessage} runId={runId} taskTitles={taskTitles} />
      ) : null}
      <ConversationInspectDetails batch={batch} heading={heading} />
    </article>
  )
}

/** The send time, when the message carries one the clock can show. */
function SentTime({ at, className, children }: { at: string | undefined; className: string; children?: ReactNode }) {
  if (at === undefined || clockLabel(at) === undefined) return null
  return <span className={className}>{children}<MessageTime ts={at} /></span>
}

/** The outcome and delivery chips of a card that holds one message. A batch lists them per recipient. */
function SoleMessageStatus({ message }: { message: ThreadConversationMessage }) {
  const status = conversationStatusLabel(message)
  const delivery = conversationDeliveryLabel(message.delivery)
  const showsDelivery = (message.messageKind === 'request' || message.messageKind === 'reply') && delivery !== status
  return (
    <>
      {status ? <span data-slot="conversation-outcome" className="text-xs font-medium text-muted-foreground">{status}</span> : null}
      {showsDelivery ? <span data-slot="conversation-delivery" className="text-xs text-muted-foreground">{delivery}</span> : null}
    </>
  )
}

/** The recipients of one request sent to several tasks, each with its own outcome and delivery. */
function BatchRecipients({ messages, peer, runId, taskTitles }: {
  messages: readonly ThreadConversationMessage[]
  peer: boolean
  runId: string
  taskTitles?: TaskTitleMap | undefined
}) {
  return (
    <ul className="grid min-w-0 gap-1 text-xs text-muted-foreground">
      {messages.map((message) => {
        const status = conversationStatusLabel(message)
        const sentAt = message.createdAt ?? message.recordedAt
        return (
          <li key={message.id} className="flex min-h-11 min-w-0 flex-wrap items-center gap-2">
            <Counterpart id={message.recipientRunId} peer={peer} taskTitles={taskTitles}>
              {view => <CounterpartLink view={view} to={`/tasks/${message.recipientRunId}`} label={`${view.title}${status ? ` — ${status}` : ''}`} />}
            </Counterpart>
            {status ? <span data-slot="conversation-outcome">{status}</span> : null}
            {conversationDeliveryLabel(message.delivery) !== status ? (
              <span data-slot="conversation-delivery">{conversationDeliveryLabel(message.delivery)}</span>
            ) : null}
            <ConversationReference message={message} runId={runId} taskTitles={taskTitles} />
            <SentTime at={sentAt} className="ml-auto whitespace-nowrap" />
          </li>
        )
      })}
    </ul>
  )
}

/** Body state belongs to the message, so receipt updates, batching and virtual row
 * remounts keep the reader's choice. Details and navigation remain independent. */
function ConversationBody({ batch }: { batch: WorkerConversationBatch }) {
  const cache = useThreadCardCache()
  const cacheKey = `conversation-body:${batch.messages[0]?.messageId ?? batch.id}`
  const [open, setOpen] = useState(() => cache?.get(cacheKey) ?? false)
  const body = (
    <div className="min-w-0 break-words text-[14px] leading-[1.6] text-foreground select-text [overflow-wrap:anywhere]">
      <Markdown breaks>{batch.text}</Markdown>
    </div>
  )
  if (batch.kind !== 'request' && batch.kind !== 'reply') return body
  return (
    <Collapsible data-slot="conversation-body" open={open} onOpenChange={next => {
      cache?.set(cacheKey, next)
      setOpen(next)
    }} className="min-w-0">
      <CollapsibleTrigger type="button" data-slot="conversation-body-toggle"
        className="group/body inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-md px-2 text-start text-xs font-medium text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-background/40 [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground active:bg-background/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 group-data-[state=open]/body:rotate-90" />
        {open ? 'Hide message' : 'Show message'}
      </CollapsibleTrigger>
      <CollapsibleContent>{body}</CollapsibleContent>
    </Collapsible>
  )
}

/** The counterpart's name, a link to its thread when that thread can be opened. */
function CounterpartLink({ view, to, label }: { view: CounterpartView; to: string; label: string }) {
  if (!view.linkable) return <span data-slot="conversation-counterpart">{view.title}</span>
  return <Link className={conversationLinkClass} to={to} aria-label={label}>{view.title}</Link>
}

function ConversationReference({
  message,
  runId,
  taskTitles,
}: {
  message: ThreadConversationMessage
  runId: string
  taskTitles?: TaskTitleMap | undefined
}) {
  const { targets, replies, navigate } = useContext(ConversationNavigation)
  const request = message.requestId ? targets.get(message.requestId) : undefined
  // A late reply can retain a cancelled or other settled outcome, so correlation
  // comes from the reply envelope, not exclusively from outcome.replyId.
  const linked = message.requestId ? (request ? [request] : []) : replies.get(message.messageId) ?? []
  const kind = message.requestId ? 'request' : 'reply'
  if (linked.length === 0) return message.requestId || message.outcome?.replyId ? (
    <p data-slot="conversation-connector" className="text-xs text-muted-foreground">
      Linked {kind} is outside loaded history.
    </p>
  ) : null
  return linked.map(target => {
    const outbound = conversationDirection(target.message, runId) === 'outbound'
    const counterpart = outbound ? target.message.recipientRunId : target.message.senderRunId
    return (
      <button key={target.message.messageId} type="button" data-slot="conversation-connector"
        className={cn(conversationLinkClass, 'w-fit gap-1.5 text-xs text-muted-foreground')}
        onClick={() => navigate(target)}>
        <span aria-hidden>↗</span>
        <Counterpart id={counterpart} peer={isPeerMessage(target.message)} taskTitles={taskTitles}>
          {view => <>View {kind} {outbound ? 'to' : 'from'} {view.title}</>}
        </Counterpart>
      </button>
    )
  })
}

function ConversationInspectDetails({ batch, heading }: { batch: WorkerConversationBatch; heading: string }) {
  return (
    <Collapsible data-slot="conversation-details" className="group/details">
      <CollapsibleTrigger type="button" className="inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-md px-2 text-left text-xs font-medium text-muted-foreground hover:bg-background/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]/details:rotate-90" />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid min-w-0 gap-1 break-all px-2 pb-1 font-mono text-[11px] text-muted-foreground">
          <div className="sr-only">{heading}</div>
          {batch.messages.flatMap((message) => inspectRows(message)).map((row, index) => (
            <div key={`${row.label}:${row.value}:${index}`}>
              <dt className="inline font-sans font-medium text-soft-foreground">{row.label}: </dt>
              <dd className="inline">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

function inspectRows(message: ThreadConversationMessage): Array<{ label: string; value: string }> {
  const rows = [
    { label: 'Message', value: message.messageId },
    { label: 'Sender', value: message.senderRunId },
    { label: 'Recipient', value: message.recipientRunId },
    ...(isPeerMessage(message) ? [{ label: 'Relationship', value: 'peer' }] : []),
    { label: 'Delivery', value: conversationDeliveryLabel(message.delivery) },
  ]
  if (message.requestId) rows.push({ label: 'Request', value: message.requestId })
  if (message.outcome?.replyId) rows.push({ label: 'Reply', value: message.outcome.replyId })
  if (message.state) rows.push({ label: 'State', value: message.state })
  if (message.createdAt) rows.push({ label: 'Created', value: message.createdAt })
  if (message.deliveredAt) rows.push({ label: message.resumed ? 'Opening turn completed' : 'Delivery acknowledged', value: message.deliveredAt })
  if (message.recordedAt) rows.push({ label: 'Event recorded', value: message.recordedAt })
  if (message.resumed) rows.push({ label: 'Continuation', value: 'Requested by parent with this instruction' })
  if (message.deadline) rows.push({ label: 'Deadline', value: message.deadline })
  if (message.requestHash) rows.push({ label: 'Hash', value: message.requestHash })
  return rows
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return unique
}
