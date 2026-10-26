/**
 * The pending ask, built once from a run's `ask.requested` events (hearsay-tools/cezarion#1808).
 * Worker routing, `cez task status`, the task webhook and the cockpit card all read the ask from
 * here: a field the ask gains is named in this file and reaches every one of them. Code outside
 * this file and `ask.ts` does not read the payload of an `ask.requested` event
 * (`.ai/ast-grep/rules/ask-requested-read-outside-projection.yml`).
 *
 * The values are the ones the event stored: nothing here re-parses or reorders them, so a reader
 * prints what the transcript holds. `ask.ts` decides which ask is pending (the latest valid one
 * that no delivery or Finish has retired); this file shapes it.
 */
import { advancePendingHumanAsk } from './ask.ts';
import { askRequestSchema, type AskQuestion, type AskRequest } from './ask-schema.ts';
import type { RunEvent } from './events.ts';

/** What an ask says: its questions and, since hearsay-tools/cezarion#1458, the Markdown above them. */
export interface AskContent {
  questions: unknown;
  context?: unknown;
}

/** The payload of one `ask.requested` event. */
export interface AskPayload extends AskContent {
  requestId: string;
}

/** An ask and the `seq` of the event that holds it, which every receipt for it names as `askSeq`. */
export interface PendingAsk extends AskPayload {
  seq: number;
}

/**
 * The payload of an `ask.requested` event, or undefined for any other event or one with no string
 * `requestId`. The questions are not validated: the card renders an ask the questions schema
 * rejects, and the live runner event has no `seq`.
 */
export function askPayloadOf(event: { type: string; requestId?: unknown; questions?: unknown; context?: unknown }): AskPayload | undefined {
  if (event.type !== 'ask.requested' || typeof event.requestId !== 'string') return undefined;
  return { requestId: event.requestId, questions: event.questions, ...(event.context !== undefined ? { context: event.context } : {}) };
}

/** The ask a stored `ask.requested` event holds. Not necessarily pending: see `pendingAskOf`. */
export function askOf(event: RunEvent): PendingAsk | undefined {
  const payload = askPayloadOf(event);
  return payload && { seq: event.seq, ...payload };
}

/**
 * One step of the fold `pendingAskOf` runs, for a reader that folds a transcript as it grows:
 * the next pending ask after `event`. Same ask in, same object out; a newer valid ask replaces it,
 * and a delivery or Finish that names it retires it (`advancePendingHumanAsk` holds that rule).
 */
export function advancePendingAsk<T extends Pick<PendingAsk, 'seq'>>(pending: T | undefined, event: RunEvent): T | PendingAsk | undefined {
  const next = advancePendingHumanAsk(pending && ({ type: 'ask.requested', seq: pending.seq, ts: '' } as RunEvent), event);
  if (next === event) return askOf(event);
  return next === undefined ? undefined : pending;
}

/** The ask a run waits on in `events`, in order, or undefined. */
export function pendingAskOf(events: Iterable<RunEvent>): PendingAsk | undefined {
  let pending: PendingAsk | undefined;
  for (const event of events) pending = advancePendingAsk(pending, event);
  return pending;
}

/** The ask as a validated `AskRequest`, which a worker's parent receives. Undefined when it fails the schema. */
export function askRequestOf(ask: AskContent): AskRequest | undefined {
  const parsed = askRequestSchema.safeParse({ questions: ask.questions, ...(ask.context !== undefined ? { context: ask.context } : {}) });
  return parsed.success ? parsed.data : undefined;
}

/** What `cez task status` and the task webhook print: the questions as `question`, the context as `questionContext`. */
export function askStatusFields(ask: AskContent | undefined): { question?: unknown; questionContext?: unknown } {
  return ask ? { question: ask.questions, questionContext: ask.context } : {};
}

/** The cockpit card's model of an ask. */
export interface AskCardFields {
  id: string;
  questions: AskQuestion[];
  /** Absent when the ask has none, or an empty one. */
  context?: string;
  askSeq: number;
}

/**
 * The card for an ask, or undefined when it has no question the card can show. The card is more
 * lenient than the pending rule: it keeps a question that has a string `header` and no options
 * or a list of them, so an ask the questions schema now rejects still shows; a question without
 * options is an open one (hearsay-tools/cezarion#1234).
 */
export function askCardOf(ask: PendingAsk): AskCardFields | undefined {
  const questions = Array.isArray(ask.questions)
    ? ask.questions.filter((question): question is AskQuestion => typeof question === 'object' && question !== null && !Array.isArray(question) &&
      typeof question.header === 'string' && (question.options === undefined || Array.isArray(question.options)))
    : [];
  if (questions.length === 0) return undefined;
  const context = typeof ask.context === 'string' && ask.context !== '' ? ask.context : undefined;
  return { id: ask.requestId, questions, ...(context !== undefined ? { context } : {}), askSeq: ask.seq };
}
