'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const jobs = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8')).jobs;

test('each LXC route requires its own opt-in and trusted admission output', () => {
  for (const [job, flag, hosted] of [
    ['vitest', 'CEZARION_LXC_VITEST', 'ubuntu-24.04'],
    ['cockpit-browser', 'CEZARION_LXC_BROWSER', 'ubuntu-latest'],
  ]) {
    const code = jobs[job]['runs-on'].slice(3, -2).replace(/needs\.([\w-]+)/g, "needs['$1']");
    for (const enabled of ['', 'false', 'yes', 'true']) for (const admitted of ['', 'false', 'true']) {
      const vars = { CEZARION_LXC_VITEST: 'true', CEZARION_LXC_BROWSER: 'true', [flag]: enabled };
      const actual = runInNewContext(code, { vars, needs: { 'pr-test-input': { outputs: { lxc: admitted } } }, fromJSON: JSON.parse });
      const expected = enabled === 'true' && admitted === 'true'
        ? { group: 'cezarion-lxc', labels: 'cezarion-lxc' } : hosted;
      assert.deepEqual(actual, expected, `${job}/${enabled}/${admitted}`);
    }
    assert.ok(jobs[job].needs.includes('pr-test-input'));
  }
});

test('hosted input resolution wires live LXC admission after immutable SHA proof', async () => {
  const job = jobs['pr-test-input'];
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job.outputs.lxc, '${{ steps.input.outputs.lxc }}');
  const step = job.steps.find(s => s.id === 'input');
  assert.equal(step.env.WORKFLOW_REF, '${{ github.workflow_ref }}');
  assert.equal(step.env.REF_PROTECTED, '${{ github.ref_protected }}');
  const calls = [], outputs = {};
  const head = 'a'.repeat(40), merge = 'b'.repeat(40);
  const context = { eventName: 'pull_request_target', ref: 'refs/heads/main',
    repo: { owner: 'hearsay-tools', repo: 'cezarion' },
    payload: { repository: { id: 1352758052 }, pull_request: { number: 27,
      head: { sha: head, repo: { full_name: 'hearsay-tools/cezarion' } } } } };
  const modules = {
    './.github/scripts/pr-test-input.cjs': { resolvePrTestInput: async () => {
      calls.push('immutable'); return { sha: merge, reusable: false };
    } },
    './.github/scripts/lxc-runner-eligibility.cjs': { lxcRunnerEligible: async input => {
      calls.push('admission');
      assert.equal(input.head, head); assert.equal(input.pullNumber, 27);
      assert.equal(input.repositoryId, 1352758052); assert.equal(input.refProtected, true);
      assert.equal(input.eventName, context.eventName); assert.equal(input.ref, context.ref);
      assert.equal(input.workflowRef, 'hearsay-tools/cezarion/.github/workflows/ci.yml@refs/heads/main');
      return true;
    } },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('require', 'github', 'context', 'core', 'process', step.with.script);
  await run(name => modules[name], {}, context, { setOutput: (key, value) => { outputs[key] = value; } },
    { env: { WORKFLOW_SHA: 'c'.repeat(40), WORKFLOW_REF: 'hearsay-tools/cezarion/.github/workflows/ci.yml@refs/heads/main', REF_PROTECTED: 'true' } });
  assert.deepEqual(calls, ['immutable', 'admission']);
  assert.deepEqual(outputs, { sha: merge, reusable: 'false', lxc: 'true' });
});
