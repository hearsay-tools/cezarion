/** Pure transcript folding and version-1 sidecar validation. */
import { type Stats } from 'node:fs';
import { z } from 'zod';
import { advancePendingHumanAsk } from '@open-mercato/cezar-contract/ask';
import { advancePendingAsk, type PendingAsk } from '@open-mercato/cezar-contract/pending-ask';
import type { RunEvent } from '@open-mercato/cezar-contract';

/** The human gate a human wait without a card raises; answered like a structured ask. The code
 *  keeps the name of the prose gate it replaced (hearsay-tools/cezarion#1234), which older
 *  transcripts still carry. */
export const PROSE_HUMAN_GATE = 'unstructured-human-gate';

/** The pending ask (hearsay-tools/cezarion#1808) and what routing recorded for it. */
export interface PendingAskFacts extends PendingAsk {
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
  /** Stat of the archive these facts were folded from, while the transcript is archived. */
  archive?: ArchiveStamp;
}

export function emptyFacts(): TranscriptFacts {
  return { version: 1, bytes: 0, lastSeq: 0, projectionIds: [], workerOutcomeKeys: [] };
}

export function workerOutcomeKey(waitId: string, workerId: string, revision: number): string {
  return `${waitId}:${workerId}:${revision}`;
}

/** The pending ask: a newer valid one replaces it, a receipt retires it, and routing records for it. */
function foldPendingAsk(facts: TranscriptFacts, event: RunEvent): boolean {
  let changed = false;
  const next = advancePendingAsk(facts.pendingAsk, event);
  if (next !== undefined && next !== facts.pendingAsk) {
    facts.pendingAsk = next;
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
  return changed;
}

/** A worker's outcome, keyed once by wait, worker and revision. */
function foldWorkerOutcome(facts: TranscriptFacts, event: RunEvent): boolean {
  if (event.type !== 'worker-outcome' || typeof event.waitId !== 'string') return false;
  const outcome = event.outcome as { workerId?: unknown; revision?: unknown } | undefined;
  if (typeof outcome?.workerId !== 'string') return false;
  const key = workerOutcomeKey(event.waitId, outcome.workerId, typeof outcome.revision === 'number' ? outcome.revision : 0);
  if (facts.workerOutcomeKeys.includes(key)) return false;
  facts.workerOutcomeKeys.push(key);
  return true;
}

/** Fold one event. True when a fact other than `bytes`/`lastSeq` changed, i.e. worth persisting. */
export function foldEvent(facts: TranscriptFacts, event: RunEvent): boolean {
  if (typeof event.seq === 'number' && event.seq > facts.lastSeq) facts.lastSeq = event.seq;
  let changed = false;
  if (typeof event.projectionId === 'string' && !facts.projectionIds.includes(event.projectionId)) {
    facts.projectionIds.push(event.projectionId);
    changed = true;
  }
  if (foldPendingAsk(facts, event)) changed = true;
  const gate = event.type === 'note' && event.code === PROSE_HUMAN_GATE ? event
    : advancePendingHumanAsk(facts.pendingGateSeq === undefined ? undefined : ({ type: 'note', seq: facts.pendingGateSeq, ts: '' } as RunEvent), event);
  if (gate?.seq !== facts.pendingGateSeq) {
    if (gate) facts.pendingGateSeq = gate.seq; else delete facts.pendingGateSeq;
    changed = true;
  }
  if (foldWorkerOutcome(facts, event)) changed = true;
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

export const factsFileSchema = z.object({
  version: z.literal(1),
  bytes: z.number().int().nonnegative(),
  lastSeq: z.number(),
  projectionIds: z.array(z.string()),
  pendingAsk: z.object({
    seq: z.number(), requestId: z.string(), questions: z.unknown(), context: z.unknown().optional(),
    routedMessageId: z.string().optional(), fallback: z.boolean().optional(),
  }).optional(),
  pendingGateSeq: z.number().optional(),
  workerOutcomeKeys: z.array(z.string()),
  archive: z.object({ size: z.number(), mtimeMs: z.number(), ino: z.number() }).optional(),
});

export const stampOf = (st: Stats): ArchiveStamp => ({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
export const sameStamp = (a: ArchiveStamp | undefined, b: ArchiveStamp) => !!a && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

