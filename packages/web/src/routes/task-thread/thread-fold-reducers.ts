import type { PlanEntry, PlanStatus, RunEvent, StopReason, UiAskQuestion, UiItem, UiPermissionRequestedEvent, UiToolItem } from '@open-mercato/cezar-api-client'
import { toolDisplay } from '@open-mercato/cezar-api-client/protocol/tool-display'
import {
  agentInputEventSchema,
  conversationMessageEventSchema,
  requestOutcomeEventSchema,
} from '@open-mercato/cezar-api-client/contract/events'
import { askCardOf, askOf } from '@open-mercato/cezar-api-client/contract/pending-ask'
import { previewServerSchema, previewServerStateSchema } from '@open-mercato/cezar-api-client/contract/preview'

import {
  attachRequestOutcome,
  clockTime,
  currentTurn,
  expirePermissions,
  isRecord,
  itemKey,
  newTurn,
  providerId,
  pushMeta,
  stamp,
  str,
  upsertConversation,
  upsertV2,
  type DraftEntry,
  type DraftTurn,
  type FoldState,
} from './thread-fold-state'
import type { ThreadAsk, ThreadEntry, ThreadImage, ThreadPermission } from './thread-state'

/**
 * One reducer per event family (hearsay-tools/cezarion#1597). Every reducer is total: a malformed
 * event costs itself, never a throw and never a turn. `applyThreadEvent` is the only entry point.
 */
type EventReducer = (fold: FoldState, event: RunEvent) => void

// ---- task webhook (#589) ------------------------------------------------------------------

function reduceHandoff(fold: FoldState, event: RunEvent): void {
  const at = clockTime(event.ts)
  const message = str(event.message)
  const text = event.notify === false
    ? `Stopped notifying the webhook${at}`
    : `${fold.handedOff ? 'Note sent to webhook' : 'Handed off to webhook'}${at}${message ? ` — ${message}` : ''}`
  fold.handedOff = event.notify !== false
  pushMeta(fold, { kind: 'note', id: `v1:${event.seq}`, text, tone: 'dim', icon: 'handoff' })
}

function reduceWebhookFailed(fold: FoldState, event: RunEvent): void {
  const attempts = typeof event.attempts === 'number' ? event.attempts : undefined
  // Several webhooks per project (hearsay-tools/cezarion#1576): name the one that failed.
  const name = str(event.webhookName)
  const text = `${name ? `Delivery to ${name} failed` : 'Webhook delivery failed'}${str(event.event) ? ` (${str(event.event)})` : ''}${
    attempts ? ` after ${attempts} attempt${attempts === 1 ? '' : 's'}` : ''
  }: ${str(event.error) ?? 'unknown error'}`
  pushMeta(fold, { kind: 'note', id: `v1:${event.seq}`, text, tone: 'danger' })
}

/** An agent sent a report to a project webhook (hearsay-tools/cezarion#1576). */
function reduceWebhookReport(fold: FoldState, event: RunEvent): void {
  const name = str(event.webhookName) ?? 'webhook'
  const title = str(event.title)
  const id = `v1:${event.seq}`
  if (event.ok === false) {
    pushMeta(fold, { kind: 'note', id, text: `Report to ${name} failed: ${str(event.error) ?? 'unknown error'}`, tone: 'danger' })
    return
  }
  const sent = event.dryRun === true ? `Report to ${name} (dry run, nothing sent)` : `Sent report to ${name}`
  const text = `${sent}${clockTime(event.ts)}${title ? ` — ${title}` : ''}`
  pushMeta(fold, event.dryRun === true ? { kind: 'note', id, text, tone: 'dim' } : { kind: 'note', id, text, tone: 'dim', icon: 'handoff' })
}

function reduceWebhookDryRun(fold: FoldState, event: RunEvent): void {
  const payload = (event.payload ?? {}) as { status?: unknown | undefined }
  const text = `Webhook (dry run, nothing sent): ${str(event.event) ?? 'delivery'}${str(payload.status) ? ` · ${str(payload.status)}` : ''}`
  pushMeta(fold, { kind: 'note', id: `v1:${event.seq}`, text, tone: 'dim' })
}

// ---- live preview (#781) ------------------------------------------------------------------

function reducePreviewRegistered(fold: FoldState, event: RunEvent): void {
  const server = previewServerSchema.safeParse(event.server)
  if (!server.success) return
  const previous = fold.previewByPort.get(server.data.port)
  if (previous) previous.turn.entries = previous.turn.entries.filter((e) => e !== previous.draft)
  const turn = currentTurn(fold)
  const draft: DraftEntry = {
    origin: 'meta',
    entry: {
      kind: 'preview-server',
      id: `preview-server:${server.data.port}`,
      server: server.data,
      state: 'registered',
      stateAt: event.ts,
    },
  }
  turn.entries.push(draft)
  fold.previewByPort.set(server.data.port, { turn, draft })
}

function reducePreviewState(fold: FoldState, event: RunEvent): void {
  const state = previewServerStateSchema.safeParse(event.state)
  const live = typeof event.port === 'number' ? fold.previewByPort.get(event.port) : undefined
  if (!state.success || !live || live.draft.entry.kind !== 'preview-server') return
  const { server, id } = live.draft.entry
  // Rebuilt, not patched: a field of the old state (an exit code) must not outlive it.
  live.draft.entry = {
    kind: 'preview-server',
    id,
    server,
    state: state.data,
    stateAt: event.ts,
    ...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}),
    ...(event.reason === 'user' || event.reason === 'idle' ? { reason: event.reason } : {}),
  }
}

// ---- parent/worker conversation (#505) ----------------------------------------------------

function reduceConversationMessage(fold: FoldState, event: RunEvent): void {
  const parsed = conversationMessageEventSchema.safeParse(event)
  if (!parsed.success) return
  const { message, delivery, deliveredAt, consumedAt, ts } = parsed.data
  upsertConversation(fold, message, delivery, { deliveredAt, consumedAt, recordedAt: ts })
}

function reduceRequestOutcome(fold: FoldState, event: RunEvent): void {
  const parsed = requestOutcomeEventSchema.safeParse(event)
  if (!parsed.success) return
  const { outcome } = parsed.data
  const previous = fold.outcomesByRequest.get(outcome.requestId)
  if (previous && !(previous.status === 'timed-out' && outcome.status === 'replied-late')) return
  fold.outcomesByRequest.set(outcome.requestId, outcome)
  attachRequestOutcome(fold, outcome.requestId)
}

function reduceAgentInput(fold: FoldState, event: RunEvent): void {
  const parsed = agentInputEventSchema.safeParse(event)
  if (!parsed.success) return
  const { input } = parsed.data
  if (fold.seenInputs.has(input.id)) return
  fold.seenInputs.add(input.id)
  if (input.conversation) {
    upsertConversation(fold, { id: input.id, text: input.text, createdAt: input.createdAt, ...input.conversation }, 'delivered', { deliveredAt: input.deliveredAt, recordedAt: parsed.data.ts })
    return
  }
  // This context is never a human turn or an ask acknowledgement.
  pushMeta(fold, {
    kind: 'note', id: `agent-input:${input.id}`, text: input.text, tone: 'dim',
    attribution: { source: input.source, parentRunId: input.parentRunId },
  })
}

// ---- turn boundaries ----------------------------------------------------------------------

function reduceUserMessage(fold: FoldState, event: RunEvent): void {
  const text = str(event.text) ?? ''
  const answeredAsk = fold.pendingAsk
  // Client-side resolution of the pending AskUser card (#473): the reply
  // that follows an ask closes it and records the answer.
  if (fold.pendingAsk && !fold.pendingAsk.resolved) {
    fold.pendingAsk.resolved = true
    fold.pendingAsk.answeredBy = 'human'
    if (text !== '') fold.pendingAsk.answer = text
    fold.pendingAsk = undefined
  }
  const turn = newTurn(fold, event.seq)
  const ts = stamp(event.ts)
  turn.userMessage = {
    text,
    ask: answeredAsk,
    imageCount: typeof event.imageCount === 'number' ? event.imageCount : 0,
    images: Array.isArray(event.images) ? event.images.filter((u): u is string => typeof u === 'string') : [],
    ...(ts !== undefined ? { ts } : {}),
  }
  if (ts !== undefined) turn.startedAt = ts
}

function reduceTurnStarted(fold: FoldState, event: RunEvent): void {
  const current = fold.turns.at(-1)
  // A v1 `user-message` line precedes the v2 turn.started for the same turn (observed
  // wire order) — attach rather than opening a duplicate. A turn that already has a v2
  // identity or v2 items is someone else's; open fresh.
  const attached = current && current.turnId === undefined && !current.v2Items ? current : newTurn(fold, event.seq)
  attached.turnId = str(event.turnId)
  // First stamp wins: when the v1 line opened this turn a moment ago, when the user sent
  // it is the honest start — and the two must not disagree on one turn.
  attached.startedAt ??= stamp(event.ts)
}

/** Newest match first: per-session turn ids repeat across steps, and a completion always
 *  belongs to the most recent turn wearing it. */
function turnForCompletion(fold: FoldState, turnId: string | undefined): DraftTurn | undefined {
  for (let i = fold.turns.length - 1; i >= 0; i -= 1) {
    if (fold.turns[i]!.turnId === turnId) return fold.turns[i]
  }
  return fold.turns.at(-1)
}

function reduceTurnCompleted(fold: FoldState, event: RunEvent): void {
  expirePermissions(fold)
  const turn = turnForCompletion(fold, str(event.turnId))
  if (!turn) return
  const ts = stamp(event.ts)
  turn.completed = {
    stopReason: (str(event.stopReason) ?? 'end_turn') as StopReason,
    ...(typeof event.costUsd === 'number' ? { costUsd: event.costUsd } : {}),
    ...(ts !== undefined ? { ts } : {}),
  }
}

// ---- v2 items -----------------------------------------------------------------------------

const UI_ITEM_KINDS: ReadonlySet<unknown> = new Set<UiItem['kind']>(['message', 'reasoning', 'tool', 'hook'])

const isUiItem = (entry: ThreadEntry): entry is UiItem => UI_ITEM_KINDS.has(entry.kind)

/** Validate the discriminant AND the id before trusting the cast: an unknown `kind` would
 *  render a blank row, and a missing `id` would key every such item to the same
 *  `${turn}:undefined` (duplicate React keys) — #minor-item-ingress-guard. */
function validUiItem(value: unknown): UiItem | undefined {
  if (!isRecord(value) || !UI_ITEM_KINDS.has(value.kind)) return undefined
  return typeof value.id === 'string' && value.id !== '' ? value as unknown as UiItem : undefined
}

function reduceItem(fold: FoldState, event: RunEvent): void {
  const item = validUiItem(event.item)
  if (!item) return
  const key = itemKey(event, item.id)
  const located = fold.itemsById.get(key)
  upsertV2(fold, located?.turn ?? currentTurn(fold), item, key, event.type === 'item.completed' ? stamp(event.ts) : undefined)
}

function reduceItemDelta(fold: FoldState, event: RunEvent): void {
  const located = fold.itemsById.get(itemKey(event, str(event.itemId) ?? ''))
  const delta = str(event.delta) ?? ''
  if (!located || delta === '' || !isUiItem(located.entry.entry)) return
  const item = located.entry.entry
  if (event.field === 'output' && item.kind === 'tool') {
    item.output = (item.output ?? '') + delta
  } else if (event.field !== 'output' && (item.kind === 'message' || item.kind === 'reasoning')) {
    item.text += delta
  }
}

// ---- v1 fallback items (skipped once the turn is v2-covered) -------------------------------

function reduceText(fold: FoldState, event: RunEvent): void {
  // No `v2Items` guard, unlike `tool-call` below: whether this line has a v2 twin is
  // decided by TEXT at the end of the fold, not by the latch. Suppressing it here would
  // lose any prose v2 never described (claude's `msg.result` fallback).
  const turn = currentTurn(fold)
  const text = str(event.text) ?? ''
  if (text === '') return
  const ts = stamp(event.ts)
  turn.entries.push({
    origin: 'v1',
    entry: { kind: 'message', id: `v1:${event.seq}`, role: 'assistant', text, ...(ts !== undefined ? { ts } : {}) },
  })
}

/** Every `PlanStatus`, so an unrecognized status is the only thing that falls back to
 *  `pending` below. `Set<PlanStatus>` accepts a subset without complaint, so this list
 *  has to be kept honest by hand when the union grows. */
const PLAN_STATUSES: ReadonlySet<string> = new Set<PlanStatus>(['pending', 'in_progress', 'completed', 'cancelled'])

/**
 * Pre-v2 transcripts carry the plan only as TodoWrite input (`{todos: [{content, status,
 * activeForm}]}` — the documented Claude wire shape). Recovered so old runs get the dock too;
 * v2-covered turns never need this (their mappers emit `plan.updated`). All-or-nothing: one
 * malformed entry means the input is not the shape we claim to understand.
 */
function planFromTodos(input: unknown): PlanEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined
  const entries: PlanEntry[] = []
  for (const todo of input.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string') return undefined
    entries.push({
      content: todo.content,
      status: PLAN_STATUSES.has(todo.status as string) ? (todo.status as PlanStatus) : 'pending',
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
    })
  }
  return entries
}

/** Codex collaboration bookkeeping has no user-facing meaning. Protocol v2 normalizes it into
 *  task rows and parented child tools; old/mixed recordings can still carry a receiver-less v1
 *  wait in a child turn. */
const CODEX_COLLAB_BOOKKEEPING = new Set(['subAgentActivity', 'collabAgentToolCall', 'collabToolCall'])

function reduceToolCall(fold: FoldState, event: RunEvent): void {
  const turn = currentTurn(fold)
  const name = str(event.tool) ?? 'Tool'
  if (turn.v2Items || CODEX_COLLAB_BOOKKEEPING.has(name)) return
  const display = toolDisplay(name, event.input)
  // v1-only fallback: the dock's data lives in the TodoWrite input on old transcripts.
  const plan = display.toolKind === 'plan' ? planFromTodos(event.input) : undefined
  if (plan !== undefined) turn.planEntries = plan
  const item: UiToolItem = {
    kind: 'tool',
    id: str(event.id) ?? `v1:${event.seq}`,
    name,
    toolKind: display.toolKind,
    title: display.title,
    status: 'running',
    input: event.input,
  }
  const draft: DraftEntry = { origin: 'v1', entry: item }
  turn.entries.push(draft)
  fold.itemsById.set(item.id, { turn, entry: draft })
}

/** v1 tool results are strings today; anything else is rendered as JSON rather than dropped. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function reduceToolResult(fold: FoldState, event: RunEvent): void {
  const located = fold.itemsById.get(str(event.toolCallId) ?? '')
  if (!located || located.turn.v2Items || located.entry.origin !== 'v1') return
  const item = located.entry.entry
  if (item.kind !== 'tool') return
  item.status = 'completed'
  item.output = resultText(event.result)
}

// ---- lines that always render -------------------------------------------------------------

/** A `message` line as a note with an event-derived tone; an empty message renders nothing. */
function pushMessageNote(fold: FoldState, event: RunEvent, id: string, tone: 'dim' | 'danger'): void {
  const text = str(event.message) ?? ''
  if (text !== '') pushMeta(fold, { kind: 'note', id, text, tone })
}

function reduceNote(fold: FoldState, event: RunEvent): void {
  // Notes are dim by default — they are commentary. A note may opt into
  // `tone: 'danger'` when it reports something the user actually lost, so
  // it does not render as the dimmest line in the thread (#936). Events
  // written before that field exists carry no `tone` and stay dim.
  pushMessageNote(fold, event, `v1:${event.seq}`, event.tone === 'danger' ? 'danger' : 'dim')
}

function reduceError(fold: FoldState, event: RunEvent): void {
  pushMessageNote(fold, event, `v1:${event.seq}`, 'danger')
}

function reduceSessionError(fold: FoldState, event: RunEvent): void {
  pushMessageNote(fold, event, `v2:${event.seq}`, 'danger')
}

function reduceStepEnd(fold: FoldState, event: RunEvent): void {
  // Steps stay out of the thread (they are header material) except the one thing the
  // transcript must not hide: a step that failed — mirroring the legacy renderer.
  if (event.status !== 'failed') return
  const suffix = str(event.error) ? ` — ${str(event.error)}` : ''
  pushMeta(fold, { kind: 'note', id: `v1:${event.seq}`, text: `step ${str(event.stepId) ?? '?'} failed${suffix}`, tone: 'danger' })
}

function reduceCheckOutput(fold: FoldState, event: RunEvent): void {
  // A check step's command run (`src/workflows/run.ts` — v1-only: check steps spawn no
  // agent session, so no v2 twin exists). Rendered as an execute tool card so the
  // pass/fail verdict rides the exit-code pill; origin `meta` because it is not an
  // agent item and must survive the mixed-file dedup.
  const command = str(event.command) ?? 'check'
  const exitCode = typeof event.exitCode === 'number' ? event.exitCode : -1
  pushMeta(fold, {
    kind: 'tool',
    id: `v1:${event.seq}`,
    name: 'check',
    toolKind: 'execute',
    title: `Ran ${command}`,
    status: exitCode === 0 ? 'completed' : 'failed',
    output: str(event.text) ?? '',
    exitCode,
  })
}

function reduceProviderAuthRequired(fold: FoldState, event: RunEvent): void {
  // Cezar-owned persisted metadata: accept only the closed provider set and an opaque,
  // bounded incident id. A malformed historical/future line costs itself, never a turn.
  const provider = providerId(event.provider)
  const authFailureId = str(event.authFailureId) ?? ''
  if (provider === undefined || authFailureId.length < 1 || authFailureId.length > 128) return
  pushMeta(fold, { kind: 'provider-auth-required', id: `v1:${event.seq}`, provider, authFailureId })
}

function reduceImage(fold: FoldState, event: RunEvent): void {
  // Only the v1 line carries a served URL; the v2 twin is raw base64 and is dropped by
  // the sink before persistence anyway. No URL → nothing honest to render.
  const url = str(event.url)
  if (url === undefined) return
  const entry: ThreadImage = { kind: 'image', id: `v1:${event.seq}`, url }
  const name = str(event.name)
  if (name !== undefined) entry.name = name
  pushMeta(fold, entry)
}

// ---- session-level ------------------------------------------------------------------------

function reducePlanUpdated(fold: FoldState, event: RunEvent): void {
  if (Array.isArray(event.entries)) currentTurn(fold).planEntries = event.entries as PlanEntry[]
}

function reduceSessionEnded(fold: FoldState, event: RunEvent): void {
  expirePermissions(fold)
  const message = str(event.message)
  fold.sessionEnded = {
    reason: (str(event.reason) ?? 'end_turn') as StopReason,
    ...(message !== undefined ? { message } : {}),
  }
}

// ---- native permissions -------------------------------------------------------------------

type PermissionOption = UiPermissionRequestedEvent['options'][number]
const PERMISSION_OPTION_KINDS: ReadonlySet<unknown> = new Set<PermissionOption['kind']>(['allow_once', 'allow_always', 'reject_once', 'reject_always'])

function isPermissionOption(option: unknown): option is PermissionOption {
  return isRecord(option) && typeof option.id === 'string' && option.id !== '' &&
    typeof option.label === 'string' && option.label !== '' && PERMISSION_OPTION_KINDS.has(option.kind)
}

/** A non-empty list of well-formed options with unique ids, or nothing. */
function permissionOptions(value: unknown): PermissionOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPermissionOption)) return undefined
  return new Set(value.map(option => option.id)).size === value.length ? value : undefined
}

function reducePermissionRequested(fold: FoldState, event: RunEvent): void {
  const requestId = str(event.requestId)
  const title = str(event.title)
  const options = permissionOptions(event.options)
  if (!requestId || !title || fold.permissions.has(requestId) || !options) return
  const itemId = str(event.itemId)
  const details = str(event.details)
  const permission: ThreadPermission = {
    kind: 'permission', id: `permission:${requestId}`, requestId, title,
    options: options.map(option => ({ ...option })), status: 'pending',
    ...(itemId !== undefined ? { itemId } : {}),
    ...(details !== undefined ? { details } : {}),
  }
  fold.permissions.set(requestId, permission)
  pushMeta(fold, permission)
}

function reducePermissionResolved(fold: FoldState, event: RunEvent): void {
  const permission = fold.permissions.get(str(event.requestId) ?? '')
  if (!permission || permission.status !== 'pending') return
  const optionId = str(event.optionId)
  if (optionId !== undefined && permission.options.some(option => option.id === optionId)) {
    permission.status = 'resolved'
    permission.optionId = optionId
  } else {
    permission.status = 'expired'
  }
  const reason = str(event.reason)
  if (reason !== undefined) permission.reason = reason
}

// ---- asks (#473) and worker routing (#505) ------------------------------------------------

function reduceAskRequested(fold: FoldState, event: RunEvent): void {
  // A structured question — render it as an ask card in the current turn. The card is the ask
  // projection's (hearsay-tools/cezarion#1808); an event it cannot show costs one event, never a throw.
  const ask = askOf(event)
  const card = ask && askCardOf(ask)
  if (!card) return
  // The contract's `AskQuestion` and the protocol's `UiAskQuestion` differ only in `| undefined` on optional keys.
  const entry: ThreadAsk = { kind: 'ask', ...card, questions: card.questions as UiAskQuestion[], resolved: false }
  pushMeta(fold, entry)
  fold.pendingAsk = entry
}

/** The pending ask the event names by `askSeq`, while it is still open. */
function openAskFor(fold: FoldState, event: RunEvent): ThreadAsk | undefined {
  const ask = fold.pendingAsk
  return ask && !ask.resolved && ask.askSeq === event.askSeq ? ask : undefined
}

// A worker's question travels to its parent; the parent's reply answers it, and a parent that
// can no longer answer hands it back to the human (the card's chips return).
function reduceWorkerQuestionRouted(fold: FoldState, event: RunEvent): void {
  const ask = openAskFor(fold, event)
  if (!ask) return
  ask.routedToParent = true
  const parentRunId = str(event.parentRunId)
  if (parentRunId !== undefined) ask.parentRunId = parentRunId
}

function reduceWorkerQuestionFallback(fold: FoldState, event: RunEvent): void {
  const ask = openAskFor(fold, event)
  if (ask) ask.routedToParent = false
}

function reduceHumanAskClosed(fold: FoldState, event: RunEvent): void {
  const ask = openAskFor(fold, event)
  if (!ask || (event.reason !== 'finish' && event.reason !== 'superseded')) return
  ask.resolved = true
  ask.closed = event.reason
  fold.pendingAsk = undefined
}

function reduceHumanInputDelivered(fold: FoldState, event: RunEvent): void {
  // A human answer resolves on its `user-message`; only the parent's answer has none.
  const ask = openAskFor(fold, event)
  if (!ask || event.source !== 'parent') return
  ask.resolved = true
  ask.answeredBy = 'parent'
  fold.pendingAsk = undefined
}

const ignore: EventReducer = () => {}

/**
 * Every rendered event type and its reducer. A `Map`, not an object literal, so an event type
 * that names an `Object.prototype` member (`constructor`) still folds to nothing.
 */
const THREAD_EVENT_REDUCERS: ReadonlyMap<string, EventReducer> = new Map<string, EventReducer>([
  ['handoff', reduceHandoff],
  ['webhook.failed', reduceWebhookFailed],
  ['webhook.dry-run', reduceWebhookDryRun],
  ['webhook.report', reduceWebhookReport],
  ['preview.server-registered', reducePreviewRegistered],
  ['preview.server-state', reducePreviewState],
  ['conversation-message', reduceConversationMessage],
  ['request-outcome', reduceRequestOutcome],
  ['agent-input', reduceAgentInput],
  ['user-message', reduceUserMessage],
  ['turn.started', reduceTurnStarted],
  ['turn.completed', reduceTurnCompleted],
  ['item.started', reduceItem],
  ['item.updated', reduceItem],
  ['item.completed', reduceItem],
  ['item.delta', reduceItemDelta],
  ['text', reduceText],
  ['tool-call', reduceToolCall],
  ['tool-result', reduceToolResult],
  ['note', reduceNote],
  ['lifecycle', reduceNote],
  ['error', reduceError],
  ['session.error', reduceSessionError],
  ['step-end', reduceStepEnd],
  ['check-output', reduceCheckOutput],
  ['provider-auth-required', reduceProviderAuthRequired],
  ['image', reduceImage],
  ['plan.updated', reducePlanUpdated],
  ['session.started', (fold) => expirePermissions(fold)],
  ['session.ended', reduceSessionEnded],
  ['permission.requested', reducePermissionRequested],
  ['permission.resolved', reducePermissionResolved],
  ['ask.requested', reduceAskRequested],
  ['worker-question-routed', reduceWorkerQuestionRouted],
  ['worker-question-fallback', reduceWorkerQuestionFallback],
  ['human-ask-closed', reduceHumanAskClosed],
  ['human-input-delivered', reduceHumanInputDelivered],
  // ---- THE v1 VOCABULARY SWEEP (cezar-code-map §3.2) — deliberate suppressions ---------
  // Every persisted v1 type is either rendered above or named here with the surface that
  // owns it instead, so an old transcript reads complete without transcript noise:
  //  - `step-start` / non-failed `step-end`: the run header's step rail (step-rail.tsx)
  //    is the steps surface, same as the legacy divider-free design choice for step ends.
  //  - `token-usage` / `cost`: the header meta line renders the RECORD's running totals;
  //    per-event ticks in the body would just repaint the same numbers.
  //  - `turn-end` / `done`: pure engine control flow — completion already reads from the
  //    run status footer (and `done` is always shadowed by a `lifecycle` line).
  //  - `session`: the backend's session id, surfaced by the header's take-over hint via
  //    the record's `sessionId` — an id line in the transcript helps no one.
  ['step-start', ignore],
  ['token-usage', ignore],
  ['cost', ignore],
  ['turn-end', ignore],
  ['done', ignore],
  ['session', ignore],
])

/**
 * Fold one event into the state. usage.updated and anything future: header/telemetry
 * material or not yet rendered — never guessed at in the thread body. (Deliberate
 * divergence from the legacy raw-JSON-note fallback: an unknown type renders as
 * nothing rather than as debug output.)
 */
export function applyThreadEvent(fold: FoldState, event: RunEvent): void {
  THREAD_EVENT_REDUCERS.get(event.type)?.(fold, event)
}
