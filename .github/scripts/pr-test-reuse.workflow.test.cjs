'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');
const ci = () => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
const suites = ['vitest', 'cockpit-browser'];
function context(event = 'merge_group', result = 'success', verified = 'true') {
  return { github: { event_name: event, sha: 'queue-sha', workflow_sha: 'trusted-base',
    event: { pull_request: { head: { sha: 'native-head' }, base: { ref: 'main' } } } },
  needs: { 'pr-test-proof': { result, outputs: { verified, source: 'https://github.com/o/r/actions/runs/1' } },
    'pr-test-input': { result: 'success', outputs: { sha: 'immutable-sha', reusable: 'true' } },
    'queue-proof': { result: 'success', outputs: { verified: 'false' } },
    preflight: { result: 'success' }, 'review-result': { result: 'success' },
    'change-surface': { outputs: { surface: 'full-matrix' } }, 'classify-pr': { outputs: { bump_pr: 'false' } },
    vitest: { result: 'success' }, 'cockpit-browser': { result: 'success' } },
  steps: { 'resolve-dispatch': { outputs: { valid: '' } }, collect: { outcome: 'success' }, upload: { outcome: 'success' } },
  inputs: {}, cancelled: () => false, always: () => true, failure: () => false, hashFiles: () => 'lock' };
}
function evaluate(raw, ctx) {
  return runInNewContext(raw.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']"), ctx);
}
test('verified queue suites run only a reuse receipt, preserving successful matrix jobs', () => {
  for (const id of suites) {
    const job = ci().jobs[id], ctx = context();
    assert.equal(evaluate(job.if, ctx), true);
    const runnable = job.steps.filter(s => !s.if || evaluate(s.if, ctx));
    assert.deepEqual(runnable.map(s => s.name), ['Reuse verified native PR suite']);
    const receipt = runnable[0];
    assert.equal(spawnSync('bash', ['-eu', '-c', receipt.run], { env: { PATH: process.env.PATH, SOURCE: 'native-run/attempt/1', GITHUB_STEP_SUMMARY: '/dev/null' } }).status, 0);
  }
});
for (const result of ['failure', 'cancelled', 'skipped', 'success']) {
  for (const verified of ['', 'false', 'true']) test(`full suite fallback for proof ${result}/${verified}`, () => {
    const ctx = context('merge_group', result, verified);
    const reused = result === 'success' && verified === 'true';
    for (const id of suites) {
      const job = ci().jobs[id];
      assert.equal(evaluate(job.if, ctx), true, 'proof failure cannot skip the matrix');
      const testStep = job.steps.find(s => s.run?.startsWith(id === 'vitest' ? 'npm test --' : 'set -o pipefail'));
      assert.equal(evaluate(testStep.if, ctx), !reused);
      assert.equal(evaluate(job.steps.find(s => s.uses?.startsWith('actions/checkout@')).if, ctx), !reused);
    }
  });
}
test('only native PRs resolve and attest test inputs, after both complete suites', () => {
  const { jobs } = ci(); const input = jobs['pr-test-input'], attestation = jobs['pr-test-attestation'];
  assert.equal(input.steps[0].with.ref, '${{ github.workflow_sha }}');
  assert.equal(input.steps[0].with['persist-credentials'], false);
  assert.deepEqual(input.permissions, { contents: 'read' });
  assert.deepEqual(attestation.permissions, {});
  assert.deepEqual(attestation.needs, ['pr-test-input', 'vitest', 'cockpit-browser']);
  assert.equal(attestation.name, 'Attest PR test inputs / ${{ github.workflow_sha }} / ${{ github.event.pull_request.head.sha }}');
  for (const event of ['pull_request_target', 'merge_group', 'push', 'workflow_dispatch']) {
    const ctx = context(event);
    assert.equal(evaluate(input.if, ctx), event === 'pull_request_target');
    assert.equal(evaluate(attestation.if, ctx), event === 'pull_request_target');
  }
  for (const id of ['pr-test-input', ...suites]) for (const result of ['failure', 'skipped', 'cancelled']) {
    const ctx = context('pull_request_target'); ctx.needs[id].result = result;
    assert.equal(evaluate(attestation.if, ctx), false);
  }
  const ctx = context('pull_request_target'); ctx.needs['pr-test-input'].outputs.reusable = 'false';
  assert.equal(evaluate(attestation.if, ctx), false);
});
test('native PR suites use resolver inputs and cannot run with a failed resolver', () => {
  const ctx = context('pull_request_target', 'skipped', '');
  for (const id of suites) {
    const job = ci().jobs[id], checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
    assert.equal(evaluate(checkout.with.ref, ctx), 'immutable-sha');
    ctx.needs['pr-test-input'].result = 'failure';
    assert.equal(evaluate(job.if, ctx), false);
    ctx.needs['pr-test-input'].result = 'success';
  }
});
test('queue proof executes only trusted base code with read scopes and no paid review', () => {
  const job = ci().jobs['pr-test-proof'];
  assert.equal(job.steps[0].with.ref, '${{ github.event.merge_group.base_sha }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  for (const event of ['pull_request_target', 'merge_group', 'push', 'workflow_dispatch']) assert.equal(evaluate(job.if, context(event)), event === 'merge_group');
  assert.equal(job['timeout-minutes'], 2);
  assert.equal(job.steps[1].with.retries, 0);
});
test('reuse leaves commit-dependent queue checks and the exact queue-to-main roster intact', () => {
  const jobs = ci().jobs;
  for (const id of ['typecheck', 'build-and-package']) {
    assert.equal(evaluate(jobs[id].if, context()), true);
    assert.ok(jobs[id].steps.every(s => !s.if?.includes('pr-test-proof')));
  }
  for (const id of ['preflight', 'verify']) assert.ok(!JSON.stringify(jobs[id]).includes('pr-test-proof'));
  const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
  for (const name of require('./pr-test-proof.cjs').PR_TEST_JOBS) assert.ok(REQUIRED_QUEUE_JOBS.includes(name));
});
