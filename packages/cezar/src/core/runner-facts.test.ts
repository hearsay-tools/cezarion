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

  // Tests that must not load the runner classes read the turn-path facts from the table, so each
  // runner instance must carry exactly its row's values.
  it('gives every runner instance the input delivery and resume prompt of its table row', () => {
    for (const id of RUNNER_IDS) {
      const runner = createRunner(id);
      expect(inputDeliveryOf(runner), id).toEqual(RUNNER_FACTS[id].inputDelivery);
      expect(runner.inputDelivery, id).toBe(RUNNER_FACTS[id].inputDelivery);
      expect(runner.systemPromptOnResume, id).toBe(RUNNER_FACTS[id].systemPromptOnResume);
    }
  });

  it('selects runners by fact in RUNNER_IDS order', () => {
    expect(runnersWhere(facts => facts.nativeSubagents === 'reported')).toEqual(['claude', 'codex']);
    expect(runnersWhere(facts => facts.nativeTimerTool !== null)).toEqual(['claude']);
  });

  it('keeps every boundary runner holding a mid-turn human message until the turn ends', () => {
    for (const id of RUNNER_IDS) {
      const delivery = RUNNER_FACTS[id].inputDelivery;
      if (delivery.mode === 'boundary') expect(delivery.humanInputAtTurnEnd, id).toBe('always-held');
    }
  });

  // These rows hold runner ids by hand; this check ties each one to the declared acknowledgement.
  it.each([
    ['U12', (runner: RunnerId) => RUNNER_FACTS[runner].inputDelivery.acknowledgement === 'write'],
    ['U13', (runner: RunnerId) => RUNNER_FACTS[runner].inputDelivery.acknowledgement !== 'response'],
    ['U27', (runner: RunnerId) => RUNNER_FACTS[runner].inputDelivery.acknowledgement !== 'response'],
  ] as const)('exempts a runner from %s exactly when its acknowledgement cannot be delayed or rejected', (criterion, exempt) => {
    expect(RUNNER_IDS.filter(runner => exemptionFor(criterion, runner) !== undefined)).toEqual(RUNNER_IDS.filter(exempt));
  });

  // S40/S41 time a mid-turn human message against the turn's last model call; a boundary runner has
  // no mid-turn input channel, so its mock has no read point to time it against.
  it.each(['S40', 'S41'])('exempts a runner from %s exactly when its delivery is boundary', criterion => {
    expect(RUNNER_IDS.filter(runner => exemptionFor(criterion, runner) !== undefined))
      .toEqual(RUNNER_IDS.filter(runner => RUNNER_FACTS[runner].inputDelivery.mode === 'boundary'));
  });
});
