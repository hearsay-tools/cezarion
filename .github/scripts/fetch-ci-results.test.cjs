const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, resolveCiResults, renderCiResults, collectCiResults, writeCiResults } = require('./fetch-ci-results.cjs');

const VERIFY = 'Unit, build, E2E, and package';
const run = (overrides = {}) => ({ databaseId: 42, status: 'in_progress', conclusion: '', url: 'https://github.com/o/n/actions/runs/42', event: 'pull_request', headSha: 'abc', ...overrides });
const job = (overrides = {}) => ({ databaseId: 101, name: VERIFY, status: 'completed', conclusion: 'success', startedAt: '2026-09-08T10:00:00Z', completedAt: '2026-09-08T10:01:00Z', url: 'https://github.com/o/n/actions/runs/42/job/101', steps: [], ...overrides });
const required = h => collectCiResults({ ...h.options, requireSuccess: true });
const publish = (overrides = {}) => job({ databaseId: 102, name: 'Publish npm snapshot', status: 'in_progress', conclusion: '', completedAt: '0001-01-01T00:00:00Z', ...overrides });

// Only the network and clock are replaced: real selection, retries and rendering run.
function harness(snapshots) {
  let t = 0;
  let snapshot;
  const calls = [];
  let lists = 0;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'run' && args[1] === 'list') {
      assert.equal(args[args.indexOf('--workflow') + 1], 'ci.yml');
      assert.equal(args[args.indexOf('--commit') + 1], 'abc');
      snapshot = snapshots[Math.min(lists++, snapshots.length - 1)];
      if (snapshot.listError) throw snapshot.listError;
      return JSON.stringify(snapshot.runs ?? [run()]);
    }
    if (args[0] === 'run' && args[1] === 'view' && args.includes('jobs')) {
      if (snapshot.jobsError) throw snapshot.jobsError;
      const jobs = snapshot.jobsById?.[args[2]] ?? snapshot.jobs;
      assert.ok(jobs, `jobs must be defined for run ${args[2]}`);
      snapshot.jobs = jobs;
      return JSON.stringify({ jobs });
    }
    if (args[0] === 'api') {
      const id = Number(args[1].match(/\/jobs\/(\d+)\/logs$/)?.[1]);
      const target = snapshot.jobs.find(j => j.databaseId === id);
      assert.ok(target, 'logs must identify a job in the selected run');
      assert.equal(target.status, 'completed', 'never fetch logs from unfinished publishing');
      assert.notEqual(target.name, 'Publish npm snapshot');
      if (snapshot.logError) throw snapshot.logError;
      return `AssertionError from ${target.name}\n`;
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls, elapsed: () => t, options: { gh, repo: 'o/n', headSha: 'abc', sleep: ms => { t += ms; } } };
}

// The review runs inside the same ci.yml run, after verify: the run itself is still in
// progress, with publishing and the review's own jobs unfinished.
test('verification completion releases review while the run, publishing and review are still running', () => {
  const reviewJob = job({ databaseId: 103, name: 'Review / codex-review', status: 'in_progress', conclusion: '' });
  const h = harness([{ jobs: [job(), publish(), reviewJob] }]);
  const context = required(h);
  assert.equal(h.elapsed(), 0);
  assert.ok(!h.calls.some(args => args[1] === 'watch'));
  assert.equal(context.status, 'completed');
  assert.equal(context.conclusion, 'success');
  const text = renderCiResults(context);
  assert.match(text, /verification/i);
  assert.match(text, /publishing.*not included/i);
});

test('trusted pull request target CI runs can provide review verification', () => {
  const h = harness([{ runs: [run({ event: 'pull_request_target' })], jobs: [job(), publish()] }]);
  assert.equal(required(h).conclusion, 'success');
});

test('review context prefers a live target run over a cancelled pull_request run', () => {
  const cancelled = run({ databaseId: 41, event: 'pull_request', status: 'completed', conclusion: 'cancelled' });
  const target = run({ databaseId: 42, event: 'pull_request_target', status: 'in_progress', conclusion: '' });
  const h = harness([{
    runs: [cancelled, target],
    jobsById: {
      41: [job({ conclusion: 'cancelled' }), publish({ status: 'completed', conclusion: 'cancelled' })],
      42: [job(), publish()],
    },
  }]);
  assert.equal(required(h).conclusion, 'success');
});

for (const state of ['queued', 'in_progress', 'completed']) {
  test(`unfinished verification blocks review when publishing is ${state}`, () => {
    const h = harness([
      { jobs: [job({ status: 'in_progress', conclusion: '' }), publish({ status: state, conclusion: state === 'completed' ? 'success' : '' })] },
    ]);
    assert.throws(() => required(h), /verification.*did not succeed.*pending/i);
    assert.equal(h.elapsed(), 0, 'nothing waits: the caller starts review only after verify');
  });
}

test('failed verification blocks review but standalone context retains failed shard details and logs', () => {
  const h = harness([{ jobs: [job({ conclusion: 'failure' }), job({ databaseId: 103, name: 'Vitest shard 1/2', conclusion: 'failure' }), publish()] }]);
  assert.throws(() => required(h), /verification.*failure/i);
  const result = collectCiResults(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.conclusion, 'failure');
  assert.deepEqual(result.failedJobs, [{ name: VERIFY, conclusion: 'failure' }, { name: 'Vitest shard 1/2', conclusion: 'failure' }]);
  assert.match(result.failedLog, /AssertionError from Vitest shard 1\/2/);
  assert.match(renderCiResults(result), /^conclusion: failure$/m);
  assert.ok(!h.calls.some(args => args.includes('--log-failed')));
});

for (const name of ['Typecheck', 'Unit, build, and package', 'Typecheck, unit, build, and package']) {
  test(`review diagnostics retain failed ${name} logs`, () => {
    const h = harness([{ jobs: [job({ conclusion: 'failure' }), job({ databaseId: 103, name, conclusion: 'failure' })] }]);
    const result = collectCiResults(h.options);
    assert.equal(result.failedJobs.some(job => job.name === name), true);
    assert.ok(result.failedLog.includes(`AssertionError from ${name}`));
  });
}

for (const conclusion of ['failure', 'timed_out', 'cancelled', 'skipped', 'neutral', 'action_required', null, '']) {
  test(`completed verification ${conclusion} blocks model work`, () => {
    const h = harness([{ jobs: [job({ conclusion }), publish()] }]);
    assert.throws(() => required(h), /verification.*(did not succeed|failure|timed_out|cancelled|skipped|neutral|action_required|pending)/i);
    assert.equal(collectCiResults(h.options).conclusion, conclusion || null);
  });
}

test('publishing failure does not change successful verification or fetch publication logs', () => {
  const h = harness([{ runs: [run({ status: 'completed', conclusion: 'failure' })], jobs: [job(), publish({ status: 'completed', conclusion: 'failure' })] }]);
  const result = collectCiResults(h.options);
  assert.equal(result.conclusion, 'success');
  assert.deepEqual(result.failedJobs, []);
  assert.equal(result.failedLog, '');
});

test('wrong head SHA and push runs cannot release review or populate context', () => {
  const wrong = [run({ headSha: 'oldsha' }), run({ event: 'push' })];
  const pending = harness([{ runs: wrong, jobs: [job()] }]);
  assert.equal(collectCiResults(pending.options).status, 'pending');
  assert.throws(() => required(harness([{ runs: wrong, jobs: [job()] }])), /did not succeed/);
});

for (const missing of ['run', 'job', 'completion']) {
  test(`missing verification ${missing} is pending and blocks review`, () => {
    const h = harness([{ runs: missing === 'run' ? [] : [run()], jobs: missing === 'job' ? [publish()] : [job(missing === 'completion' ? { status: 'queued', conclusion: '' } : {})] }]);
    assert.equal(collectCiResults(h.options).status, 'pending');
    assert.throws(() => required(h), /did not succeed/);
  });
}

test('ambiguous verification jobs fail closed in both required and standalone collection', () => {
  const h = harness([{ jobs: [job(), job({ databaseId: 999 })] }]);
  assert.throws(() => required(h), /ambiguous/i);
  assert.throws(() => collectCiResults(h.options), /ambiguous/i);
});

for (const field of ['listError', 'jobsError']) {
  test(`${field} fails closed instead of approving verification`, () => {
    const h = harness([{ jobs: [job()], [field]: new Error('API unavailable') }]);
    assert.throws(() => required(h), /API unavailable/);
    assert.throws(() => collectCiResults(h.options), /API unavailable/);
  });
}

test('unavailable failed-job logs remain explicit while preserving the failed conclusion', () => {
  const h = harness([{ jobs: [job({ conclusion: 'failure' })], logError: new Error('logs not ready') }]);
  const result = collectCiResults(h.options);
  assert.equal(result.conclusion, 'failure');
  assert.match(result.failedLog, /unavailable/i);
});

test('resolveCiResults keeps missing verification pending even on a successful completed workflow', () => {
  assert.equal(resolveCiResults([run({ status: 'completed', conclusion: 'success' })], { jobs: [] }).status, 'pending');
  assert.equal(resolveCiResults([], { jobs: [job()] }).status, 'pending');
});

test('renderCiResults reports pending verification and safely formats failure logs', () => {
  const pending = renderCiResults(resolveCiResults([]));
  assert.match(pending, /^status: pending$/m);
  assert.match(pending, /has not finished/i);
  const failed = renderCiResults(resolveCiResults([run()], { jobs: [job({ conclusion: 'failure' })], failedLog: 'bad ``` log' }));
  assert.match(failed, /^## Failed jobs/m);
  assert.match(failed, /bad ''' log/);
});

test('writeCiResults writes the context file when verification is pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-results-'));
  try {
    const out = path.join(dir, 'nested/ci-results.md');
    writeCiResults({ out, result: resolveCiResults([]) });
    assert.match(fs.readFileSync(out, 'utf8'), /^status: pending$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseArgs requires --out; the --wait polling mode is gone', () => {
  assert.throws(() => parseArgs(['--repo', 'o/n', '--head-sha', 'abc']), /Usage: fetch-ci-results\.cjs/);
  assert.throws(() => parseArgs(['--repo', 'o/n', '--head-sha', 'abc', '--wait']), /Usage: fetch-ci-results\.cjs/);
});


test('required-success context fetch rejects a same-SHA rerun that is no longer green', () => {
  for (const next of [[], [job({ status: 'queued', conclusion: '' })], [job({ conclusion: 'failure' })]]) {
    const h = harness([{ jobs: next }]);
    assert.throws(() => required(h), /verification.*did not succeed/i);
  }
  const missing = harness([{ runs: [], jobs: [] }]);
  assert.throws(() => collectCiResults({ ...missing.options, requireSuccess: true }), /verification.*did not succeed/i);
  const green = harness([{ jobs: [job(), publish()] }]);
  assert.equal(collectCiResults({ ...green.options, requireSuccess: true }).conclusion, 'success');
});

test('parseArgs supports required-success context collection', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/n', '--head-sha', 'abc', '--out', 'ci.md', '--require-success']), {
    repo: 'o/n', headSha: 'abc', out: 'ci.md', requireSuccess: true,
  });
});

 test('newest target run is authoritative even when cancelled or older legacy CI succeeded', () => {
  const old = run({ databaseId: 41, event: 'pull_request_target', conclusion: 'success' });
  const latest = run({ databaseId: 44, event: 'pull_request_target', conclusion: 'cancelled' });
  const legacy = run({ databaseId: 45, conclusion: 'success' });
  const h = harness([{ runs: [legacy, old, latest], jobsById: {
    41: [job()], 45: [job()], 44: [job({ conclusion: 'cancelled' })],
  } }]);
  assert.throws(() => required(h), /cancelled/);
});

// hearsay-tools/cezarion#1020: one 502 from the jobs endpoint failed the CI lookup with every job green.
const JOBS_URL = 'https://api.github.com/repos/o/n/actions/runs/42/jobs?per_page=100';
function ghFailure(stderr) {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { status: 1, stderr });
}
const http502 = () => ghFailure(`HTTP 502: Server Error (${JOBS_URL})\n`);
const http404 = () => ghFailure(`HTTP 404: Not Found (${JOBS_URL})\n`);

// Fails the first `failures` calls matching `pick` with `error()`, then passes through.
function flaky(h, pick, failures, error) {
  let failed = 0;
  let attempts = 0;
  const gh = (args) => {
    if (pick(args)) {
      attempts += 1;
      if (failed < failures) { failed += 1; throw error(); }
    }
    return h.gh(args);
  };
  return { options: { ...h.options, gh }, attempts: () => attempts };
}
const isJobs = args => args[0] === 'run' && args[1] === 'view';
const isList = args => args[0] === 'run' && args[1] === 'list';

for (const [name, pick] of [['run jobs lookup', isJobs], ['run list lookup', isList]]) {
  test(`required collection retries a single transient 502 from the ${name}`, () => {
    const h = harness([{ jobs: [job(), publish()] }]);
    const f = flaky(h, pick, 1, http502);
    assert.equal(collectCiResults({ ...f.options, requireSuccess: true }).conclusion, 'success');
    assert.equal(f.attempts(), 2);
  });
}

test('collectCiResults retries a transient 502 from the jobs lookup', () => {
  const h = harness([{ jobs: [job(), publish()] }]);
  const f = flaky(h, isJobs, 1, http502);
  assert.equal(collectCiResults({ ...f.options, requireSuccess: true }).conclusion, 'success');
});

test('network resets and secondary rate limits are retried like 5xx', () => {
  for (const stderr of [
    'read tcp: connection reset by peer',
    'Post "https://api.github.com/graphql": dial tcp: i/o timeout',
    'Get "https://api.github.com/repos/o/r/actions/runs/42/jobs?per_page=100": dial tcp 140.82.112.6:443: connect: connection refused',
    'Get "https://api.github.com/graphql": dial tcp: lookup api.github.com on 127.0.0.53:53: no such host',
    'Get "https://api.github.com/graphql": dial tcp: lookup api.github.com: Temporary failure in name resolution',
    'Get "https://api.github.com/graphql": dial tcp 140.82.112.6:443: connect: network is unreachable',
    'Get "https://api.github.com/graphql": write tcp 10.1.0.4:51234->140.82.112.6:443: write: broken pipe',
    'HTTP 429: Too Many Requests',
    'HTTP 403: You have exceeded a secondary rate limit',
  ]) {
    const h = harness([{ jobs: [job()] }]);
    const f = flaky(h, isJobs, 1, () => ghFailure(stderr));
    assert.equal(collectCiResults({ ...f.options, requireSuccess: true }).conclusion, 'success', stderr);
  }
});

test('persistent 5xx fails after bounded attempts and names the failing URL', () => {
  const h = harness([{ jobs: [job()] }]);
  const f = flaky(h, isJobs, Infinity, http502);
  assert.throws(() => collectCiResults({ ...f.options, requireSuccess: true }), (error) => {
    assert.match(error.message, /failed after 4 attempts/);
    assert.ok(error.message.includes(JOBS_URL), error.message);
    assert.match(error.message, /gh run view 42/);
    return true;
  });
  assert.equal(f.attempts(), 4);
  assert.ok(h.elapsed() < 60_000, `backoff stays well under a minute, slept ${h.elapsed()}ms`);
});

test('a 404 is not retried', () => {
  const h = harness([{ jobs: [job()] }]);
  const f = flaky(h, isJobs, Infinity, http404);
  assert.throws(() => collectCiResults({ ...f.options, requireSuccess: true }), /HTTP 404/);
  assert.equal(f.attempts(), 1);
  assert.equal(h.elapsed(), 0);
});
