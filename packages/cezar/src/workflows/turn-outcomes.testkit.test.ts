import { describe, expect, it } from 'vitest';
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
