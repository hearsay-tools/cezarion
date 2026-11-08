import { describe, expect, it } from 'vitest';
import { inputDeliveryOf, RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { exemptionFor } from './harness-parity-core.testkit.ts';
import { createRunner } from './runner-factory.ts';
import { RUNNER_FACTS, runnersWhere } from './runner-facts.ts';

describe('declared runner facts (hearsay-tools/cezarion#2991)', () => {
  it('gives every runner createRunner builds the table row for its id', () => {
    for (const id of RUNNER_IDS) expect(createRunner(id).facts, id).toBe(RUNNER_FACTS[id]);
    // The legacy id builds Claude's runner, so it carries Claude's row.
    expect(createRunner('claude-cli').facts).toBe(RUNNER_FACTS.claude);
  });

  it('selects runners by fact in RUNNER_IDS order', () => {
    expect(runnersWhere(facts => facts.nativeSubagents === 'reported')).toEqual(['claude', 'codex']);
    expect(runnersWhere(facts => facts.nativeTimerTool !== null)).toEqual(['claude']);
  });

  it('keeps every boundary runner holding a mid-turn human message until the turn ends', () => {
    for (const id of RUNNER_IDS) {
      const delivery = inputDeliveryOf(createRunner(id));
      if (delivery.mode === 'boundary') expect(delivery.humanInputAtTurnEnd, id).toBe('always-held');
    }
  });

  // These rows hold runner ids by hand because the parity testkit must not load every runner
  // class (hearsay-tools/cezarion#2939); this check ties each one to the declared acknowledgement.
  it.each([
    ['U12', (runner: RunnerId) => inputDeliveryOf(createRunner(runner)).acknowledgement === 'write'],
    ['U13', (runner: RunnerId) => inputDeliveryOf(createRunner(runner)).acknowledgement !== 'response'],
    ['U27', (runner: RunnerId) => inputDeliveryOf(createRunner(runner)).acknowledgement !== 'response'],
  ] as const)('exempts a runner from %s exactly when its acknowledgement cannot be delayed or rejected', (criterion, exempt) => {
    expect(RUNNER_IDS.filter(runner => exemptionFor(criterion, runner) !== undefined)).toEqual(RUNNER_IDS.filter(exempt));
  });
});
