const test = require('node:test');
const assert = require('node:assert/strict');
const { definition, challengeInput } = require('./merge-recommendation.cjs');
const { snapshot, assessment } = require('./fixtures/merge-recommendation.cjs');

test('independent challenger receives only positive candidates without the first evaluator rationale', () => {
  const a = snapshot(), b = snapshot({ number: 2 });
  const result = challengeInput([a, b], [assessment(a), assessment(b, { decision: 'human-review', reason: 'Policy changes.' })]);
  assert.deepEqual(result.map(s => s.number), [1]);
  assert.equal(JSON.stringify(result).includes('Corrects spelling without changing instructions.'), false);
  assert.equal(JSON.stringify(result).includes('assessor'), false);
  assert.throws(() => challengeInput([a], [assessment(a, { key: 'stale' })]), /assessment/i);
});

test('automation separates collection, two fresh evaluator sessions and deterministic publication', () => {
  const d = definition('hearsay-tools/cezarion', 9);
  assert.deepEqual(d.schedule, { type: 'hours', every: 6 });
  assert.equal(d.task.worktree, true); assert.equal(d.task.autonomous, true);
  assert.equal(d.task.generateFollowups, false);
  assert.deepEqual(d.task.steps.map(s => s.id), ['collect', 'assess', 'prepare-challenge', 'challenge', 'publish']);
  assert.equal(d.task.steps[1].skill, 'recommending-pr-merges');
  assert.equal(d.task.steps[3].skill, 'recommending-pr-merges');
  assert.match(d.task.steps[4].command, /publish/);
  assert.throws(() => definition('o/r; echo unsafe', 9));
  assert.throws(() => definition('o/r', 0));
});
