import { randomUUID } from 'node:crypto';
import type { HumanWaitEntry } from '@open-mercato/cezar-contract/waits';
import { defined } from '../../core/defined.ts';
import { parseAskMarkerResult, uiAskQuestions, type AskMarkerParseResult, type AskRequest } from '../../core/ask.ts';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { AgentEvent, RunnerId } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import type { TurnTail } from './types.ts';

/**
 * Task-completion marker from the agent contract (HANDOFF_ONLY_INSTRUCTIONS):
 * an active `CEZ:DONE` declaration means "goal achieved, nothing to ask" —
 * the session is closed right away instead of parking at `waiting` (#347).
 * Detection runs on the accumulated turn text so delta-streaming backends
 * (codex, opencode) can't split the marker across text events.
 */
/** Find the turn's active markers: quoted/indented examples and fenced code declare
 * nothing. A standalone monitoring line belongs to this turn even when a later
 * assistant block acknowledges a new instruction. The prose itself is never read
 * (hearsay-tools/cezarion#1234). */
function turnParkSignals(text: string): { monitoring: boolean; done: boolean; askResult: AskMarkerParseResult } {
  let fence: { char: string; length: number } | undefined;
  let monitoring = false;
  let done = false;
  let askResult: AskMarkerParseResult = { kind: 'none' };
  let previous = '';
  for (const raw of text.split('\n')) {
    const delimiter = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      previous = ''; // a fenced example consumes its heading, not the next declaration
      const token = delimiter[1]!;
      if (!fence) fence = { char: token[0]!, length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^(?: {4}|\t|\s*>)/.test(raw)) { if (raw.trim()) previous = ''; continue; }
    // Lists and emphasis format active prose; they do not quote it. Exclude
    // fenced/indented/blockquote examples before removing their decoration.
    const line = raw.trim().replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^#{1,6}\s+/, '').replace(/\*{1,2}|_{1,2}/g, '');
    if (!line) continue;
    const example = /\b(?:example|sample|literal|quoted)(?: marker)?\s*:\s*$/i.test(previous);
    if (!example && raw.trim() === 'CEZ:MONITORING') {
      monitoring = true;
      done = false;
    }
    if (!example && raw.trim() === 'CEZ:DONE') {
      done = true;
      askResult = { kind: 'none' }; // retain the existing later-DONE precedence
    }
    // Preserve the existing payload validation/repair and latest malformed
    // marker diagnostics. Only active declarations participate: an ACK after
    // a real ASK must not erase its card, nor turn examples into questions.
    const candidate = example ? { kind: 'none' as const } : parseAskMarkerResult(raw);
    if (candidate.kind !== 'none') { askResult = candidate; done = false; }
    previous = line;
  }
  return { monitoring, done, askResult };
}
/** Claude's native scheduler is the backend-level equivalent of the textual
 * monitoring marker. Keep this recognition here, at the workflow boundary,
 * so the v1 event protocol stays unchanged and other backends do not acquire
 * semantics from a coincidentally named tool (#46). Undefined: not the scheduler; null: the
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
 * accumulated for marker parsing. The runners join these same v1 blocks with
 * newlines in `AgentRunResult`; matching that contract here prevents a
 * trailing `CEZ:TITLE=` block from absorbing later commentary (#623).
 */
export function appendTurnText(current: string, next: string): string {
  if (!current) return next;
  if (!next) return current;
  return `${current}\n${next}`;
}
/** The v2 item is the complete assistant message the cockpit persists. Keep it
 * as a fallback when a runner's legacy v1 text omitted a trailing CEZ:ASK. */
export function appendCompletedAssistantText(current: string, event: UiEvent): string {
  if (
    event.type !== 'item.completed' ||
    event.item.kind !== 'message' ||
    event.item.role !== 'assistant' ||
    event.item.parentItemId !== undefined
  ) {
    return current;
  }
  return appendTurnText(current, event.item.text);
}
/** Last top-level completed item: a non-empty assistant message is a visible tail; reasoning or a tool is silent even after earlier visible text (#544). An empty turn stays `none` and never nudges. */
export function trackTurnTail(tail: TurnTail, event: UiEvent): TurnTail {
  if (event.type !== 'item.completed' || event.item.parentItemId !== undefined) return tail;
  const item = event.item;
  if (item.kind === 'message' && item.role === 'assistant' && item.text.trim() !== '') return 'visible';
  if (item.kind === 'reasoning' || item.kind === 'tool') return 'silent';
  return tail;
}
/** Strip a trailing marker from one text event so transcripts stay free of
 *  protocol noise. Delta backends may split the marker across events — then
 *  it stays visible; detection above is unaffected. */
export function stripDoneMarker(text: string): string {
  return text.replace(/\s*CEZ:DONE\s*$/, '');
}
/** Strip a trailing `CEZ:MONITORING` marker from one text event (see
 *  `stripDoneMarker`; same delta-backend caveat). */
export function stripMonitoringMarker(text: string): string {
  return text.replace(/\s*CEZ:MONITORING\s*$/, '');
}
/** Emit the v2 `ask.requested` event for a parsed marker (the cockpit renders
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
/** A persisted, non-fatal explanation for protocol-shaped text that could not
 * become an ask card. Never include the raw payload in this diagnostic. */
function askMarkerRejection(result: AskMarkerParseResult): string | undefined {
  if (result.kind === 'invalid-json') {
    return 'structured question ignored — CEZ:ASK payload is not valid JSON';
  }
  if (result.kind !== 'invalid-structure') return undefined;
  const issue = result.issues[0];
  const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  return `structured question ignored — CEZ:ASK payload failed validation${location}${issue ? `: ${issue.message}` : ''}`;
}
/** A persisted, auditable trace for a card that only rendered because the
 * payload's missing closers were appended (#936) — a repair can only lose what
 * the truncation already removed, so the recovery must stay visible rather than
 * passing for a clean parse. Carries `tone: 'danger'` for the same reason the
 * rejection does: it is the ONLY signal that the card may be missing a trailing
 * option or a trailing `multiSelect` the cut took with it, and the raw payload
 * is stripped along with the card, so a dim footnote could not be acted on. */
function askMarkerRecovery(result: AskMarkerParseResult): string | undefined {
  return result.kind === 'valid' && result.repaired
    ? 'structured question recovered from an unbalanced CEZ:ASK payload — check the options, and how many you may pick, match what was asked'
    : undefined;
}
/** What a turn's active `CEZ:ASK` declaration resolves to: the card to raise, and
 * the notes to persist alongside it. */
type AskTurnOutcome = {
  ask: AskRequest | null;
  /** Emitted in order by the caller, which owns how a note is persisted. */
  notes: Array<{ message: string; tone?: 'danger' }>;
};
/** Resolve the ask marker for one finished turn. Both turn-end handlers
 * (`runAgentStep` and `runContinuation`) route through this single function:
 * they are hand-duplicated, and `AGENTS.md` warns that a lifecycle change
 * applied to only one of them ships half a fix — the notes and their tones are
 * exactly that kind of change. `enabled` is the caller's own precondition (the
 * session is open and the turn is not a terminating `CEZ:DONE`); when false
 * there is no marker to look for. Intermediate steps can ask too (#427). */
function resolveAskTurn(v1Result: AskMarkerParseResult, v2Result: AskMarkerParseResult, enabled: boolean): AskTurnOutcome {
  if (!enabled) return { ask: null, notes: [] };
  // For unreconciled channels, v1 remains authoritative when it carries an
  // ASK; a marker absent from v1 can still come from the complete v2 message.
  const result = v1Result.kind === 'none' ? v2Result : v1Result;
  const notes: AskTurnOutcome['notes'] = [];
  const rejection = askMarkerRejection(result);
  if (rejection) notes.push({ message: rejection, tone: 'danger' });
  const recovery = askMarkerRecovery(result);
  if (recovery) notes.push({ message: recovery, tone: 'danger' });
  return { ask: result.kind === 'valid' ? result.request : null, notes };
}
/** A partial channel cannot keep an earlier gate alive when the other carries
 * the same transcript plus later declarations. Compare raw lines in order,
 * preserving fences/examples and ACKs between declarations. Neither channel
 * always wins: v1 reconstructs omitted snapshots, v2 can retain refreshed ones.
 * Incomparable transcripts keep the existing conservative channel policy. */
function orderedTurnText(v1: string, v2: string): string | undefined {
  if (!v1) return v2;
  if (!v2 || v1 === v2) return v1;
  const contains = (full: string, partial: string): boolean => {
    const lines = partial.split('\n');
    let next = 0;
    for (const line of full.split('\n')) {
      if (line === lines[next]) next++;
    }
    return next === lines.length;
  };
  if (contains(v2, v1)) return v2;
  if (contains(v1, v2)) return v1;
  return undefined;
}
/** A turn's markers, as `classifyTurnEnd` reads them: each channel's ask line, and its done and
 *  monitoring lines. */
type TurnMarkers = { v1Ask: AskMarkerParseResult; v2Ask: AskMarkerParseResult; doneLine: boolean; monitoringLine: boolean };
/** How a turn end reads its turn (`classifyTurnEnd`). */
export type TurnEndRead = AskTurnOutcome & { done: boolean; monitoring: boolean; humanGate: boolean; waitCard: boolean };
/** Read the turn's markers once from the channel that holds the whole turn, or from each channel
 *  when neither holds the other (`orderedTurnText`). A done line counts only when no channel
 *  carries an ask line. */
function readTurnMarkers(turnText: string, completedAssistantText: string): TurnMarkers {
  const complete = orderedTurnText(turnText, completedAssistantText);
  const v1 = turnParkSignals(complete ?? turnText);
  const v2 = complete === undefined ? turnParkSignals(completedAssistantText) : v1;
  return {
    v1Ask: v1.askResult, v2Ask: v2.askResult,
    doneLine: (v1.done || v2.done) && v1.askResult.kind === 'none' && v2.askResult.kind === 'none',
    monitoringLine: v1.monitoring || v2.monitoring,
  };
}
/** Read the turn's ask: its ask line, else the card of the human wait it registered, else the
 *  human gate when that wait has no card. A done reads no ask. */
function readTurnAsk(markers: TurnMarkers, options: { sessionOpen: boolean; humanWait?: Pick<HumanWaitEntry, 'questions' | 'context'> | undefined },
  done: boolean): AskTurnOutcome & { humanGate: boolean; waitCard: boolean } {
  const askTurn = resolveAskTurn(markers.v1Ask, markers.v2Ask, options.sessionOpen && !done);
  const surfaced = options.humanWait && options.sessionOpen && !done && !askTurn.ask ? options.humanWait : undefined;
  const waitCard = !!surfaced?.questions;
  return { ...askTurn, ask: askTurn.ask ?? humanWaitCard(surfaced) ?? null, humanGate: !!surfaced && !waitCard, waitCard };
}
/** One turn-end decision for fresh and Continue, also retained until an input
 * ACK settles. DONE and human gates take precedence over a quiet
 * declaration or live workers; a false pending-ASK flag alone proves nothing.
 * A human wait this turn registered and nobody has seen yet (hearsay-tools/cezarion#1234)
 * raises its card, or the human gate when it has none, unless DONE wins or a valid ask line
 * replaces its card; `waitCard` says the card is the wait's own. An accepted `cezar_done` is DONE
 * whatever the text says, and beats any ask line in it. Only markers and waits count: no prose
 * raises the gate, and a rejected ask line is a turn end with no wait. */
export function classifyTurnEnd(turnText: string, completedAssistantText: string, options: {
  sessionOpen: boolean; pendingHumanAsk: boolean;
  scheduledWake: boolean; liveWorkers: boolean;
  humanWait?: Pick<HumanWaitEntry, 'questions' | 'context'> | undefined; doneRequested?: boolean | undefined;
}): TurnEndRead {
  const markers = readTurnMarkers(turnText, completedAssistantText);
  const done = options.sessionOpen && (!!options.doneRequested || markers.doneLine);
  const { humanGate, waitCard, ...askTurn } = readTurnAsk(markers, options, done);
  const monitoring = options.sessionOpen && !done && !askTurn.ask &&
    !options.pendingHumanAsk && !humanGate &&
    (markers.monitoringLine || options.scheduledWake || options.liveWorkers);
  return { ...askTurn, done, monitoring, humanGate, waitCard };
}
/** An active ASK marker — valid card or rejected payload — means the user
 *  must answer. Drop follow-ups queued mid-turn so they cannot start a new
 *  turn the moment idle fires (OpenCode serializes `sendMessage` that way). */
export function discardQueuedMessagesOnAsk(session: AgentSession | undefined, outcome: AskTurnOutcome & { humanGate?: boolean }): void {
  if (outcome.ask || outcome.notes.length || outcome.humanGate) session?.discardQueuedMessages();
}
