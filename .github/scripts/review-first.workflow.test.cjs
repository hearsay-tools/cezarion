'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const ci = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
const heavy = ['build-and-package', 'vitest', 'cockpit-browser'];
function context(event = 'pull_request_target', base = 'main') {
  return { github: { event_name: event, event: { pull_request: { base: { ref: base } } } },
    needs: { preflight: { result: 'success' }, 'review-result': { result: 'success' },
      'queue-proof': { result: 'success', outputs: { verified: 'false' } },
      'change-surface': { outputs: { surface: 'full-matrix' } }, 'classify-pr': { outputs: { bump_pr: 'false' } } },
    cancelled: () => false, always: () => true };
}
function evaluate(value, ctx) {
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']"), ctx);
}
function shell(job, overrides = {}) {
  const env = { PATH: process.env.PATH, BASH_ENV: '/dev/null', CANCELLED: 'false', EVENT_NAME: 'pull_request_target',
    BASE_REF: 'main', PR_NUMBER: '', PREFLIGHT_RESULT: 'success', REVIEW_RESULT: 'success', CLASSIFY_RESULT: 'success',
    SURFACE_RESULT: 'success', COMPLEXITY_RESULT: 'success', CLONE_RESULT: 'success', COMPLEXITY_GATE_RESULT: 'success',
    CLONE_GATE_RESULT: 'success', TYPECHECK_RESULT: 'success', BUILD_AND_PACKAGE_RESULT: 'success',
    VITEST_RESULT: 'success', COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE: 'full-matrix', BUMP_PR: 'false',
    PROOF_RESULT: 'success', PROOF_VERIFIED: 'false', ...overrides };
  return spawnSync('bash', ['--noprofile', '--norc', '-eu', '-c', ci.jobs[job].steps[0].run], { env, encoding: 'utf8' });
}
function ancestors(id, chain = []) {
  assert.ok(!chain.includes(id), `CI dependency cycle: ${[...chain, id]}`);
  return [ci.jobs[id].needs ?? []].flat().flatMap(dep => [dep, ...ancestors(dep, [...chain, id])]);
}
test('review-first DAG releases heavy work only after review, without waiting on heavy ancestors', () => {
  for (const id of Object.keys(ci.jobs)) ancestors(id);
  for (const id of heavy) {
    assert.ok(ancestors(id).includes('review-result'), `${id} must be held by review`);
    assert.ok(!ancestors('review').includes(id), `${id} must not hold review`);
    assert.match(ci.jobs[id].if, /!cancelled\(\)/, 'intentional skips cannot invoke implicit success()');
  }
  assert.equal(ci.jobs.review.needs, 'preflight');
});
for (const result of ['failure', 'cancelled', 'skipped', '']) {
  test(`review ${result} prevents all heavy jobs and a green aggregate`, () => {
    const ctx = context(); ctx.needs['review-result'].result = result;
    for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), false, id);
    assert.notEqual(shell('verify', { REVIEW_RESULT: result }).status, 0);
  });
}
test('passing review releases heavy work but never excuses missing, blocked or failed tests', () => {
  for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, context()), true, id);
  for (const key of ['BUILD_AND_PACKAGE_RESULT', 'VITEST_RESULT', 'COCKPIT_BROWSER_RESULT']) {
    for (const result of ['failure', 'skipped', 'cancelled', '']) assert.notEqual(shell('verify', { [key]: result }).status, 0);
  }
  assert.equal(shell('verify').status, 0);
});
for (const [event, base] of [['pull_request_target', 'release/v1.2'], ['push', 'main'], ['workflow_dispatch', 'main'], ['merge_group', 'main']]) {
  test(`${event}/${base} heavy jobs tolerate the inapplicable skipped PR review`, () => {
    const ctx = context(event, base); ctx.needs['review-result'].result = 'skipped';
    for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), true, id);
    assert.equal(shell('verify', { EVENT_NAME: event, BASE_REF: base, REVIEW_RESULT: 'skipped' }).status, 0);
  });
}
test('only existing trusted docs/infra/bump exemptions skip shards, never build/package', () => {
  for (const surface of ['docs-only', 'infra-only']) {
    const ctx = context(); ctx.needs['change-surface'].outputs.surface = surface;
    assert.equal(evaluate(ci.jobs['build-and-package'].if, ctx), true);
    for (const id of heavy.slice(1)) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
    assert.equal(shell('verify', { CHANGE_SURFACE: surface, VITEST_RESULT: 'skipped', COCKPIT_BROWSER_RESULT: 'skipped' }).status, 0);
  }
  const ctx = context(); ctx.needs['classify-pr'].outputs.bump_pr = 'true';
  for (const id of heavy.slice(1)) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
});
test('cancellation and failed preflight cannot release work or green required gates', () => {
  const ctx = context(); ctx.cancelled = () => true;
  for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
  for (const id of ['preflight', 'review-result', 'verify', 'queue-review-result']) assert.notEqual(shell(id, { CANCELLED: 'true' }).status, 0);
  ctx.cancelled = () => false; ctx.needs.preflight.result = 'failure';
  for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
  assert.notEqual(shell('verify', { PREFLIGHT_RESULT: 'failure' }).status, 0);
});
test('preflight requires all applicable cheap gates and permits only exact queue proof typecheck reuse', () => {
  assert.equal(shell('preflight').status, 0);
  for (const key of ['CLASSIFY_RESULT', 'SURFACE_RESULT', 'COMPLEXITY_RESULT', 'CLONE_RESULT', 'TYPECHECK_RESULT']) {
    for (const result of ['failure', 'skipped', 'cancelled', '']) assert.notEqual(shell('preflight', { [key]: result }).status, 0);
  }
  assert.equal(shell('preflight', { EVENT_NAME: 'push', PROOF_VERIFIED: 'true', TYPECHECK_RESULT: 'skipped' }).status, 0);
  assert.notEqual(shell('preflight', { PROOF_VERIFIED: 'true', TYPECHECK_RESULT: 'skipped' }).status, 0);
});
test('exactly one applicable job owns the protected review name for main PRs and queue entries', () => {
  for (const [event, base, expected] of [['pull_request_target', 'main', 1], ['merge_group', 'main', 1], ['push', 'main', 0],
    ['workflow_dispatch', 'main', 0], ['pull_request_target', 'release/v1', 0]]) {
    const ctx = context(event, base);
    const named = ['review-result', 'queue-review-result'].filter(id => evaluate(ci.jobs[id].name, ctx) === 'Automated Code Review');
    assert.equal(named.length, expected);
    for (const id of named) assert.equal(evaluate(ci.jobs[id].if, ctx), true);
  }
});

test('always aggregates reject cancellation even if all retained prerequisites succeeded', () => {
  const review = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/automated-code-review.yml'), 'utf8'));
  for (const job of [ci.jobs.preflight, ci.jobs.verify, ci.jobs['review-result'], ci.jobs['queue-review-result'], review.jobs['review-complete']]) {
    const guard = job.steps.find(step => step.name === 'Reject a cancelled run');
    assert.ok(guard);
    assert.equal(evaluate(guard.if, { cancelled: () => true }), true);
    assert.notEqual(spawnSync('bash', ['-c', guard.run]).status, 0);
  }
  assert.equal(evaluate(review.jobs['post-review'].if, { cancelled: () => true }), false, 'no mutation after cancellation');
});

test('reused/skipped review reads the live head and fresh bot threads before release', async () => {
  const review = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/automated-code-review.yml'), 'utf8'));
  const script = review.jobs['post-review'].steps.find(step => step.id === 'post').with.script;
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('require', 'github', 'context', 'core', 'process', script);
  const outputs = {};
  const state = { head: 'a', resolved: false };
  const github = { rest: { pulls: { get: async () => ({ data: { head: { sha: state.head } } }) } },
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: {
      nodes: [{ id: 'thread', isResolved: state.resolved, comments: { nodes: [{ databaseId: 1, author: { login: 'github-actions[bot]' } }] } }],
      pageInfo: { hasNextPage: false },
    } } } }) };
  const load = name => name === './.github/scripts/automated-review.cjs' ? require('./automated-review.cjs') : require(name);
  const run = () => execute(load, github, { repo: { owner: 'o', repo: 'r' } }, { setOutput: (key, value) => { outputs[key] = value; } },
    { env: { PR_NUMBER: '7', HEAD_SHA: 'a', CAN_REVIEW: 'false' } });
  await run(); assert.equal(outputs.open_threads, '1');
  state.resolved = true;
  await run(); assert.equal(outputs.open_threads, '0'); assert.equal(outputs.new_threads, '0');
  state.head = 'new';
  await assert.rejects(run(), /stale PR head/);
  github.rest.pulls.get = async () => { throw new Error('API unavailable'); };
  await assert.rejects(run(), /API unavailable/);
});

test('failed-test retry retains review, while a successful review-only retry releases blocked jobs', () => {
  const ctx = context(); ctx.needs['review-result'].result = 'failure';
  for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
  ctx.needs['review-result'].result = 'success';
  for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), true);
  assert.notEqual(shell('verify', { VITEST_RESULT: 'failure' }).status, 0);
  // Failed-job selection is GitHub-owned. The graph must not make successful
  // review depend on those failed tests, so a test retry cannot invalidate it.
  assert.ok(!ancestors('review-result').includes('vitest'));
  assert.equal(shell('verify', { VITEST_RESULT: 'success' }).status, 0);
});
