import { onTestFinished, vi } from 'vitest';
import { RunManager } from './run.ts';
import type { TurnEndOutcome } from './turn-end.ts';

/**
 * The outcome of each turn a RunManager settles, read through its private `settledTurnOutcome`
 * seam. Until hearsay-tools/cezarion#1809 a parity cell read this word from the handoff's
 * `turn complete — status=<word>` heartbeat line; cezar no longer writes that line, and the run
 * status alone cannot tell, for example, input readiness from the already-ready path.
 */
type Seam = { settledTurnOutcome(runId: string, entry: string, outcome: TurnEndOutcome): TurnEndOutcome | undefined };

/** The word the heartbeat line carried for `outcome`; a done carried none. */
export function outcomeWord(outcome: TurnEndOutcome): string | undefined {
  switch (outcome.kind) {
    case 'nudge':
      if (outcome.cause === 'completion') return 'running (completion nudge)';
      return outcome.autonomous ? 'running (autonomous nudge)' : 'running (no-wait nudge)';
    case 'readiness': return 'running (awaiting input readiness)';
    case 'running': return 'running';
    case 'park': return outcome.keepsSlot ? 'monitoring' : 'waiting';
    case 'done': return undefined;
  }
}

export interface TurnOutcomes {
  /** The outcomes settled for `runId`, oldest first. */
  outcomes(runId: string): TurnEndOutcome[];
  /** The same, as heartbeat words. */
  words(runId: string): string[];
}

/** Spy on every RunManager's seam until the current test ends. Call it in a test or a `beforeEach`. */
export function watchTurnOutcomes(): TurnOutcomes {
  const spy = vi.spyOn(RunManager.prototype as unknown as Seam, 'settledTurnOutcome');
  onTestFinished(() => spy.mockRestore());
  const outcomes = (runId: string) => spy.mock.calls.flatMap(([id], index) => {
    const result = spy.mock.results[index];
    return id === runId && result?.type === 'return' && result.value ? [result.value] : [];
  });
  return {
    outcomes,
    words: (runId) => outcomes(runId).flatMap((outcome) => outcomeWord(outcome) ?? []),
  };
}
