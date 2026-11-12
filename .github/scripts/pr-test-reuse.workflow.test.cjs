'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const ci = () => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
function context(event) {
  return { github: { event_name: event, sha: 'queue-sha' },
    needs: { 'pr-test-input': { result: 'success', outputs: { sha: 'immutable-sha' } },
      'queue-proof': { result: 'success', outputs: { verified: 'false' } },
      preflight: { result: 'success' }, 'change-surface': { outputs: { surface: 'full-matrix' } },
      'classify-pr': { outputs: { bump_pr: 'false' } } },
    steps: { 'resolve-dispatch': { outputs: { valid: '' } } }, inputs: {}, cancelled: () => false };
}
function evaluate(raw, ctx) {
  if (raw === undefined) return true;
  return runInNewContext(raw.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']"), ctx);
}
test('queue suites always execute, and PR suites select with the same eight-shard fallback', () => {
  const { jobs } = ci();
  assert.equal(jobs['pr-test-proof'], undefined);
  assert.equal(jobs['pr-test-attestation'], undefined);
  for (const [id, full, selected] of [['vitest', 'record', 'collect_pr'], ['cockpit-browser', 'e2e', 'e2e-pr']]) {
    const job = jobs[id], step = name => job.steps.find(s => s.id === name);
    assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.doesNotMatch(JSON.stringify(job), /pr-test-proof|Reuse verified/);
    for (const event of ['merge_group', 'pull_request_target', 'push', 'workflow_dispatch']) {
      const ctx = context(event);
      assert.equal(evaluate(job.if, ctx), true);
      assert.equal(evaluate(step(selected).if, ctx), event === 'pull_request_target');
      assert.equal(evaluate(step(full).if, ctx), id === 'vitest' ? event === 'merge_group' : event !== 'pull_request_target');
    }
    assert.match(step(selected).run, /--ci .*--shard=\$\{\{ matrix.shard \}\}\/8/);
    assert.equal(step(selected)['continue-on-error'], undefined, 'selected failures block the job');
  }
  const vitest = jobs.vitest.steps.find(s => s.id === 'collect_pr');
  assert.equal(vitest.env.PR_BASE, '${{ github.event.pull_request.base.sha }}');
  assert.match(vitest.run, /--base="\$PR_BASE".*--coverage.enabled/);
  const browser = jobs['cockpit-browser'].steps.find(s => s.id === 'e2e-pr');
  assert.match(browser.run, /set -o pipefail/);
  assert.match(browser.run, /require-e2e-passed.cjs < e2e.log/);
});
test('native PR suites keep immutable input resolution and block on a failed resolver', () => {
  const { jobs } = ci();
  const input = jobs['pr-test-input'];
  assert.equal(input.steps[0].with.ref, '${{ github.workflow_sha }}');
  assert.equal(input.steps[0].with['persist-credentials'], false);
  assert.deepEqual(input.permissions, { contents: 'read', 'pull-requests': 'read' });
  for (const event of ['pull_request_target', 'merge_group', 'push', 'workflow_dispatch']) {
    assert.equal(evaluate(input.if, context(event)), event === 'pull_request_target');
  }
  for (const id of ['vitest', 'cockpit-browser']) {
    const ctx = context('pull_request_target');
    const checkout = jobs[id].steps.find(s => s.uses?.startsWith('actions/checkout@'));
    assert.equal(evaluate(checkout.with.ref, ctx), 'immutable-sha');
    assert.equal(checkout.with['persist-credentials'], false);
    ctx.needs['pr-test-input'].result = 'failure';
    assert.equal(evaluate(jobs[id].if, ctx), false);
    assert.ok(Object.values(jobs[id].permissions).every(value => value === 'read'));
  }
});
