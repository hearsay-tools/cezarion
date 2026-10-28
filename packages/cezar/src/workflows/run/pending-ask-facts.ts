import type { RunStore } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';

/** An answer already executing in this generation is not an unanswered question.
 * Keep the durable checkpoint at turn-end for crash recovery, and match its exact
 * sequence so it can never hide a newer question. */
export function hasUnansweredHumanAsk(runId: string, active: Pick<Map<string, ActiveRun>, 'get'>, pendingHumanAskSeq: (runId: string) => number | undefined): boolean {
  const seq = pendingHumanAskSeq(runId);
  const state = active.get(runId);
  return seq !== undefined && !(state?.session?.open && !state.cancelled && state.openingAnswerAskSeq === seq);
}

/** Transcript bubbles include refused sends. Only a successful delivery
 * checkpoint can answer the specific ask observed before that send. */
export function pendingHumanAskSeq(store: Pick<RunStore, 'transcriptFacts'>, runId: string): number | undefined {
  // Fallback human gates use the same exact successful-delivery receipt as asks,
  // without inventing a structured question card or changing its summary. Indexed (hearsay-tools/cezarion#880).
  return store.transcriptFacts(runId).pendingGateSeq;
}

export function hasPendingHumanAsk(runId: string, pendingHumanAskSeq: (runId: string) => number | undefined): boolean {
  return pendingHumanAskSeq(runId) !== undefined;
}
