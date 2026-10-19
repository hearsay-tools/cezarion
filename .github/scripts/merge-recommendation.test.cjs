const test = require('node:test');
const assert = require('node:assert/strict');
const { definition, challengeInput, evaluatorInstructions } = require('./merge-recommendation.cjs');
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
  assert.equal(d.task.steps[1].skill, undefined);
  assert.equal(d.task.steps[3].skill, undefined);
  assert.match(d.task.steps[4].command, /publish/);
  assert.throws(() => definition('o/r; echo unsafe', 9));
  assert.throws(() => definition('o/r', 0));
});

test('automation uses committed evaluator instructions and keeps shared journals rationale-free', () => {
  const d = definition('hearsay-tools/cezarion', 9);
  for (const step of [d.task.steps[1], d.task.steps[3]]) {
    assert.equal(step.skill, undefined, 'registry skills can resolve outside the policy checkout');
    assert.match(step.prompt, /evaluator-instructions\.md/);
  }
  assert.match(d.task.systemPrompt, /handoff.*operational only/i);
  assert.match(d.task.systemPrompt, /never.*rationale.*shared/i);
});

test('evaluator instructions are read from the named commit despite modified or overriding skills', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-evaluator-pin-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const skill = '.ai/skills/recommending-pr-merges/SKILL.md';
  fs.mkdirSync(path.join(cwd, path.dirname(skill)), { recursive: true });
  fs.writeFileSync(path.join(cwd, skill), 'committed evaluator instructions');
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); git('commit', '-qm', 'policy'); const policyCommit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cwd, skill), 'modified instructions');
  fs.mkdirSync(path.join(cwd, '.ai/cezar/skills/recommending-pr-merges'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ai/cezar/skills/recommending-pr-merges/SKILL.md'), 'registry override');
  const result = evaluatorInstructions({ cwd, policyCommit });
  assert.match(result, new RegExp(policyCommit));
  assert.match(result, /committed evaluator instructions/);
  assert.doesNotMatch(result, /modified instructions|registry override/);
});
