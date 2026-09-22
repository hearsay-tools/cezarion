const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureReleaseCi } = require('./release-ci.cjs');

function fixture() {
  const sha = 'a'.repeat(40);
  const repo = { owner: 'example', repo: 'project' };
  const pr = { number: 42, state: 'open', merged_at: null,
    head: { sha, ref: 'release/v1.2.3', repo: { full_name: 'example/project' } },
    base: { repo: { full_name: 'example/project' } } };
  const run = { id: 123, head_sha: sha, head_branch: 'release/v1.2.3', event: 'workflow_dispatch',
    status: 'queued', html_url: 'https://github.com/example/project/actions/runs/123' };
  const state = { pr, runs: [], jobs: [], dispatches: [], waits: [], refSha: sha, visible: true };
  const github = {
    paginate: async (method, args) => (await method(args)).data,
    rest: {
      pulls: { get: async () => ({ data: state.pr }) },
      git: { getRef: async () => ({ data: { object: { sha: state.refSha } } }) },
      actions: {
        listWorkflowRuns: async (args) => {
          assert.deepEqual(args, { ...repo, workflow_id: 'ci.yml', branch: 'release/v1.2.3', head_sha: sha, per_page: 100 });
          if (state.listError) throw state.listError;
          return { data: state.runs };
        },
        listJobsForWorkflowRun: async () => ({ data: state.jobs }),
        createWorkflowDispatch: async (args) => {
          if (state.dispatchError) throw state.dispatchError;
          state.dispatches.push(args);
          if (state.moveDuringDispatch) state.pr.head.sha = 'b'.repeat(40);
          if (state.visible) state.runs.push(run);
          return { status: 204 };
        },
      },
    },
  };
  return { state, run, execute: (options = {}) => ensureReleaseCi({ ...options, github, repo, prNumber: 42, expectedSha: sha,
    sleep: async (ms) => { state.waits.push(ms); if (state.waits.length === state.appearAfter) state.runs.push(run); },
  }) };
}

test('dispatch identifies an actual CI run on the expected SHA, without a checkout override input', async () => {
  const f = fixture();
  const result = await f.execute();
  assert.equal(result.status, 'dispatched');
  assert.equal(result.sha, 'a'.repeat(40));
  assert.equal(result.url, 'https://github.com/example/project/actions/runs/123');
  assert.deepEqual(f.state.dispatches, [{ owner: 'example', repo: 'project', workflow_id: 'ci.yml', ref: 'release/v1.2.3', inputs: { pr_number: '42' } }]);
});

test('unrelated revisions, branches, and events cannot substitute for release verification', async () => {
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'push' }]) {
    const f = fixture();
    f.state.runs = [{ ...f.run, ...change, id: 9 }];
    assert.equal((await f.execute()).status, 'dispatched');
    assert.equal(f.state.dispatches.length, 1);
  }
});

test('every active CI state is reused and failed or cancelled runs are recovered', async () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const f = fixture();
    f.state.runs = [{ ...f.run, status }];
    assert.equal((await f.execute()).status, 'active');
    assert.equal(f.state.dispatches.length, 0);
  }
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required']) {
    const f = fixture();
    f.state.runs = [{ ...f.run, id: 9, status: 'completed', conclusion }];
    assert.equal((await f.execute()).status, 'dispatched');
  }
});

test('successful workflow only counts when its required aggregate actually passed', async () => {
  for (const conclusion of ['success', 'skipped', 'failure', undefined]) {
    const f = fixture();
    f.state.runs = [{ ...f.run, id: 9, status: 'completed', conclusion: 'success' }];
    f.state.jobs = [{ name: 'Unit, build, E2E, and package', conclusion }];
    assert.equal((await f.execute()).status, conclusion === 'success' ? 'verified-only' : 'dispatched');
  }
});

test('an older success cannot hide the latest failed verification for the same commit', async () => {
  const f = fixture();
  f.state.runs = [
    { ...f.run, id: 10, status: 'completed', conclusion: 'failure' },
    { ...f.run, id: 9, status: 'completed', conclusion: 'success' },
  ];
  f.state.jobs = [{ name: 'Unit, build, E2E, and package', conclusion: 'success' }];
  assert.equal((await f.execute()).status, 'dispatched');
});

test('closed PRs, foreign repositories, mismatched heads and moved branch refs cannot dispatch', async () => {
  for (const mutate of [
    (s) => { s.pr.state = 'closed'; },
    (s) => { s.pr.head.repo.full_name = 'other/project'; },
    (s) => { s.pr.base.repo.full_name = 'other/project'; },
    (s) => { s.pr.head.sha = 'b'.repeat(40); },
    (s) => { s.pr.head.ref = 'main'; },
    (s) => { s.refSha = 'b'.repeat(40); },
  ]) {
    const f = fixture();
    mutate(f.state);
    await assert.rejects(f.execute, /CI trigger failed.*Recovery:/);
    assert.equal(f.state.dispatches.length, 0);
  }
});

test('merged PRs do not start CI or restore a deleted branch', async () => {
  const f = fixture();
  f.state.pr.merged_at = '2026-09-17T00:00:00Z';
  f.state.pr.state = 'closed';
  assert.equal((await f.execute()).status, 'not-needed');
  assert.equal(f.state.dispatches.length, 0);
});

test('lookup and dispatch failures preserve HTTP causes and an exact recovery command', async () => {
  for (const field of ['listError', 'dispatchError']) {
    const f = fixture();
    f.state[field] = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
    await assert.rejects(f.execute, (error) => {
      assert.match(error.message, /HTTP 403.*Resource not accessible by integration/);
      assert.match(error.message, /actions: write/);
      assert.match(error.message, /node .github\/scripts\/release-ci.cjs example\/project 42 a{40}$/);
      return true;
    });
    assert.equal(f.state.dispatches.length, 0);
  }
});

test('delayed run visibility is polled without dispatching again', async () => {
  const f = fixture();
  f.state.visible = false;
  f.state.appearAfter = 2;
  assert.equal((await f.execute()).status, 'dispatched');
  assert.deepEqual(f.state.waits, [5000, 5000]);
  assert.equal(f.state.dispatches.length, 1);
});

test('accepted dispatch without a matching run has a bounded, actionable failure', async () => {
  const f = fixture();
  f.state.visible = false;
  await assert.rejects(f.execute, /Dispatch accepted, but no CI run appeared.*55 seconds.*Recovery:/);
  assert.equal(f.state.waits.length, 11);
  assert.equal(f.state.dispatches.length, 1);
});

test('moving the PR during dispatch cannot be reported as expected-commit verification', async () => {
  const f = fixture();
  f.state.moveDuringDispatch = true;
  await assert.rejects(f.execute, /PR moved during dispatch/);
});

test('CLI reports gh HTTP errors without mistaking its process exit code for an HTTP status', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ci-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "gh: Resource not accessible by integration (HTTP 403)" >&2\nexit 1\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'release-ci.cjs'), 'example/project', '42', 'a'.repeat(40)], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Resource not accessible by integration \(HTTP 403\)/);
  assert.doesNotMatch(result.stderr, /HTTP 1\)/);
  assert.match(result.stderr, /Recovery: node .github\/scripts\/release-ci.cjs example\/project 42 a{40}/);
});

test('recovery CLI sends pr_number through the gh dispatch adapter', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ci-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dispatchPath = path.join(dir, 'dispatch.json');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), endpoint = args[1];
const sha = 'a'.repeat(40);
let value;
if (endpoint.endsWith('/dispatches')) {
  fs.writeFileSync(process.env.DISPATCH_PATH, JSON.stringify(args)); process.exit(0);
} else if (endpoint.includes('/pulls/')) value = {state:'open',head:{sha,ref:'release/v1.2.3',repo:{full_name:'example/project'}},base:{repo:{full_name:'example/project'}}};
else if (endpoint.includes('/git/ref/')) value = {object:{sha}};
else if (endpoint.includes('/runs?')) value = [{workflow_runs:fs.existsSync(process.env.DISPATCH_PATH) ? [{id:1,head_sha:sha,head_branch:'release/v1.2.3',event:'workflow_dispatch',status:'queued',html_url:'https://example/run'}] : []}];
else throw new Error('Unexpected endpoint: '+endpoint);
console.log(JSON.stringify(value));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'release-ci.cjs'), 'example/project', '42', 'a'.repeat(40)], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, DISPATCH_PATH: dispatchPath }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'dispatched');
  assert.deepEqual(JSON.parse(fs.readFileSync(dispatchPath, 'utf8')), [
    'api', 'repos/example/project/actions/workflows/ci.yml/dispatches', '--method', 'POST',
    '-f', 'ref=release/v1.2.3', '-f', 'inputs[pr_number]=42',
  ]);
});


test('native release CI ignores dispatch success and waits for the eligible PR event', async () => {
  const f = fixture();
  f.state.runs = [{ ...f.run, id: 99, status: 'completed', conclusion: 'success' }];
  f.state.jobs = [{ name: 'Unit, build, E2E, and package', conclusion: 'success' }];
  f.run.event = 'pull_request_target';
  f.state.appearAfter = 2;
  const result = await f.execute({ native: true });
  assert.equal(result.status, 'active');
  assert.equal(result.mergeEligible, true);
  assert.equal(f.state.dispatches.length, 0);
  assert.equal(f.state.waits.length, 2);
});

test('native CI never cancels real checks by dispatching, including failure and timeout', async () => {
  for (const runs of [[], [{ status: 'completed', conclusion: 'failure' }]]) {
    const f = fixture();
    f.state.runs = runs.map(r => ({ ...f.run, ...r, event: 'pull_request_target' }));
    await assert.rejects(() => f.execute({ native: true }), /native|Native/);
    assert.equal(f.state.dispatches.length, 0);
    assert.ok(f.state.waits.length <= 11);
  }
});

test('legacy dispatch success is verification-only, never merge-eligible', async () => {
  const f = fixture();
  f.state.runs = [{ ...f.run, status: 'completed', conclusion: 'success' }];
  f.state.jobs = [{ name: 'Unit, build, E2E, and package', conclusion: 'success' }];
  const result = await f.execute();
  assert.equal(result.status, 'verified-only');
  assert.equal(result.mergeEligible, false);
});


test('native aggregate success is eligible and newer failed runs cannot reuse old success', async () => {
  const f = fixture();
  f.state.runs = [{ ...f.run, event: 'pull_request_target', status: 'completed', conclusion: 'success' }];
  f.state.jobs = [{ name: 'Unit, build, E2E, and package', conclusion: 'success' }];
  assert.equal((await f.execute({ native: true })).status, 'passed');
  f.state.runs.unshift({ ...f.run, id: 124, event: 'pull_request_target', status: 'completed', conclusion: 'failure' });
  await assert.rejects(() => f.execute({ native: true }), /Native CI did not pass/);
  assert.equal(f.state.dispatches.length, 0);
});
