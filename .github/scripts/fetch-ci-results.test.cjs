const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, resolveCiResults, renderCiResults, collectCiResults, writeCiResults, waitForCiRun } = require('./fetch-ci-results.cjs');

const VERIFY = 'Unit, build, E2E, and package';
const run = (overrides = {}) => ({ databaseId: 42, status: 'in_progress', conclusion: '', url: 'https://github.com/o/n/actions/runs/42', event: 'pull_request', headSha: 'abc', ...overrides });
const job = (overrides = {}) => ({ databaseId: 101, name: VERIFY, status: 'completed', conclusion: 'success', startedAt: '2026-09-08T10:00:00Z', completedAt: '2026-09-08T10:01:00Z', url: 'https://github.com/o/n/actions/runs/42/job/101', steps: [], ...overrides });
const publish = (overrides = {}) => job({ databaseId: 102, name: 'Publish npm snapshot', status: 'in_progress', conclusion: '', completedAt: '0001-01-01T00:00:00Z', ...overrides });

// Only the network and clock are replaced: real polling, selection and rendering run.
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
      assert.equal(args[2], '42');
      if (snapshot.jobsError) throw snapshot.jobsError;
      return JSON.stringify({ jobs: snapshot.jobs });
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
  return { gh, calls, elapsed: () => t, options: { gh, repo: 'o/n', headSha: 'abc', now: () => t, sleep: ms => { t += ms; }, timeoutMs: 30, pollIntervalMs: 10 } };
}

test('verification completion releases review while publishing is still running', () => {
  const h = harness([{ jobs: [job(), publish()] }]);
  const result = waitForCiRun(h.options);
  assert.equal(result.databaseId, 42);
  assert.equal(h.elapsed(), 0);
  assert.ok(!h.calls.some(args => args[1] === 'watch'));
  const context = collectCiResults(h.options);
  assert.equal(context.status, 'completed');
  assert.equal(context.conclusion, 'success');
  const text = renderCiResults(context);
  assert.match(text, /verification/i);
  assert.match(text, /publishing.*not included/i);
});

for (const state of ['queued', 'in_progress', 'completed']) {
  test(`pending verification waits when publishing is ${state}`, () => {
    const h = harness([
      { jobs: [job({ status: 'in_progress', conclusion: '' }), publish({ status: state, conclusion: state === 'completed' ? 'success' : '' })] },
      { jobs: [job(), publish()] },
    ]);
    waitForCiRun(h.options);
    assert.equal(h.elapsed(), 10);
  });
}

test('failed verification blocks review but standalone context retains failed shard details and logs', () => {
  const h = harness([{ jobs: [job({ conclusion: 'failure' }), job({ databaseId: 103, name: 'Vitest shard 1/2', conclusion: 'failure' }), publish()] }]);
  assert.throws(() => waitForCiRun(h.options), /verification.*failure/i);
  const result = collectCiResults(h.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.conclusion, 'failure');
  assert.deepEqual(result.failedJobs, [{ name: VERIFY, conclusion: 'failure' }, { name: 'Vitest shard 1/2', conclusion: 'failure' }]);
  assert.match(result.failedLog, /AssertionError from Vitest shard 1\/2/);
  assert.match(renderCiResults(result), /^conclusion: failure$/m);
  assert.ok(!h.calls.some(args => args.includes('--log-failed')));
});

for (const conclusion of ['failure', 'timed_out', 'cancelled', 'skipped', 'neutral', 'action_required', null, '']) {
  test(`completed verification ${conclusion} blocks model work`, () => {
    const h = harness([{ jobs: [job({ conclusion }), publish()] }]);
    assert.throws(() => waitForCiRun(h.options), /verification.*(did not succeed|failure|timed_out|cancelled|skipped|neutral|action_required)/i);
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
  const h = harness([{ runs: wrong, jobs: [job()] }, { runs: [...wrong, run()], jobs: [job()] }]);
  waitForCiRun(h.options);
  assert.equal(h.elapsed(), 10);
  const pending = harness([{ runs: wrong, jobs: [job()] }]);
  assert.equal(collectCiResults(pending.options).status, 'pending');
});

for (const missing of ['run', 'job', 'completion']) {
  test(`bounded timeout when verification ${missing} never appears`, () => {
    const h = harness([{ runs: missing === 'run' ? [] : [run()], jobs: missing === 'job' ? [publish()] : [job(missing === 'completion' ? { status: 'queued', conclusion: '' } : missing === 'conclusion' ? { conclusion: '' } : {})] }]);
    assert.throws(() => waitForCiRun(h.options), /timed out/i);
    assert.equal(h.elapsed(), 30);
    assert.equal(collectCiResults(h.options).status, 'pending');
  });
}

test('ambiguous verification jobs fail closed in both wait and collection', () => {
  const h = harness([{ jobs: [job(), job({ databaseId: 999 })] }]);
  assert.throws(() => waitForCiRun(h.options), /ambiguous/i);
  assert.throws(() => collectCiResults(h.options), /ambiguous/i);
});

for (const field of ['listError', 'jobsError']) {
  test(`${field} fails closed instead of approving verification`, () => {
    const h = harness([{ jobs: [job()], [field]: new Error('API unavailable') }]);
    assert.throws(() => waitForCiRun(h.options), /API unavailable/);
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

test('parseArgs accepts --wait without --out and still requires --out otherwise', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/n', '--head-sha', 'abc', '--wait']), { repo: 'o/n', headSha: 'abc', wait: true });
  assert.throws(() => parseArgs(['--repo', 'o/n', '--head-sha', 'abc']), /Usage: fetch-ci-results\.cjs/);
});


test('required-success context fetch rejects a same-SHA rerun that changed after the wait', () => {
  for (const next of [[], [job({ status: 'queued', conclusion: '' })], [job({ conclusion: 'failure' })]]) {
    const h = harness([{ jobs: [job()] }, { jobs: next }]);
    waitForCiRun(h.options);
    assert.throws(() => collectCiResults({ ...h.options, requireSuccess: true }), /verification.*did not succeed/i);
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
