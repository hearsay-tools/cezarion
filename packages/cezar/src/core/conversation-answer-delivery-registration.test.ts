import { registrationCollector, registrationCalls } from './split-registration.testkit.ts';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { ANSWER_DELIVERY_GROUPS, answerDeliveryCells } from './conversation-answer-delivery.testkit.ts';

it('registers every conversation-answer-delivery row exactly once', () => {
  const names: string[] = [];
  const collect = registrationCollector(names);
  for (const rows of Object.values(ANSWER_DELIVERY_GROUPS)) for (const row of rows) answerDeliveryCells[row.family](row.runner, collect);
  const actual = names.map(name => { const match = name.match(/^(\S+) (?:is exempt from )?(I\d+)/)!; return `${match[1]}:${match[2]}`; });
  const expected = RUNNER_IDS.flatMap(runner => ['I3', 'I4', 'I5'].map(row => `${runner}:${row}`));
  expect(actual.sort()).toEqual(expected.sort());
  const calls = registrationCalls(new URL('.', import.meta.url), 'conversation-answer-delivery-', 'registerAnswerDeliveryGroup');
  expect(calls.sort()).toEqual(Object.keys(ANSWER_DELIVERY_GROUPS).sort());
});
