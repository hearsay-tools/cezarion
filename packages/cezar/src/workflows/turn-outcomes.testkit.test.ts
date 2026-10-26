import { describe, expect, it } from 'vitest';
import { RunManager } from './run.ts';
import type { TurnEndOutcome } from './turn-end.ts';
import { outcomeWord } from './turn-outcomes.testkit.ts';

describe('outcomeWord gives the old heartbeat word per outcome (hearsay-tools/cezarion#1525)', () => {
  it.each<[TurnEndOutcome, string | undefined]>([
    [{ kind: 'nudge', cause: 'completion', autonomous: false }, 'running (completion nudge)'],
    [{ kind: 'nudge', cause: 'completion', autonomous: true }, 'running (completion nudge)'],
    [{ kind: 'nudge', cause: 'no-wait', autonomous: true }, 'running (autonomous nudge)'],
    [{ kind: 'nudge', cause: 'no-wait', autonomous: false }, 'running (no-wait nudge)'],
    [{ kind: 'readiness' }, 'running (awaiting input readiness)'],
    [{ kind: 'running' }, 'running'],
    [{ kind: 'park', keepsSlot: true }, 'monitoring'],
    [{ kind: 'park', keepsSlot: false }, 'waiting'],
    [{ kind: 'done' }, undefined],
  ])('%o is %s', (outcome, word) => {
    expect(outcomeWord(outcome)).toBe(word);
  });
});

// The heartbeat line skipped these entries (hearsay-tools/cezarion#1525); the seam that replaced
// it (hearsay-tools/cezarion#1809) reports no outcome for them, so the cells keep their words.
describe('settledTurnOutcome', () => {
  const seam = (RunManager.prototype as unknown as {
    settledTurnOutcome(runId: string, entry: string, outcome: TurnEndOutcome): TurnEndOutcome | undefined;
  }).settledTurnOutcome;
  it.each<[string, TurnEndOutcome, TurnEndOutcome | undefined]>([
    ['turn-end', { kind: 'park', keepsSlot: false }, { kind: 'park', keepsSlot: false }],
    ['ack', { kind: 'running' }, { kind: 'running' }],
    ['ready', { kind: 'nudge', cause: 'no-wait', autonomous: true }, { kind: 'nudge', cause: 'no-wait', autonomous: true }],
    ['ready', { kind: 'readiness' }, undefined],
    ['gate', { kind: 'park', keepsSlot: true }, undefined],
    ['reply-timer', { kind: 'park', keepsSlot: false }, { kind: 'park', keepsSlot: false }],
  ])('%s with %o reports %o', (entry, outcome, reported) => {
    expect(seam.call(undefined, 'run-1', entry, outcome)).toEqual(reported);
  });
});
