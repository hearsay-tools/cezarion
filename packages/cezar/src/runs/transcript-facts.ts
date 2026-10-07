/**
 * The few transcript facts the delegation reconcile and message delivery ask about, folded as
 * events are appended so those paths never re-read a whole transcript (hearsay-tools/cezarion#880).
 * Spec: docs/superpowers/specs/2026-10-07-transcript-facts-index-design.md.
 */
import { advancePendingHumanAsk, type RunEvent } from '@open-mercato/cezar-contract';

/** A prose gate a turn ended on without a structured ask; answered like one. */
export const PROSE_HUMAN_GATE = 'unstructured-human-gate';

export interface PendingAskFacts {
  seq: number;
  requestId: string;
  questions: unknown;
  /** The worker routed this ask to its parent as this conversation message (#505). */
  routedMessageId?: string;
  /** The ask went back to the human. */
  fallback?: boolean;
}

export interface ArchiveStamp { size: number; mtimeMs: number; ino: number }

export interface TranscriptFacts {
  version: 1;
  /** Decoded transcript bytes folded so far. */
  bytes: number;
  lastSeq: number;
  projectionIds: string[];
  /** The latest structured ask with no matching delivery receipt. */
  pendingAsk?: PendingAskFacts;
  /** As `pendingAsk`, with prose human gates counted as asks. */
  pendingGateSeq?: number;
  workerOutcomeKeys: string[];
  /** Stat of the `.ndjson.br` these facts were folded from, when the plain file is gone. */
  archive?: ArchiveStamp;
}

export function emptyFacts(): TranscriptFacts {
  return { version: 1, bytes: 0, lastSeq: 0, projectionIds: [], workerOutcomeKeys: [] };
}

export function workerOutcomeKey(waitId: string, workerId: string, revision: number): string {
  return `${waitId}:${workerId}:${revision}`;
}

/** Fold one event. True when a fact other than `bytes`/`lastSeq` changed, i.e. worth persisting. */
export function foldEvent(facts: TranscriptFacts, event: RunEvent): boolean {
  if (typeof event.seq === 'number' && event.seq > facts.lastSeq) facts.lastSeq = event.seq;
  let changed = false;
  if (typeof event.projectionId === 'string' && !facts.projectionIds.includes(event.projectionId)) {
    facts.projectionIds.push(event.projectionId);
    changed = true;
  }
  // advancePendingHumanAsk reads only the pending event's seq.
  const pending = facts.pendingAsk && ({ type: 'ask.requested', seq: facts.pendingAsk.seq, ts: '' } as RunEvent);
  const next = advancePendingHumanAsk(pending, event);
  if (next === event) {
    facts.pendingAsk = { seq: event.seq, requestId: event.requestId as string, questions: event.questions };
    changed = true;
  } else if (next === undefined && facts.pendingAsk) {
    delete facts.pendingAsk;
    changed = true;
  }
  if (facts.pendingAsk && event.askSeq === facts.pendingAsk.seq) {
    if (event.type === 'worker-question-routed' && facts.pendingAsk.routedMessageId === undefined && typeof event.messageId === 'string') {
      facts.pendingAsk.routedMessageId = event.messageId;
      changed = true;
    } else if (event.type === 'worker-question-fallback' && !facts.pendingAsk.fallback) {
      facts.pendingAsk.fallback = true;
      changed = true;
    }
  }
  const gate = event.type === 'note' && event.code === PROSE_HUMAN_GATE ? event
    : advancePendingHumanAsk(facts.pendingGateSeq === undefined ? undefined : ({ type: 'note', seq: facts.pendingGateSeq, ts: '' } as RunEvent), event);
  if (gate?.seq !== facts.pendingGateSeq) {
    if (gate) facts.pendingGateSeq = gate.seq; else delete facts.pendingGateSeq;
    changed = true;
  }
  if (event.type === 'worker-outcome' && typeof event.waitId === 'string') {
    const outcome = event.outcome as { workerId?: unknown; revision?: unknown } | undefined;
    if (typeof outcome?.workerId === 'string') {
      const key = workerOutcomeKey(event.waitId, outcome.workerId, typeof outcome.revision === 'number' ? outcome.revision : 0);
      if (!facts.workerOutcomeKeys.includes(key)) { facts.workerOutcomeKeys.push(key); changed = true; }
    }
  }
  return changed;
}

/** Fold NDJSON text. Unparsable lines are skipped, as `RunStore.readEvents` skips them. */
export function foldText(facts: TranscriptFacts, text: string): boolean {
  let changed = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event !== null && typeof event === 'object' && foldEvent(facts, event as RunEvent)) changed = true;
  }
  facts.bytes += Buffer.byteLength(text);
  return changed;
}
