'use strict';

// Guards the rerun of a failed merge-queue shard (docs/sdlc/ci.md § Rerun of a failed queue
// shard; hearsay-tools/cezarion#3290): in a merge group only, a Vitest or browser shard whose
// first test step fails runs the whole shard once more in the same job, in the same order, and
// passes only when the rerun passes. The rerun records its own Squeal parts, and the shard
// uploads the first run's failed files for the flake reporter (hearsay-tools/cezarion#3291).
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const repoRoot = path.join(__dirname, '..', '..');
const ci = () => yaml.parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
const EVENTS = ['pull_request_target', 'workflow_dispatch', 'merge_group', 'push'];
const OUTCOMES = ['success', 'failure', 'skipped', 'cancelled'];
const LIST = '"$RUNNER_TEMP/failed-test-files.txt"';

// [job, first test step, rerun step, Vitest root the reset reads, artifact name]
const SHARDS = [
  ['vitest', 'record', 'rerun', '.', 'failed-test-files-vitest-shard-${{ matrix.shard }}'],
  ['cockpit-browser', 'e2e', 'e2e-rerun', 'packages/web/e2e', 'failed-test-files-cockpit-browser-shard-${{ matrix.shard }}'],
];
const step = (job, id) => job.steps.find((s) => s.id === id || s.name === id);
const index = (job, id) => job.steps.indexOf(step(job, id));

function expression(raw, context) {
  const code = String(raw).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']");
  return runInNewContext(code.replace(/steps\.([\w]+-[\w-]+)/g, "steps['$1']"), context);
}

function context(event, first, rerun = 'skipped') {
  return {
    github: { event_name: event },
    inputs: { pr_number: '', squeal_gate_trial: false },
    needs: { 'pr-test-proof': { result: 'success', outputs: { verified: 'false' } } },
    steps: { squeal: { outcome: 'success' }, record: { outcome: first }, e2e: { outcome: first }, rerun: { outcome: rerun }, 'e2e-rerun': { outcome: rerun } },
    runner: { temp: '/runner/temp' },
    matrix: { shard: 2 },
    cancelled: () => false,
  };
}

test('only a merge-group shard whose first test step failed resets, reruns and uploads its failed files', () => {
  for (const [id, first, rerun, , artifact] of SHARDS) {
    const job = ci().jobs[id];
    const upload = job.steps.find((s) => s.with?.name === artifact);
    const gated = [step(job, 'reset'), step(job, rerun), upload];
    for (const event of EVENTS) {
      for (const outcome of OUTCOMES) {
        const ctx = context(event, outcome);
        for (const s of gated) assert.equal(expression(s.if, ctx), event === 'merge_group' && outcome === 'failure', `${id} ${s.name}: ${event} ${outcome}`);
      }
      // A failed first step continues only where a rerun follows it; a PR, main push or dispatch fails on it.
      assert.equal(expression(step(job, first)['continue-on-error'], context(event, 'failure')), event === 'merge_group', `${id} ${event}`);
    }
    // The reset and the rerun carry no status function, so GitHub adds success(): a failed reset
    // skips the rerun and fails the shard. Nothing lets the rerun's failure through.
    for (const s of [step(job, 'reset'), step(job, rerun)]) {
      assert.doesNotMatch(s.if, /\b(always|failure|cancelled|success)\(/, `${id} ${s.name}`);
      assert.equal(s['continue-on-error'], undefined, `${id} ${s.name}`);
    }
    assert.match(upload.if, /^!cancelled\(\) && /, `${id}: the list uploads after a failed reset too`);
    assert.equal(upload['continue-on-error'], true, `${id}: the list never decides the verdict`);
  }
});

test('the rerun runs the whole shard again, after the reset and the upload of the first run\'s list', () => {
  for (const [id, first, rerun, root] of SHARDS) {
    const job = ci().jobs[id];
    assert.equal(step(job, rerun).run, step(job, first).run, `${id}: the same command, the whole shard`);
    assert.equal(step(job, 'reset').run, `node .github/scripts/vitest-rerun-reset.cjs ${root} ${LIST}`, id);
    assert.ok(index(job, first) < index(job, 'reset') && index(job, 'reset') < index(job, rerun), `${id}: first run, reset, rerun`);
    const upload = job.steps.find((s) => s.with?.name?.startsWith('failed-test-files-'));
    assert.equal(upload.with.path, '${{ runner.temp }}/failed-test-files.txt', id);
    // A rerun that reaches the job's time limit cancels every later step.
    assert.ok(index(job, 'reset') < job.steps.indexOf(upload) && job.steps.indexOf(upload) < index(job, rerun), `${id}: reset, list upload, rerun`);
  }
});

test('the Vitest rerun records into a new parts directory, and only its parts upload', () => {
  const vitest = ci().jobs.vitest;
  const record = step(vitest, 'record');
  const rerun = step(vitest, 'rerun');
  assert.equal(record.env.PARTS_DIR, 'squeal-parts');
  assert.equal(rerun.env.PARTS_DIR, 'squeal-parts-rerun');
  assert.deepEqual({ ...rerun.env, PARTS_DIR: record.env.PARTS_DIR }, record.env, 'the same environment apart from the parts directory');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-queue-rerun-'));
  try {
    fs.writeFileSync(path.join(temp, 'node'), '#!/bin/sh\necho "node $*"\n', { mode: 0o755 });
    const script = rerun.run.replaceAll('${{ matrix.shard }}', '2');
    const result = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8', env: { PATH: `${temp}:/usr/bin:/bin`, RUNNER_TEMP: '/runner/temp', SQUEAL_FETCHED: 'success', PARTS_DIR: rerun.env.PARTS_DIR },
    });
    assert.equal(result.stdout.trim(), 'node /runner/temp/squeal/plugins/claude-code/dist/cli/squeal.mjs ci record --out /runner/temp/squeal-parts-rerun -- npm test -- --shard=2/4 --maxWorkers=4');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const upload = step(vitest, 'Upload Squeal parts');
  const uploaded = (outcome) => upload.with.path.replace(/\$\{\{.*?\}\}/g, (raw) => expression(raw, context('merge_group', 'failure', outcome)));
  assert.equal(uploaded('skipped'), '/runner/temp/squeal-parts/');
  assert.equal(uploaded('success'), '/runner/temp/squeal-parts-rerun/');
  assert.equal(uploaded('failure'), '/runner/temp/squeal-parts-rerun/');
  assert.ok(index(vitest, 'rerun') < vitest.steps.indexOf(upload));
});

test('a merge group gives each shard room for two runs inside the queue\'s check timeout', () => {
  const admission = fs.readFileSync(path.join(__dirname, 'merge-queue-admission.cjs'), 'utf8');
  const queueTimeout = Number(admission.match(/check_response_timeout_minutes !== (\d+)/)[1]);
  const { jobs } = ci();
  const minutes = (id, event) => expression(jobs[id]['timeout-minutes'], context(event, 'success'));
  for (const id of ['vitest', 'cockpit-browser']) {
    assert.equal(minutes(id, 'merge_group'), 40, id);
    assert.ok(minutes(id, 'merge_group') < queueTimeout, `${id} ends before the queue drops the entry`);
  }
  assert.deepEqual(['pull_request_target', 'workflow_dispatch', 'push'].map((event) => minutes('vitest', event)), [25, 25, 20]);
  assert.deepEqual(['pull_request_target', 'workflow_dispatch', 'push'].map((event) => minutes('cockpit-browser', event)), [30, 30, 30]);
});

test('a browser shard ships the first run\'s failure bundles before the rerun clears them', () => {
  const job = ci().jobs['cockpit-browser'];
  const first = step(job, 'Upload the first run\'s failure bundles');
  const after = step(job, 'Upload failure bundles');
  for (const event of EVENTS) {
    for (const outcome of OUTCOMES) {
      assert.equal(expression(first.if, context(event, outcome)), event === 'merge_group' && outcome === 'failure', `${event} ${outcome}`);
    }
  }
  assert.ok(index(job, 'e2e') < job.steps.indexOf(first) && job.steps.indexOf(first) < index(job, 'reset'));
  assert.equal(first['continue-on-error'], true);
  assert.equal(first.with.name, 'cockpit-failures-first-run-shard-${{ matrix.shard }}');
  assert.deepEqual({ ...first.with, name: after.with.name }, after.with, 'the same bundles, under their own name');
});
