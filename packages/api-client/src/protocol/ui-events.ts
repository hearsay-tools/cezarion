import type { ToolKind } from '@open-mercato/cezar-contract/tool-display';
/**
 * Browser-side normalized protocol vocabulary. Keep type exactness with the service through
 * api-types checks; infer shared permission vocabulary from Node-free contract schemas.
 */

import type { PermissionRequest, PermissionResolution } from '@open-mercato/cezar-contract'
export type { PermissionOption, PermissionOptionKind } from '@open-mercato/cezar-contract'

/** The backend that produced a session. */
export type UiBackend = 'claude' | 'codex' | 'opencode' | 'pi' | 'cursor' | 'omp'

/** Tool lifecycle status (ACP-aligned; `running` ≡ ACP `in_progress`). */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined'

/** Icon/verb hint for a tool item — a superset of ACP's ToolKind. */
export type { ToolKind } from '@open-mercato/cezar-contract/tool-display'

/** Why a turn (or the session) stopped. */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'timeout' | 'error'

/** Status of one plan/todo entry. `cancelled` ("no longer needed") is
 *  opencode-only today — it renders struck through and drops out of the
 *  odometer's denominator rather than reading as unfinished work. */
export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** One entry of the session plan — full-replacement semantics (ACP style). */
export interface PlanEntry {
  content: string
  status: PlanStatus
  priority?: 'high' | 'medium' | 'low'
  /** Present-continuous label shown while the entry is in progress. */
  activeForm?: string
}

/** Raw token counts — never pre-weighted (cost weighting is presentation). */
export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  /** The backend's own total when given, else the sum of the parts. */
  total: number
  /** Model context-window size when known — feeds the fill gauge. */
  contextWindow?: number
}

/** One file change carried by an edit-tool item. `oldText: null` = new file. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText?: string
  unified?: string
}

/** A file location a tool touched (feeds "jump to file" affordances). */
export interface ToolLocation {
  path: string
  line?: number
}

/** A chat message. */
export interface UiMessageItem {
  kind: 'message'
  id: string
  role: 'assistant' | 'user'
  text: string
  phase?: 'commentary' | 'final'
  parentItemId?: string
}

/** Extended thinking / reasoning summary. */
export interface UiReasoningItem {
  kind: 'reasoning'
  id: string
  text: string
  parentItemId?: string
}

/** One tool invocation with its full lifecycle. */
export interface UiToolItem {
  kind: 'tool'
  id: string
  /** The backend's tool name / item type (e.g. `Bash`, `commandExecution`). */
  name: string
  /** ACP-style icon/verb hint — see `toolDisplay()` in `tool-display.ts`. */
  toolKind: ToolKind
  /** Human line, computed once in the protocol layer: "Ran npm test". */
  title: string
  status: ToolStatus
  /** Raw input — may arrive incrementally. */
  input?: unknown
  output?: string | undefined
  error?: string | undefined
  diffs?: FileDiff[]
  locations?: ToolLocation[]
  /** commandExecution / bash exit code, when the backend reports one. */
  exitCode?: number
  parentItemId?: string
}

/** How a native hook run ended — see the server's `ui-events.ts` (#961). */
export type HookStatus = 'completed' | 'failed' | 'blocked' | 'cancelled'

/** The role of one piece of hook output — codex `HookOutputEntryKind` verbatim. */
export type HookEntryKind = 'context' | 'feedback' | 'warning' | 'error' | 'stop'

/** One native hook run that told the agent something, failed, was cancelled or blocked. */
export interface UiHookItem {
  kind: 'hook'
  id: string
  /** Native event, PascalCase: `SessionStart`, `PreToolUse`, `Stop`. */
  event: string
  /** Native label when richer than `event`: `SessionStart:startup`, `PreToolUse:Bash`. */
  name?: string | undefined
  /** Where the hook is defined, when the wire says (codex `sourcePath`). */
  source?: string
  status: HookStatus
  entries: Array<{ kind: HookEntryKind; text: string }>
  stdout?: string
  stderr?: string
  exitCode?: number
  durationMs?: number
  parentItemId?: string
}

export type UiItem = UiMessageItem | UiReasoningItem | UiToolItem | UiHookItem

/* ------------------------------------------------------------------ */
/* Events — discriminated on `type`                                    */
/* ------------------------------------------------------------------ */

/** Session opened. */
export interface UiSessionStartedEvent {
  type: 'session.started'
  sessionId: string
  backend: UiBackend
  model?: string
  cwd?: string
  tools?: string[]
}

/** Session over (replaces v1 `done` / fatal `error`). */
export interface UiSessionEndedEvent {
  type: 'session.ended'
  reason: StopReason
  message?: string
}

/** v1 `note` + `error` unified — severity explicit instead of implied. */
export interface UiSessionErrorEvent {
  type: 'session.error'
  message: string
  fatal: boolean
}

/** A turn began. */
export interface UiTurnStartedEvent {
  type: 'turn.started'
  turnId: string
}

/** A turn finished. */
export interface UiTurnCompletedEvent {
  type: 'turn.completed'
  turnId: string
  stopReason: StopReason
  usage?: TokenUsage
  costUsd?: number
}

/** An item entered the stream (tools usually with status pending/running). */
export interface UiItemStartedEvent {
  type: 'item.started'
  item: UiItem
}

/**
 * Streaming append to one field of a live item. On the wire these are
 * EPHEMERAL: the server coalesces them (~40 ms) onto the live SSE stream
 * only, so their `seq` values never reappear in a replay — dedup must use
 * `>`, never sequence-gap detection.
 */
export interface UiItemDeltaEvent {
  type: 'item.delta'
  itemId: string
  field: 'text' | 'reasoning' | 'output'
  delta: string
}

/** Status flips and streamed-content snapshots. */
export interface UiItemUpdatedEvent {
  type: 'item.updated'
  item: UiItem
}

/** Final snapshot of an item — safe to persist (snapshots, not deltas). */
export interface UiItemCompletedEvent {
  type: 'item.completed'
  item: UiItem
}

/** Full-replacement plan snapshot (ACP semantics). */
export interface UiPlanUpdatedEvent {
  type: 'plan.updated'
  entries: PlanEntry[]
}

/** A native approval request, answerable only through its offered option IDs. */
export type UiPermissionRequestedEvent = PermissionRequest

/** A human response or expiry of a pending native approval. */
export type UiPermissionResolvedEvent = PermissionResolution

/** One option in an AskUser question — see the server `src/core/ask.ts`. */
export interface UiAskOption {
  label: string
  description?: string
}

/** One structured multiple-choice question (modeled on `AskUserQuestion`). Without options it is
 *  an open question: the user types the answer (hearsay-tools/cezarion#1234). */
export interface UiAskQuestion {
  id?: string
  header: string
  question: string
  options?: UiAskOption[]
  multiSelect?: boolean
}

/**
 * The agent asked the user a structured multiple-choice question via a
 * `CEZ:ASK` marker. The run parks `waiting`; the cockpit renders clickable
 * option chips. Resolution is client-side (the next user message closes the
 * card) — there is no `ask.resolved` event.
 */
export interface UiAskRequestedEvent {
  type: 'ask.requested'
  requestId: string
  questions: UiAskQuestion[]
  /** Markdown shown above the questions (hearsay-tools/cezarion#1458); absent on older asks,
   *  native asks and an ask line without one. */
  context?: string
}

/** Cumulative-for-session raw telemetry. */
export interface UiUsageUpdatedEvent {
  type: 'usage.updated'
  usage: TokenUsage
  costUsd?: number
}

/** An image emitted mid-stream (kept from v1) — raw base64 on the wire. */
export interface UiImageEvent {
  type: 'image'
  itemId?: string
  mediaType: string
  data: string
}

export type UiEvent =
  | UiSessionStartedEvent
  | UiSessionEndedEvent
  | UiSessionErrorEvent
  | UiTurnStartedEvent
  | UiTurnCompletedEvent
  | UiItemStartedEvent
  | UiItemDeltaEvent
  | UiItemUpdatedEvent
  | UiItemCompletedEvent
  | UiPlanUpdatedEvent
  | UiPermissionRequestedEvent
  | UiPermissionResolvedEvent
  | UiAskRequestedEvent
  | UiUsageUpdatedEvent
  | UiImageEvent

/** Every v2 event discriminator. */
export type UiEventType = UiEvent['type']
