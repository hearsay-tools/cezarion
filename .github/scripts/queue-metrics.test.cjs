'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main, parseOptions, computeMetrics, percentile, runnerMinutes, proofReason, groupBase,
  PROOF_JOB, FALLBACK_JOB, REUSE_STEP } = require('./queue-metrics.cjs');
const { REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');

const RECORDED = require('./fixtures/queue-metrics-2026-11-01.json').responses;
const WINDOW = ['--from', '2026-11-01T16:00:00Z', '--to', '2026-11-01T21:00:00Z', '--repo', 'hearsay-tools/cezarion'];
const SHA = n => String(n).padStart(40, 'a');

function replay(responses = RECORDED, { fail = () => undefined } = {}) {
  const calls = [];
  const gh = async args => {
    calls.push(args);
    const failure = fail(args, calls);
    if (failure) throw new Error(failure);
    const recorded = responses[JSON.stringify(args)];
    if (!recorded) throw new Error(`no recorded response for ${JSON.stringify(args)}`);
    return recorded.text ?? JSON.stringify(recorded.json);
  };
  return { gh, calls };
}

async function run(argv, gh) {
  let out = '';
  let err = '';
  const code = await main(argv, { gh, stdout: text => { out += text; }, stderr: text => { err += text; }, wait: async () => {} });
  return { code, out, err };
}

test('recorded window prints every pilot metric and both rollback verdicts', async () => {
  const { gh } = replay();
  const { code, out, err } = await run(WINDOW, gh);
  assert.equal(err, '');
  assert.equal(code, 0);
  assert.equal(out, [
    'Merge-queue pilot metrics for hearsay-tools/cezarion, 2026-11-01T16:00:00Z to 2026-11-01T21:00:00Z (0.21 days, UTC)',
    'Merges per day: 2026-11-01 4 (total 4)',
    'Enqueue to merge (last enqueue): p50 12.9 min, p90 14.7 min, max 15.4 min',
    'Queue runs: 5 completed (failure 2, success 3), 0 in flight not counted',
    'Queue failure rate: 40.0% (2 of 5)',
    'Runner-minutes: 410 (hosted 249, Ubicloud 161)',
    'Runner-minutes per merge: 102.5 (hosted 62.3, Ubicloud 40.3)',
    'Runner-minutes per full run: p50 96.5 (successful runs without native-suite reuse)',
    'Native-suite reuse hits: 1 of 5 runs',
    'Invalidated runs: 0, 0 runner-min (0.0 per merge)',
    'Queue-run wall (successful runs): p50 12.5 min, p90 12.8 min',
    'Main-push proof fallbacks: 2 of 4 pushes; reasons: source-not-successful 1, unexplained 1',
    `  unexplained: read the "${PROOF_JOB}" job summary at https://github.com/hearsay-tools/cezarion/actions/runs/41326268652`,
    'Verdict, queue failure rate: 40.0% against 30.0%: above limit: roll back',
    'Verdict, runner-minutes per merge: 102.5 against 179: within limit',
    'Note: the rollback limits apply to a rolling 7 days; this window is 0.21 days.',
    '',
  ].join('\n'));
});

test('the script only reads: every gh call is a GET or a GraphQL query', async () => {
  const { gh, calls } = replay();
  await run([...WINDOW, '--json'], gh);
  assert.ok(calls.length > 0);
  for (const args of calls) {
    assert.equal(args[0], 'api');
    assert.ok(!args.some(arg => /^(-X|--method|--input|-F|--field)$/.test(arg)), JSON.stringify(args));
    if (args[1] === 'graphql') assert.match(args.find(arg => arg.startsWith('query=')), /^query=query\(/);
  }
});

test('--json carries the same numbers as the report', async () => {
  const { gh } = replay();
  const { out } = await run([...WINDOW, '--json'], gh);
  const metrics = JSON.parse(out);
  assert.equal(metrics.queue.completed, 5);
  assert.equal(metrics.queue.failed, 2);
  assert.deepEqual(metrics.queue.minutes, { hosted: 249, ubicloud: 161, other: 0, all: 410 });
  assert.equal(metrics.merges.total, 4);
  assert.equal(metrics.runnerMinutesPerMerge.all, 102.5);
  assert.deepEqual(metrics.mainPush.reasons, { 'source-not-successful': 1, unexplained: 1 });
  assert.equal(metrics.verdicts.failureRate.verdict, 'above limit: roll back');
  assert.equal(metrics.verdicts.runnerMinutesPerMerge.verdict, 'within limit');
});

test('a server error is retried and a missing group base counts as not on main', async () => {
  let failedOnce = false;
  const { gh, calls } = replay(RECORDED, { fail: args => {
    if (!failedOnce && args[1].includes('/jobs?')) { failedOnce = true; return 'gh: Server Error (HTTP 502)'; }
    if (args[1].includes('/compare/') && args[1].includes('7fac3b06')) return 'gh: Not Found (HTTP 404)';
    return undefined;
  } });
  const { code, out } = await run([...WINDOW, '--json'], gh);
  assert.equal(code, 0);
  assert.equal(calls.filter(args => args[1].includes('/jobs?')).length, 10);
  assert.equal(JSON.parse(out).queue.invalidated.runs, 2);
});

test('a client error stops the script with exit code 1 and no report', async () => {
  const { gh } = replay(RECORDED, { fail: args => (args[1].includes('/jobs?') ? 'gh: Forbidden (HTTP 403)' : undefined) });
  const { code, out, err } = await run(WINDOW, gh);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /^queue-metrics: gh: Forbidden \(HTTP 403\)\n$/);
});

test('window options: dates are whole UTC days, the default is the last 7 days', () => {
  const now = Date.parse('2026-11-08T10:30:15.400Z');
  assert.deepEqual(parseOptions(['--from', '2026-11-01', '--to', '2026-11-03'], now),
    { from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-11-04T00:00:00Z'), repo: undefined, json: false });
  assert.deepEqual(parseOptions([], now), { from: Date.parse('2026-11-01T10:30:15Z'), to: Date.parse('2026-11-08T10:30:15Z'), repo: undefined, json: false });
  assert.equal(parseOptions(['--to', '2026-11-03T20:22:10Z'], now).to, Date.parse('2026-11-03T20:22:10Z'));
  for (const argv of [['--from', '2026-02-30'], ['--from', '2026-11-01T00:00Z'], ['--from', '2026-11-03', '--to', '2026-11-02'], ['--repo', 'nope'], ['--write']]) {
    assert.throws(() => parseOptions(argv, now), undefined, JSON.stringify(argv));
  }
});

test('percentiles interpolate between ranks', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

test('runner-minutes round each job up and split by runner label', () => {
  const job = (labels, seconds) => ({ labels, started_at: '2026-11-01T00:00:00Z', completed_at: new Date(Date.parse('2026-11-01T00:00:00Z') + seconds * 1000).toISOString() });
  assert.deepEqual(runnerMinutes([
    job(['ubuntu-24.04'], 61), job(['ubuntu-latest'], 1), job(['ubicloud-standard-2'], 120),
    job(['self-hosted', 'blacksmith-2vcpu'], 30), job([], 600), { labels: ['ubuntu-24.04'], started_at: null, completed_at: null },
  ]), { hosted: 3, ubicloud: 2, other: 1, all: 6 });
});

function queueRun(id, conclusion, base, minutesLong = 10) {
  const start = Date.parse('2026-11-02T00:00:00Z') + id * 3600000;
  return { id, run_attempt: 1, event: 'merge_group', head_sha: SHA(id), head_branch: `gh-readonly-queue/main/pr-${id}-${base}`,
    status: 'completed', conclusion, created_at: new Date(start).toISOString(), run_started_at: new Date(start).toISOString(),
    updated_at: new Date(start + minutesLong * 60000).toISOString(), html_url: `https://example.test/runs/${id}` };
}
const jobFor = (minutes, labels = ['ubuntu-24.04'], steps = []) => ({ id: minutes, name: 'Vitest shard 1/4', run_attempt: 1, status: 'completed',
  conclusion: 'success', labels, steps, started_at: '2026-11-02T00:00:00Z',
  completed_at: new Date(Date.parse('2026-11-02T00:00:00Z') + minutes * 60000).toISOString() });

test('a run whose group base never reached main counts as invalidated waste', () => {
  const ahead = SHA('b1');
  const raw = { repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z', pushes: [],
    queueRuns: [queueRun(1, 'failure', SHA('m1')), queueRun(2, 'success', ahead), queueRun(3, 'success', SHA('m1')),
      { ...queueRun(4, null, SHA('m1')), status: 'in_progress' }],
    queueJobs: { 1: [jobFor(100)], 2: [jobFor(90, ['ubicloud-standard-2'])], 3: [jobFor(80, ['ubuntu-24.04'], [{ name: REUSE_STEP, conclusion: 'success' }])] },
    onMain: { [SHA('m1')]: true, [ahead]: false },
    merges: [{ number: 3, mergedAt: '2026-11-02T04:00:00Z', enqueuedAt: ['2026-11-02T01:00:00Z', '2026-11-02T03:30:00Z', '2026-11-02T05:00:00Z'] },
      { number: 9, mergedAt: '2026-11-03T00:00:00Z', enqueuedAt: [] }] };
  const metrics = computeMetrics(raw);
  assert.deepEqual(metrics.queue.invalidated, { runs: 1, minutes: 90 });
  assert.equal(metrics.invalidatedMinutesPerMerge, 90);
  assert.equal(metrics.queue.inFlight, 1);
  assert.equal(metrics.queue.reuseHits, 1);
  assert.equal(metrics.queue.fullRunMinutesP50, 90);
  assert.equal(metrics.merges.total, 1);
  assert.equal(metrics.merges.enqueueP50, 30);
  assert.equal(metrics.merges.perDay['2026-11-08'], 0);
  assert.deepEqual(metrics.verdicts.failureRate, { value: 1 / 3, limit: 0.3, verdict: 'above limit: roll back' });
  assert.deepEqual(metrics.verdicts.runnerMinutesPerMerge, { value: 270, limit: 179, verdict: 'above limit: roll back' });
});

test('no merges and no runs print n/a and no verdict', () => {
  const metrics = computeMetrics({ repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z',
    queueRuns: [], queueJobs: {}, pushes: [], onMain: {}, merges: [] });
  assert.equal(metrics.verdicts.failureRate.verdict, 'no data');
  assert.equal(metrics.verdicts.runnerMinutesPerMerge.verdict, 'no data');
});

test('fallback reasons rebuild the checks queue-ci-proof.cjs makes', () => {
  const proof = conclusion => ({ name: PROOF_JOB, conclusion, completed_at: '2026-11-02T01:00:00Z' });
  const gate = REQUIRED_QUEUE_JOBS.map((name, i) => ({ id: i + 1, name, run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const done = { ...queueRun(1, 'success', SHA('m')), updated_at: '2026-11-02T00:59:00Z' };
  const push = (jobs, evidence) => ({ run: { html_url: 'u' }, jobs, evidence });
  assert.equal(proofReason(push([])), 'proof-job-missing');
  assert.equal(proofReason(push([proof('failure')])), 'proof-job-failure');
  assert.equal(proofReason(push([proof('success')], { queueRun: null, queueJobs: [] })), 'no-exact-queue-run');
  assert.equal(proofReason(push([proof('success')], { queueRun: { ...done, updated_at: '2026-11-02T01:00:01Z' }, queueJobs: gate })), 'source-pending');
  assert.equal(proofReason(push([proof('success')], { queueRun: { ...done, conclusion: 'failure' }, queueJobs: gate })), 'source-not-successful');
  assert.equal(proofReason(push([proof('success')], { queueRun: done, queueJobs: gate.slice(1) })), 'incomplete-gate');
  assert.equal(proofReason(push([proof('success')], { queueRun: done, queueJobs: gate })), 'unexplained');
});

test('group refs name their base', () => {
  assert.equal(groupBase(`gh-readonly-queue/main/pr-12-${SHA(5)}`), SHA(5));
  assert.equal(groupBase('gh-readonly-queue/main/pr-12-short'), undefined);
  assert.equal(groupBase(undefined), undefined);
});

test('ci.yml still has the jobs and step the metrics read', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8');
  assert.match(workflow, new RegExp(`name: ${PROOF_JOB}\\n`));
  assert.match(workflow, new RegExp(`- name: ${REUSE_STEP}\\n`));
  const typecheck = /\n {2}typecheck:\n {4}name: (.+)\n {4}needs: queue-proof\n {4}if: (.+)\n/.exec(workflow);
  assert.ok(typecheck, 'typecheck job needs queue-proof');
  assert.equal(typecheck[1], FALLBACK_JOB);
  assert.match(typecheck[2], /needs\.queue-proof\.outputs\.verified != 'true'/);
});
