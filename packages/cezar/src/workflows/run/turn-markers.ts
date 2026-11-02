import { randomUUID } from 'node:crypto';
import type { HumanWaitEntry } from '@open-mercato/cezar-contract/waits';
import { defined } from '../../core/defined.ts';
import { uiAskQuestions, type AskRequest } from '../../core/ask.ts';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { AgentEvent, RunnerId } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { TurnTail } from './types.ts';

/** Claude's native scheduler is the backend-level equivalent of a `cezar_wait` timer. Keep this
 * recognition here, at the workflow boundary, so the v1 event protocol stays unchanged and other
 * backends do not acquire semantics from a coincidentally named tool (#46). Undefined: not the scheduler; null: the
 * scheduler without a usable `delaySeconds`; otherwise that delay (hearsay-tools/cezarion#1233). */
export function claudeScheduleWakeupDelay(event: AgentEvent, backend: RunnerId): number | null | undefined {
  if (backend !== 'claude' || event.type !== 'tool-call' || event.tool !== 'ScheduleWakeup') return undefined;
  const delay = (event.input as { delaySeconds?: unknown } | null | undefined)?.delaySeconds;
  return typeof delay === 'number' && Number.isFinite(delay) ? delay : null;
}
/** A parked backend has resumed only when the parent owns a new turn.
 * Nested Codex/Pi subagent `item.*` streams are not a parent turn — treating
 * them as activity cancelled the only on-by-default wake (#121). Session
 * diagnostics and completed-turn metadata stay passive for the same reason. */
export function isRunnerActivity(event: UiEvent): boolean {
  return event.type === 'turn.started';
}
/**
 * Preserve boundaries between complete assistant text blocks while a turn is
 * accumulated for its task-reference markers (`parseTaskMarkers`). The runners
 * join these same v1 blocks with newlines in `AgentRunResult`; matching that
 * contract here prevents a trailing `CEZ:TITLE=` block from absorbing later
 * commentary (#623).
 */
export function appendTurnText(current: string, next: string): string {
  if (!current) return next;
  if (!next) return current;
  return `${current}\n${next}`;
}
/** Last top-level completed item: a non-empty assistant message is a visible tail; reasoning or a tool is silent even after earlier visible text (#544). An empty turn stays `none` and never nudges. */
export function trackTurnTail(tail: TurnTail, event: UiEvent): TurnTail {
  if (event.type !== 'item.completed' || event.item.parentItemId !== undefined) return tail;
  const item = event.item;
  if (item.kind === 'message' && item.role === 'assistant' && item.text.trim() !== '') return 'visible';
  if (item.kind === 'reasoning' || item.kind === 'tool') return 'silent';
  return tail;
}
/** Emit the v2 `ask.requested` event for a human wait's card (the cockpit renders
 *  it as an ask card, #473). Returns the minted request id. */
export function emitAskRequested(sink: UiEventSink, ask: AskRequest): string {
  const requestId = randomUUID();
  sink.handle({ type: 'ask.requested', requestId, ...defined(askCardFields(ask)), questions: uiAskQuestions(ask.questions) });
  return requestId;
}
/** A card's stored fields: its questions and, when it has one, its context (hearsay-tools/cezarion#1458).
 *  A card always replaces both, so a card without context never keeps an older card's. */
export function askCardFields(card: AskRequest): AskRequest {
  return { questions: card.questions, ...(card.context !== undefined ? { context: card.context } : {}) };
}
/** The card a human wait holds, or none for a wait without questions. */
export function humanWaitCard(wait: Pick<HumanWaitEntry, 'questions' | 'context'> | undefined): AskRequest | undefined {
  return wait?.questions ? askCardFields({ questions: wait.questions, context: wait.context }) : undefined;
}
/** How a turn end reads its turn (`classifyTurnEnd`): the card it raises, whether it is done, whether
 *  it monitors, and whether it raises the human gate (a human wait without a card). */
export type TurnEndRead = { ask: AskRequest | null; done: boolean; monitoring: boolean; humanGate: boolean };
/** One turn-end decision for fresh and Continue, also retained until an input ACK settles. Only
 * the lifecycle tools and native runner signals count; the turn's text is never read
 * (hearsay-tools/cezarion#2397). An accepted `cezar_done` is DONE. A human wait this turn registered
 * and nobody has seen yet (hearsay-tools/cezarion#1234) raises its card, or the human gate when it
 * has none, unless DONE wins. DONE and human gates take precedence over a scheduled wake or live
 * workers; a false pending-ASK flag alone proves nothing. */
export function classifyTurnEnd(options: {
  sessionOpen: boolean; pendingHumanAsk: boolean;
  scheduledWake: boolean; liveWorkers: boolean;
  humanWait?: Pick<HumanWaitEntry, 'questions' | 'context'> | undefined; doneRequested?: boolean | undefined;
}): TurnEndRead {
  const done = options.sessionOpen && !!options.doneRequested;
  const surfaced = options.sessionOpen && !done ? options.humanWait : undefined;
  const ask = humanWaitCard(surfaced) ?? null;
  const humanGate = !!surfaced && !ask;
  const monitoring = options.sessionOpen && !done && !ask && !options.pendingHumanAsk && !humanGate &&
    (options.scheduledWake || options.liveWorkers);
  return { ask, done, monitoring, humanGate };
}
/** A surfaced question — a `cezar_ask` card or the human gate — means the user must answer. Drop
 *  follow-ups queued mid-turn so they cannot start a new turn the moment idle fires (OpenCode
 *  serializes `sendMessage` that way). */
export function discardQueuedMessagesOnAsk(session: AgentSession | undefined, outcome: Pick<TurnEndRead, 'ask' | 'humanGate'>): void {
  if (outcome.ask || outcome.humanGate) session?.discardQueuedMessages();
}
