import type { TurnEndOutcome } from './turn-end.ts';

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
