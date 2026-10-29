'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const workflow = () => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));

test('combined queue revisions request the required gate before reaching main', () => {
  assert.deepEqual(workflow().on.merge_group, { types: ['checks_requested'], branches: ['main'] });
});

const { runInNewContext } = require('node:vm');
const { spawnSync } = require('node:child_process');
function context(event = 'merge_group') {
  return { github: { event_name: event, sha: 'a'.repeat(40), ref: 'refs/heads/main', repository: 'o/r',
    event: { pull_request: { base: { ref: 'main' } }, merge_group: { base_sha: 'b'.repeat(40) } } },
    steps: { 'resolve-dispatch': { outputs: {} } }, inputs: {},
    needs: { 'queue-proof': { result: 'success', outputs: { verified: 'false' } },
      'change-surface': { result: 'success', outputs: { surface: 'full-matrix' } },
      'classify-pr': { result: 'success', outputs: { bump_pr: 'false' } },
      preflight: { result: 'success' }, 'review-result': { result: 'skipped' }, verify: { result: 'success' }, review: { result: 'skipped' }, 'queue-admission': { result: 'success' } },
    cancelled: () => false, always: () => true };
}
function evaluate(expression, ctx) {
  const raw = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  // Model Actions' implicit success() for expressions without a status function.
  const status = /\b(?:always|cancelled|success|failure)\(/.test(raw);
  const successful = Object.values(ctx.needs).every(n => n.result === 'success' || n.result === 'skipped');
  const value = runInNewContext(raw, ctx);
  return (typeof value === 'boolean' && !status && !successful) ? false : value;
}
function shell(command, env = {}) {
  return spawnSync('bash', ['-eu', '-c', command], { encoding: 'utf8', env: { PATH: process.env.PATH,
    CANCELLED: 'false', PREFLIGHT_RESULT: 'success', BASE_REF: '', REVIEW_RESULT: 'skipped', EVENT_NAME: 'merge_group', CLASSIFY_RESULT: 'success', SURFACE_RESULT: 'success', COMPLEXITY_GATE_RESULT: 'success', CLONE_GATE_RESULT: 'success',
    TYPECHECK_RESULT: 'success', BUILD_AND_PACKAGE_RESULT: 'success', VITEST_RESULT: 'success',
    COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE: 'full-matrix', BUMP_PR: 'false',
    VERIFIED_SHA: 'a'.repeat(40), PROOF_RESULT: 'success', PROOF_VERIFIED: 'false', PROOF_SOURCE: '', GITHUB_STEP_SUMMARY: '/dev/null', ...env } });
}
test('proof roster expands every verification matrix and queue admission', () => {
  const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
  const ci = workflow();
  const names = ['change-surface', 'classify-pr', 'complexity-gate', 'clone-gate', 'preflight', 'typecheck', 'build-and-package', 'vitest', 'cockpit-browser', 'verify', 'queue-admission']
    .flatMap(id => {
      const j = ci.jobs[id];
      return j.strategy ? j.strategy.matrix.shard.map(n => j.name.replace('${{ matrix.shard }}', String(n))) : [j.name];
    });
  names.push(evaluate(ci.jobs['queue-review-result'].name, context()));
  assert.deepEqual(names.sort(), [...REQUIRED_QUEUE_JOBS].sort());
});
test('queue always runs the complete immutable combined revision and no paid review or publication', () => {
  const ci = workflow(), ctx = context();
  for (const id of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) {
    assert.equal(evaluate(ci.jobs[id].if, ctx), true, id);
    const checkout = ci.jobs[id].steps.find(s => s.uses?.startsWith('actions/checkout@'));
    assert.equal(evaluate(checkout.with.ref, ctx), ctx.github.sha);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(Object.values(ci.jobs[id].permissions).every(p => p === 'read'));
  }
  for (const id of ['review', 'publish-snapshot', 'prepare-pr-snapshot']) assert.equal(evaluate(ci.jobs[id].if, ctx), false, id);
  assert.equal(evaluate(ci.jobs['queue-admission'].if, ctx), true);
  const checkout = ci.jobs['queue-admission'].steps[0];
  assert.equal(evaluate(checkout.with.ref, ctx), ctx.github.event.merge_group.base_sha);
  assert.ok(Object.values(ci.jobs['queue-admission'].permissions).every(p => p === 'read'));
  const classifier = ci.jobs['classify-pr'].steps.find(s => s.id === 'classify');
  const temp = fs.mkdtempSync(require('node:os').tmpdir() + '/queue-classify-');
  try {
    const output = path.join(temp, 'output');
    assert.equal(shell(classifier.run, { GITHUB_OUTPUT: output }).status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), 'bump_pr=false\n');
    assert.equal(shell(ci.jobs['change-surface'].steps.find(s => s.id === 'classify').run, { GITHUB_OUTPUT: output }).status, 0);
    assert.match(fs.readFileSync(output, 'utf8'), /surface=full-matrix/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('failed probe or absent proof runs full main fallback then permits successful publishing', () => {
  const ci = workflow();
  for (const result of ['failure', 'success', 'skipped', 'cancelled']) for (const verified of ['', 'false', 'true']) {
    const ctx = context('push'); ctx.needs['queue-proof'] = { result, outputs: { verified } };
    const reuse = result === 'success' && verified === 'true';
    for (const id of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) {
      assert.equal(evaluate(ci.jobs[id].if, ctx), !reuse, `${id} ${result} ${verified}`);
      ctx.needs[id] = { result: reuse ? 'skipped' : 'success' };
    }
    const gate = shell(ci.jobs.verify.steps[0].run, { EVENT_NAME: 'push', PROOF_RESULT: result, PROOF_VERIFIED: verified,
      ...Object.fromEntries(['TYPECHECK_RESULT', 'BUILD_AND_PACKAGE_RESULT', 'VITEST_RESULT', 'COCKPIT_BROWSER_RESULT'].map(k => [k, reuse ? 'skipped' : 'success'])) });
    assert.equal(gate.status, 0, gate.stderr);
    assert.equal(evaluate(ci.jobs['publish-snapshot'].if, ctx), true, `${result} ${verified}`);
    assert.equal(evaluate(ci.jobs['publish-snapshot'].steps[0].with.ref, ctx), ctx.github.sha);
  }
});
test('queue aggregate rejects failures and skips even if classifier offers exemptions', () => {
  const command = workflow().jobs.verify.steps[0].run;
  for (const key of ['TYPECHECK_RESULT', 'BUILD_AND_PACKAGE_RESULT', 'VITEST_RESULT', 'COCKPIT_BROWSER_RESULT', 'CLASSIFY_RESULT', 'SURFACE_RESULT']) {
    for (const result of ['failure', 'skipped', 'cancelled']) {
      assert.notEqual(shell(command, { [key]: result, CHANGE_SURFACE: 'docs-only', BUMP_PR: 'true' }).status, 0, `${key} ${result}`);
    }
  }
});
test('required review name cannot pass from a skipped model call on a queue event', () => {
  const ci = workflow(), ctx = context(); const j = ci.jobs['queue-review-result'];
  assert.equal(evaluate(j.if, ctx), true);
  assert.equal(evaluate(j.name, ctx), 'Automated Code Review');
  for (const result of ['success', 'skipped', 'failure', 'cancelled', '']) {
    const r = shell(j.steps[0].run, { VERIFY_RESULT: 'success', REVIEW_RESULT: 'skipped', QUEUE_RESULT: result });
    assert.equal(r.status === 0, result === 'success', result);
  }
});
test('dispatch remains full verification and cancellation prevents publishing', () => {
  const ci = workflow(); const ctx = context('workflow_dispatch');
  for (const id of ['typecheck', 'build-and-package', 'vitest', 'cockpit-browser']) assert.equal(evaluate(ci.jobs[id].if, ctx), true);
  for (const id of ['review', 'queue-admission', 'review-result', 'publish-snapshot', 'prepare-pr-snapshot']) assert.equal(evaluate(ci.jobs[id].if, ctx), false, id);
  ctx.github.event_name = 'push'; ctx.cancelled = () => true;
  assert.equal(evaluate(ci.jobs['publish-snapshot'].if, ctx), false);
});
test('full rerun refreshes proof; failed-jobs-only rerun retains recorded immutable proof', () => {
  const ci = workflow(); const ctx = context('push');
  ctx.needs['queue-proof'].outputs.verified = 'true';
  assert.equal(evaluate(ci.jobs.vitest.if, ctx), false);
  // A full rerun executes the proof again. A now failed source yields verified=false.
  ctx.needs['queue-proof'].outputs.verified = 'false';
  assert.equal(evaluate(ci.jobs.vitest.if, ctx), true);
});

test('two independently passing changes can merge cleanly and fail the combined guard', () => {
  const dir = fs.mkdtempSync(require('node:os').tmpdir() + '/queue-conflict-');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  try {
    git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Queue fixture');
    fs.writeFileSync(path.join(dir, 'word.cjs'), "module.exports = 'old';\n");
    fs.writeFileSync(path.join(dir, 'guard.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./word.cjs').length, 3);\n");
    git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'first'); fs.writeFileSync(path.join(dir, 'word.cjs'), "module.exports = 'new';\n");
    git('commit', '-am', 'change word');
    const check = () => spawnSync(process.execPath, ['guard.cjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(check().status, 0);
    git('checkout', '-b', 'second', base);
    fs.writeFileSync(path.join(dir, 'guard.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./word.cjs'), 'old');\n");
    git('commit', '-am', 'tighten guard'); assert.equal(check().status, 0);
    git('merge', '--no-edit', 'first'); const combined = check();
    assert.notEqual(combined.status, 0); assert.match(combined.stderr, /new.*old|AssertionError/s);
    // Queue aggregate cannot authorize this cleanly merged but failing leaf.
    assert.notEqual(shell(workflow().jobs.verify.steps[0].run, { BUILD_AND_PACKAGE_RESULT: 'failure' }).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
