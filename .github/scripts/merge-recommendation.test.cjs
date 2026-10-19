const test = require('node:test');
const assert = require('node:assert/strict');
const { definition, challengeInput, evaluatorInstructions, main } = require('./merge-recommendation.cjs');
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

test('CLI preview shows the same reused recommendation the publisher would post', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { renderComment, renderSummary, readComment } = require('./merge-recommendation-report.cjs');
  const { decide } = require('./merge-recommendation-policy.cjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-preview-cli-')), previousCwd = process.cwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(cwd, '.ai/skills/recommending-pr-merges'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ai/skills/recommending-pr-merges/SKILL.md'), 'committed skill');
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); git('commit', '-qm', 'policy'); const policyCommit = git('rev-parse', 'HEAD');
  const s = snapshot({ policyCommit }), actor = { id: 42, login: 'writer' };
  const c = { repository: s.repository, actor, policyCommit, trusted: true, defaultBranch: 'main' };
  const body = renderComment(s, decide(s, assessment(s), assessment(s)), 9);
  const gh = {
    api: async (method, route) => {
      assert.equal(method, 'GET'); assert.ok(route.endsWith('/issues/9'));
      return { user: actor, state: 'open', body: renderSummary({ records: [] }) };
    },
    pages: async () => [{ id: 11, user: actor, body }],
  };
  const directory = path.join(cwd, '.ai/tmp/merge-recommendation'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'batch.json'), JSON.stringify({ ...c, summaryNumber: 9, snapshots: [s] }));
  for (const file of ['primary.json', 'challenge.json']) fs.writeFileSync(path.join(directory, file), '[]');
  fs.writeFileSync(path.join(directory, 'evaluator-instructions.md'), evaluatorInstructions({ cwd, policyCommit }));
  try {
    process.chdir(cwd);
    const result = await main(['publish', '--repo', s.repository, '--summary', '9', '--preview'], { gh, context: async () => c, refresh: async () => s });
    const reports = JSON.parse(fs.readFileSync(path.join(cwd, result.preview), 'utf8'));
    assert.equal(readComment(reports[0].body).decision, 'recommend');
    assert.equal(reports[0].body, body);
  } finally { process.chdir(previousCwd); }
});

test('collection rejects an oversized serialized cohort before replacing the previous readable batch', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { renderSummary } = require('./merge-recommendation-report.cjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-batch-limit-')), previousCwd = process.cwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(cwd, '.ai/skills/recommending-pr-merges'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.ai/skills/recommending-pr-merges/SKILL.md'), 'committed skill');
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); git('commit', '-qm', 'policy'); const policyCommit = git('rev-parse', 'HEAD');
  const actor = { id: 42, login: 'writer' }, repository = snapshot().repository;
  const c = { repository, actor, policyCommit, trusted: true, defaultBranch: 'main' };
  // Each raw diff fits the 1 MiB evidence bound; JSON escaping makes the cohort exceed 40 MiB.
  const diff = 'diff --git a/README.md b/README.md\n+' + '"'.repeat(900000);
  const open = Array.from({ length: 25 }, (_, i) => ({ number: i + 1 }));
  const gh = {
    api: async (method, route) => {
      assert.equal(method, 'GET');
      if (route.endsWith('/issues/9')) return { user: actor, state: 'open', body: renderSummary({ records: [] }) };
      assert.match(route, /pulls\?state=open/); return open;
    },
    pages: async () => [],
  };
  const directory = path.join(cwd, '.ai/tmp/merge-recommendation'); fs.mkdirSync(directory, { recursive: true });
  const previousBatch = JSON.stringify({ ...c, summaryNumber: 9, snapshots: [] });
  fs.writeFileSync(path.join(directory, 'batch.json'), previousBatch);
  try {
    process.chdir(cwd);
    await assert.rejects(main(['collect', '--repo', repository, '--summary', '9'], {
      gh, context: async () => c,
      collectSnapshot: async ({ number }) => snapshot({ number, policyCommit, diff }),
    }), /byte limit/i);
    assert.equal(fs.readFileSync(path.join(directory, 'batch.json'), 'utf8'), previousBatch);
  } finally { process.chdir(previousCwd); }
});
