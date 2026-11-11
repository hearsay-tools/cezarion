'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lxcRunnerEligible } = require('./lxc-runner-eligibility.cjs');
const SHA = 'a'.repeat(40);

function fixture() {
  const pull = { number: 27, state: 'open', user: { id: 1118683 },
    base: { ref: 'main', repo: { id: 1352758052 } },
    head: { sha: SHA, repo: { id: 1352758052 } } };
  const calls = [];
  const options = { eventName: 'pull_request_target', ref: 'refs/heads/main',
    workflowRef: 'hearsay-tools/cezarion/.github/workflows/ci.yml@refs/heads/main',
    refProtected: true, repositoryId: 1352758052, pullNumber: 27, head: SHA,
    owner: 'hearsay-tools', repo: 'cezarion', github: { request: async (route, args) => {
      calls.push({ route, args });
      return { data: structuredClone(pull) };
    } } };
  return { pull, calls, options, run: () => lxcRunnerEligible(options) };
}

test('admits only the live owner-authored same-repository PR at the expected head', async () => {
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].route, 'GET /repos/{owner}/{repo}/pulls/{pull_number}');
  assert.equal(f.calls[0].args.pull_number, 27);
  assert.equal(f.calls[0].args.request.retries, 0);
  assert.ok(f.calls[0].args.request.timeout <= 10000);
});

for (const [name, change] of Object.entries({
  'fork event': f => { f.options.eventName = 'pull_request'; },
  'manual dispatch': f => { f.options.eventName = 'workflow_dispatch'; },
  'merge queue': f => { f.options.eventName = 'merge_group'; },
  'main push': f => { f.options.eventName = 'push'; },
  'off-main workflow': f => { f.options.workflowRef = f.options.workflowRef.replace('heads/main', 'heads/topic'); },
  'different workflow': f => { f.options.workflowRef = f.options.workflowRef.replace('ci.yml', 'other.yml'); },
  'different ref': f => { f.options.ref = 'refs/heads/topic'; },
  'unprotected main': f => { f.options.refProtected = false; },
  'different repository ID': f => { f.options.repositoryId++; },
  'different repository name': f => { f.options.repo = 'other'; },
  'different organization': f => { f.options.owner = 'other'; },
  'invalid PR number': f => { f.options.pullNumber = '27'; },
  'invalid SHA': f => { f.options.head = 'abc'; },
})) test(`keeps hosted routing without an API call: ${name}`, async () => {
  const f = fixture(); change(f);
  assert.equal(await f.run(), false);
  assert.equal(f.calls.length, 0);
});

for (const [name, change] of Object.entries({
  'other author': f => { f.pull.user.id++; },
  'owner-authored fork': f => { f.pull.head.repo.id++; },
  'deleted fork': f => { f.pull.head.repo = null; },
  'different base repository': f => { f.pull.base.repo.id++; },
  'different base branch': f => { f.pull.base.ref = 'release'; },
  'changed head': f => { f.pull.head.sha = 'b'.repeat(40); },
  'closed PR': f => { f.pull.state = 'closed'; },
  'wrong PR': f => { f.pull.number++; },
  'missing author': f => { f.pull.user = null; },
})) test(`keeps hosted routing for the live PR: ${name}`, async () => {
  const f = fixture(); change(f);
  assert.equal(await f.run(), false);
  assert.equal(f.calls.length, 1);
});

test('an unavailable live read keeps hosted routing', async () => {
  const f = fixture();
  f.options.github.request = async () => { throw new Error('unavailable'); };
  assert.equal(await f.run(), false);
});
