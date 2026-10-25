import type {
  RunEvent,
  RunStatus,
  ConversationMessage,
  PlanEntry,
  RequestOutcome,
  StopReason,
  UiAskQuestion,
  UiItem,
  UiPermissionRequestedEvent,
} from '@open-mercato/cezar-api-client'
import type { PreviewServer, PreviewServerState } from '@open-mercato/cezar-api-client/contract/preview'

import { applyThreadEvent } from './thread-fold-reducers'
import { createFoldState, type DraftEntry, type DraftTurn, type FoldState } from './thread-fold-state'

/**
 * Pure, total fold of ordered v1 and v2 events into turns. Prefer v2 tools; preserve v1-only
 * content. Deduplicate message twins by normalized text only when matching v2 prose exists.
 * Malformed events must not break the transcript. Each event family has its own reducer in
 * `thread-fold-reducers.ts`, over the explicit state in `thread-fold-state.ts`.
 */

/** A dim/danger transcript line (v1 note/lifecycle/error, v2 non-fatal session.error). */
export interface ThreadNote {
  kind: 'note'
  id: string
  text: string
  tone: 'dim' | 'danger'
  attribution?: { source: 'agent' | 'lifecycle'; parentRunId: string }
  /** Lifecycle/agent-input receipt overlay from `run.agentInputs` (#971). Absent when no receipt. */
  delivery?: 'queued' | 'delivered' | 'consumed'
  /** A task-webhook hand-off line (#589), or a sent agent report (#1576) — rendered with the send
   *  glyph, not the dim bullet. */
  icon?: 'handoff' | undefined
}

export type ThreadConversationDelivery = 'queued' | 'delivered' | 'consumed' | 'not-delivered'

/** A parent/worker conversation envelope, with its request outcome folded onto the request. */
export interface ThreadConversationMessage {
  kind: 'conversation'
  id: string
  messageId: string
  text: string
  senderRunId: string
  recipientRunId: string
  messageKind: ConversationMessage['kind']
  requestId?: string | undefined
  delivery: ThreadConversationDelivery
  deliveredAt?: string | undefined
  /** When the recipient's harness reported the model read it (#505). */
  consumedAt?: string | undefined
  recordedAt?: string
  instruction?: string | undefined
  resumed?: true | undefined
  state?: ConversationMessage['state'] | undefined
  createdAt?: string
  requestHash?: string
  deadline?: string | undefined
  outcome?: { status: RequestOutcome['status'] | 'pending'; replyId?: string; observedAt?: string }
}

/** An image the run persisted (v1 `image` line: served from `/api/runs/:id/images/…`). */
export interface ThreadImage {
  kind: 'image'
  id: string
  url: string
  name?: string | undefined
}

/**
 * A structured AskUser question the agent posed via `CEZ:ASK` (#473, v2
 * `ask.requested`). The cockpit renders it as clickable option chips. Resolution
 * is client-side: the next `user-message` for the run flips `resolved` and
 * records the reply as `answer`, so a reloaded thread reconstructs the same
 * resolved/pending state from the persisted stream.
 */
export interface ThreadAsk {
  kind: 'ask'
  id: string
  questions: UiAskQuestion[]
  /** Markdown the agent sent with the question (hearsay-tools/cezarion#1458); absent on older asks. */
  context?: string
  resolved: boolean
  answer?: string
  /** The `ask.requested` event seq a routing/fallback event names (#505). */
  askSeq?: number
  /** A worker's question sent to its parent task: answered there, not from this card (#505). */
  routedToParent?: boolean
  parentRunId?: string
  answeredBy?: 'human' | 'parent'
  /** Finish ended the task with the question unanswered (hearsay-tools/cezarion#1260), or new input
   *  superseded a worker's fallback question (hearsay-tools/cezarion#1301). */
  closed?: 'finish' | 'superseded'
  /** View-only, set by `mainTranscriptSections` (hearsay-tools/cezarion#1495), never by the
   *  reducer: the pending ask's answerable copy after the newest entry, or its original place. */
  placement?: 'origin' | 'pinned' | undefined
}

/** Native approvals belong to the live request that offered the choices, never a later turn. */
export type ThreadPermission = Omit<UiPermissionRequestedEvent, 'type'> & {
  kind: 'permission'
  id: string
  status: 'pending' | 'resolved' | 'expired'
  optionId?: string
  reason?: string | undefined
}

/** A persisted, cezar-owned recovery marker for a provider's runtime authentication failure. */
export interface ThreadProviderAuthRequired {
  kind: 'provider-auth-required'
  id: string
  provider: 'claude' | 'codex' | 'opencode' | 'pi' | 'cursor' | 'omp'
  authFailureId: string
}

/**
 * A dev server the agent registered with `cezar_preview_serve` (#781). One entry per port, placed at
 * the registration event (right after the tool call) and kept current by the later
 * `preview.server-state` events, so the card is right while the pane is closed and in history.
 */
export interface ThreadPreviewServer {
  kind: 'preview-server'
  id: string
  server: PreviewServer
  state: PreviewServerState
  /** When `state` was last set: the registration, or the latest state event. */
  stateAt?: string
  exitCode?: number
  reason?: 'user' | 'idle' | undefined
}

/** Event time belongs to the web transcript, not the backend UiItem protocol. */
export type ThreadMessage = Extract<UiItem, { kind: 'message' }> & { ts?: string | undefined }
export type ThreadEntry = Exclude<UiItem, { kind: 'message' }> | ThreadMessage | ThreadNote | ThreadImage | ThreadAsk | ThreadPermission | ThreadProviderAuthRequired | ThreadConversationMessage | ThreadPreviewServer

export interface ThreadTurn {
  /** Stable source-derived render key. The opening event sequence survives prepended pages;
   *  ordinal fallback exists only for malformed legacy content with no boundary event. */
  id: string
  /** The protocol-v2 turnId, once known. */
  turnId?: string | undefined
  /** The v1 `user-message` that opened this turn. The FIRST turn usually has none — the initial
   *  prompt is the run's `task`, which the view renders from the run record. `ts` is when that
   *  line was persisted (#941). */
  userMessage?: { text: string; imageCount: number; images: string[]; ts?: string | undefined; ask?: ThreadAsk | undefined }
  /** Wall clock of the event that OPENED this turn — the `user-message` line when there is one,
   *  otherwise `turn.started` (#941). First stamp wins, so the v1 line and the v2 event that
   *  follow each other for the same turn produce one coherent start rather than two. This is the
   *  left-hand side of the turn duration. */
  startedAt?: string | undefined
  items: ThreadEntry[]
  /** Latest `plan.updated` snapshot seen during this turn (full-replacement semantics). */
  planEntries?: PlanEntry[]
  completed?: { stopReason: StopReason; costUsd?: number; ts?: string | undefined }
}

export interface ThreadState {
  turns: ThreadTurn[]
  /** v2 `session.ended` — the last one wins (each step runs its own session). */
  sessionEnded?: { reason: StopReason; message?: string }
}

export interface ThreadReduceOptions {
  /** The current assistant turn still belongs to a running session. A complete
   * trailing ask block is provisional protocol text until turn-end either
   * emits its card or settles into the readable invalid-marker fallback. */
  activeTurn?: boolean
}

/** What the strip under the thread says. Pure so the mapping is table-testable. */
export type ThreadFooter =
  | { state: 'waiting' }
  | { state: 'closed'; label: string; tone: 'dim' | 'danger' }
  | null

/**
 * The plan the dock shows: the LATEST snapshot across all turns (full-replacement semantics —
 * every `plan.updated` supersedes everything before it, including one from an earlier turn).
 * An empty latest snapshot is returned as-is: it replaced the plan with nothing, which is not
 * the same as never having had one.
 */
export function latestPlanEntries(state: ThreadState): PlanEntry[] | undefined {
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const entries = state.turns[i]!.planEntries
    if (entries !== undefined) return entries
  }
  return undefined
}

/**
 * Every file path the run's tool items are known to have touched (edit diffs + read/edit
 * locations), most recently touched first — TODAY'S source for the composer's `@` mentions.
 * R5's `/files` API replaces this with a worktree-wide search through the same composer seam
 * (`getMentionCandidates`); this stays as the offline-honest fallback.
 */
export function threadFilePaths(state: ThreadState): string[] {
  const seen: string[] = []
  for (const turn of state.turns) {
    for (const item of turn.items) {
      if (item.kind !== 'tool') continue
      for (const location of item.locations ?? []) seen.push(location.path)
      for (const diff of item.diffs ?? []) seen.push(diff.path)
    }
  }
  // Later mention beats earlier: keep each path's LAST occurrence, then newest first.
  const deduped: string[] = []
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    if (!deduped.includes(seen[i]!)) deduped.push(seen[i]!)
  }
  return deduped
}

export function threadFooter(status: RunStatus, error?: string): ThreadFooter {
  switch (status) {
    case 'waiting':
      return { state: 'waiting' }
    case 'failed':
      return { state: 'closed', tone: 'danger', label: error ? `Session failed — ${error}` : 'Session failed' }
    case 'review':
      return { state: 'closed', tone: 'dim', label: 'Session closed — waiting for your review' }
    case 'done':
    case 'cancelled':
      return { state: 'closed', tone: 'dim', label: 'Session closed' }
    default:
      // queued/running: the stream itself is the status.
      return null
  }
}

// ---- the fold -----------------------------------------------------------------------------

/** The engine's turn-end markers (`CEZ:DONE`, `CEZ:MONITORING` from #490) plus the in-band
 *  task-reference marker lines (`CEZ:PR=` / `CEZ:ISSUE=` / `CEZ:TITLE=`, spec
 *  2026-07-18-task-ref-markers). v1 `text` lines arrive pre-stripped by the server; v2 message
 *  items carry the raw text, so display strips them here. Named `stripDoneMarker` for
 *  continuity — it now strips every protocol marker. Mirrors `stripTaskMarkers` in
 *  `src/runs/task-markers.ts`.
 *
 *  `stripAsk` gates the `CEZ:ASK` strip on the turn actually holding an ask card (#473): the
 *  card is the only other place the questions exist, so a marker whose card never materialized
 *  (invalid payload, or the session died before turn-end) must stay visible as raw text — the
 *  user can still read the question and answer via the composer. Hiding it would delete the
 *  question from the thread entirely. */
function stripDoneMarker(text: string, stripAsk: boolean): string {
  let trailing = text
    .replace(/\s*CEZ:DONE\s*$/, '')
    .replace(/\s*CEZ:MONITORING\s*$/, '')
  if (stripAsk) {
    const trimmed = trailing.trimEnd()
    const lineStart = trimmed.lastIndexOf('\n') + 1
    if (/^CEZ:ASK[ \t]+.+$/.test(trimmed.slice(lineStart))) {
      trailing = trimmed.slice(0, lineStart).trimEnd()
    }
  }
  if (!trailing.includes('CEZ:')) return trailing
  return trailing
    .split('\n')
    .filter((line) => !/^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/.test(line))
    .join('\n')
}

/**
 * Repair for legacy per-delta transcripts: codex/opencode runs recorded before the runners
 * coalesced v1 `text` per item persisted one `text` line PER STREAMING TOKEN, so the fold
 * synthesized one message per token ("github" / ".com" / "merc" / "ato" …, each its own
 * paragraph) and the exact-match dedup never fired — no single token equals the v2 message.
 * The tokens ARE the v2 message, just cut up: a run of consecutive v1 messages whose
 * concatenation reassembles a v2 message of the turn (or all of them in order, when v1 tool
 * suppression made several messages adjacent) is dropped as a whole; the v2 twin renders.
 * The comparison ignores whitespace — the server dropped whitespace-only deltas at persist
 * time — and strips markers on the CONCATENATION, catching `CEZ:DONE` split across tokens,
 * which per-event stripping let through. A run that reassembles nothing is kept untouched.
 */
function dropLegacyDeltaRuns(draft: DraftTurn): void {
  // Marker-insensitive comparison (stripAsk: true): the v1 side may or may not carry the
  // marker depending on server-side validation, so equality must ignore it either way.
  const norm = (text: string) => stripDoneMarker(text, true).replace(/\s+/g, '')
  const v2Norms = new Set<string>()
  const inOrder: string[] = []
  for (const { origin, entry } of draft.entries) {
    if (origin === 'v2' && entry.kind === 'message') {
      const n = norm(entry.text)
      v2Norms.add(n)
      inOrder.push(n)
    }
  }
  if (inOrder.length === 0) return
  v2Norms.add(inOrder.join(''))
  const kept: DraftEntry[] = []
  let run: { entries: DraftEntry[]; texts: string[] } = { entries: [], texts: [] }
  const flushRun = () => {
    // Single entries already had their chance in the exact-match filter above — only a
    // genuine run (≥2 fragments) is a delta artifact worth reassembling.
    if (run.entries.length >= 2 && v2Norms.has(norm(run.texts.join('')))) {
      run = { entries: [], texts: [] }
      return
    }
    kept.push(...run.entries)
    run = { entries: [], texts: [] }
  }
  for (const e of draft.entries) {
    if (e.origin === 'v1' && e.entry.kind === 'message') {
      run.entries.push(e)
      run.texts.push(e.entry.text)
    } else {
      flushRun()
      kept.push(e)
    }
  }
  flushRun()
  draft.entries = kept
}

/** Deduplicate v1 prose only when this turn contains a matching v2 message. Compare
 *  marker-stripped, trimmed text; unmatched v1-only prose must remain visible. */
function dropTwinnedV1Messages(draft: DraftTurn): void {
  const v2Texts = new Set<string>()
  for (const { origin, entry } of draft.entries) {
    // stripAsk: true — dedup equality must ignore the marker on both sides (see norm()).
    if (origin === 'v2' && entry.kind === 'message') v2Texts.add(stripDoneMarker(entry.text, true).trim())
  }
  if (v2Texts.size === 0) return
  draft.entries = draft.entries.filter(
    (e) =>
      !(e.origin === 'v1' && e.entry.kind === 'message' && v2Texts.has(stripDoneMarker(e.entry.text, true).trim())),
  )
  dropLegacyDeltaRuns(draft)
}

/**
 * Only a request the engine actually enqueued can still settle: `delegation/service.ts`
 * enqueues when the recipient is neither destroyed nor resumable, and gives only those
 * requests a deadline. A `continuation-required`/`destroyed` request has no obligation and
 * no future outcome, so synthesizing "pending" for it would promise a reply nobody owes.
 */
function markPendingRequests(fold: FoldState): void {
  for (const entry of fold.conversationEntries.values()) {
    if (entry.messageKind !== 'request' || entry.outcome !== undefined) continue
    if (entry.delivery === 'not-delivered') continue
    if (entry.state !== undefined && entry.state !== 'accepted') continue
    entry.outcome = { status: 'pending' }
  }
}

/** A draft turn as the view reads it, with protocol markers stripped from assistant prose. */
function finishTurn(draft: DraftTurn, provisionalAsk: boolean): ThreadTurn {
  // The ask card renders the questions, so only then is the marker redundant (#473).
  const stripAsk = provisionalAsk || draft.entries.some(({ entry }) => entry.kind === 'ask')
  return {
    id: draft.id,
    ...(draft.turnId !== undefined ? { turnId: draft.turnId } : {}),
    ...(draft.userMessage !== undefined ? { userMessage: draft.userMessage } : {}),
    ...(draft.startedAt !== undefined ? { startedAt: draft.startedAt } : {}),
    ...(draft.planEntries !== undefined ? { planEntries: draft.planEntries } : {}),
    ...(draft.completed !== undefined ? { completed: draft.completed } : {}),
    items: draft.entries.map(({ entry }) =>
      entry.kind === 'message' && entry.role === 'assistant'
        ? { ...entry, text: stripDoneMarker(entry.text, stripAsk) }
        : entry,
    ),
  }
}

export function reduceThread(events: RunEvent[], options: ThreadReduceOptions = {}): ThreadState {
  const fold = createFoldState()
  for (const event of events) applyThreadEvent(fold, event)
  for (const draft of fold.turns) {
    if (draft.v2Items) dropTwinnedV1Messages(draft)
  }
  markPendingRequests(fold)
  const lastIndex = fold.turns.length - 1
  return {
    // A completed v2 assistant item lands before the v1 turn-end handler can
    // parse the marker and emit ask.requested. Hide that provisional transport
    // block only on the live latest turn. Once the run leaves `running`, a
    // hard-invalid marker returns as readable fallback (#671).
    turns: fold.turns.map((draft, index) => finishTurn(draft, options.activeTurn === true && index === lastIndex)),
    ...(fold.sessionEnded !== undefined ? { sessionEnded: fold.sessionEnded } : {}),
  }
}
