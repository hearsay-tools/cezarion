import type { RunOutcome } from '../runs/outcome-commit.ts';

/**
 * The outcome lists `workflows/run.ts` commits through `RunStore.commitOutcome`
 * (hearsay-tools/cezarion#1805), built here so each delivery path names what it commits in one call.
 */

/** A spent automatic wake, when there is one. */
export function chargedIf(spent: number | undefined): RunOutcome[] {
  return spent === undefined ? [] : [{ kind: 'charged', automaticWakes: spent }];
}

/** An acknowledged input batch: its messages first, so a message a wait carries keeps its read
 *  receipt (`awaitingRead` on an observable harness, #505); then each resolved wait's delivery; the
 *  charge; and the reads the harness reported before the acknowledgement. */
export function acknowledgedBatch(batch: { accepted: readonly string[]; resolvedIds: readonly string[]; early: readonly string[];
  spent: number | undefined; observable: boolean; at: string }): RunOutcome[] {
  const { accepted, resolvedIds, early, at } = batch;
  return [
    ...(accepted.length ? [{ kind: 'delivered' as const, inputIds: accepted, at, ...(batch.observable ? { awaitingRead: true as const } : {}) }] : []),
    ...(resolvedIds.length ? [{ kind: 'delivered' as const, inputIds: resolvedIds, at }] : []),
    ...chargedIf(batch.spent),
    ...(early.length ? [{ kind: 'consumed' as const, inputIds: early, at }] : []),
  ];
}

/** A human message: its answered waits, deferred queue entry and restarted wake accounting. */
export function answerOutcomes(messageId: string | undefined, automaticWakes: number | undefined): RunOutcome[] {
  return [{ kind: 'answered' }, ...(messageId ? [{ kind: 'message-delivered' as const, messageId }] : []),
    ...chargedIf(automaticWakes ? 0 : undefined), { kind: 'counted', waitDeliveryFailures: undefined }];
}
