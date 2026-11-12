'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main, parseOptions, computeMetrics, percentile, runnerMinutes, proofReason, evidenceRun, groupRef,
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
  const code = await main(argv, { gh, stdout: text => { out += text; }, stderr: text => { err += text; }, wait: async () => {},
    now: Date.parse('2026-11-10T00:00:00Z') });
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
    'Queue failure rate: 40.0% (2 of 5; excluded: 0 invalidated, 0 removed for another cause)',
    'Runner-minutes: 410 (hosted 249, Ubicloud 161)',
    'Runner-minutes per merge: 102.5 (hosted 62.3, Ubicloud 40.3)',
    'Runner-minutes per full run: p50 96.5 (successful runs without native-suite reuse)',
    'Native-suite reuse hits: 1 of 5 runs',
    'Invalidated runs: 0, 0 runner-min (0.0 per merge)',
    'Queue-run wall (successful runs): p50 12.5 min, p90 12.8 min',
    'Main-push proof fallbacks: 2 of 4 pushes; reasons: source-not-successful 1, unexplained 1',
    `  unexplained: read the "${PROOF_JOB}" job summary at https://github.com/hearsay-tools/cezarion/actions/runs/41326268652`,
    'Verdict, queue failure rate: 40.0% against 30.0%: above limit: roll back',
    'Verdict, runner-minutes per merge: 102.5 against 179.2: within limit',
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
    assert.ok(!args.some(arg => /^(-X|--method|--input|-F|--field)(=|$)/.test(arg)), JSON.stringify(args));
    if (args[1] === 'graphql') assert.match(args.find(arg => arg.startsWith('query=')), /^query=query\(/);
    else assert.ok(!args.some(arg => /^(-f|--raw-field)(=|$)/.test(arg)), JSON.stringify(args));
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

test('a server error is retried', async () => {
  let failedOnce = false;
  const { gh, calls } = replay(RECORDED, { fail: args => {
    if (!failedOnce && args[1].includes('/jobs?')) { failedOnce = true; return 'gh: Server Error (HTTP 502)'; }
    return undefined;
  } });
  const { code, out } = await run([...WINDOW, '--json'], gh);
  assert.equal(code, 0);
  assert.equal(calls.filter(args => args[1].includes('/jobs?')).length, 10);
  assert.equal(JSON.parse(out).queue.completed, 5);
});

test('a client error stops the script with exit code 1 and no report', async () => {
  const { gh } = replay(RECORDED, { fail: args => (args[1].includes('/jobs?') ? 'gh: Forbidden (HTTP 403)' : undefined) });
  const { code, out, err } = await run(WINDOW, gh);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /^queue-metrics: gh: Forbidden \(HTTP 403\)\n$/);
});

test('a multi-day window reads one UTC day per query and counts a boundary result once', async () => {
  const days = ['2026-11-01T12:00:00Z..2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z..2026-11-03T00:00:00Z',
    '2026-11-03T00:00:00Z..2026-11-03T06:00:00Z'];
  const midnight = { ...queueRun(7, 'success', SHA('c')), created_at: '2026-11-02T00:00:00Z' };
  const merged = { number: 7, mergedAt: '2026-11-02T00:00:00Z',
    timelineItems: { nodes: [{ createdAt: '2026-11-01T23:50:00Z' }] } };
  const queried = { runs: [], search: [] };
  const gh = async args => {
    const created = /&created=([^&]+)&/.exec(args[1])?.[1];
    if (args[1].includes('/runs?event=merge_group&created=')) {
      queried.runs.push(created);
      const rows = created.includes('2026-11-02T00:00:00Z') ? [midnight] : [];
      return JSON.stringify({ total_count: rows.length, workflow_runs: rows });
    }
    if (args[1].includes('/runs?event=push')) return JSON.stringify({ total_count: 0, workflow_runs: [] });
    if (args[1].includes('/jobs?')) return JSON.stringify({ total_count: 0, jobs: [] });
    const q = args.find(arg => arg.startsWith('q='));
    if (!q) return JSON.stringify({ data: { repository: { pr7: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
    queried.search.push(/merged:(\S+)/.exec(q)[1]);
    const nodes = q.includes('2026-11-02T00:00:00Z') ? [merged] : [];
    return JSON.stringify({ data: { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false }, nodes } } });
  };
  const { code, out, err } = await run(['--from', '2026-11-01T12:00:00Z', '--to', '2026-11-03T06:00:00Z', '--repo', 'o/r', '--json'], gh);
  assert.equal(err, '');
  assert.equal(code, 0);
  // Queue runs reach one day past the window, for the runs that invalidate runs inside it.
  assert.deepEqual(queried, { runs: [...days.slice(0, 2), '2026-11-03T00:00:00Z..2026-11-04T00:00:00Z',
    '2026-11-04T00:00:00Z..2026-11-04T06:00:00Z'], search: days });
  const metrics = JSON.parse(out);
  assert.equal(metrics.queue.completed, 1);
  assert.equal(metrics.merges.total, 1);
});

test('after the first failed read, no further read starts', async () => {
  const runs = Array.from({ length: 20 }, (_, i) => queueRun(i + 1, 'success', SHA('c')));
  const calls = [];
  const held = [];
  const gh = async args => {
    calls.push(args[1]);
    if (args[1].includes('/runs?event=merge_group')) return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    if (args[1].includes('/runs?event=push')) return JSON.stringify({ total_count: 0, workflow_runs: [] });
    if (args[1] === 'graphql') return JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } });
    if (args[1].includes('/runs/1/jobs?')) throw new Error('gh: Forbidden (HTTP 403)');
    await new Promise(resolve => held.push(resolve));
    return JSON.stringify({ total_count: 0, jobs: [] });
  };
  const { code, err } = await run(['--from', '2026-11-02', '--to', '2026-11-02', '--repo', 'o/r'], gh);
  assert.equal(code, 1);
  assert.match(err, /HTTP 403/);
  // Release the reads in flight when the report failed, and let any read they lead to start.
  while (held.length) {
    for (const release of held.splice(0)) release();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls.filter(call => call.includes('/jobs?')).length, 8);
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

function queueRun(id, conclusion, base, minutesLong = 10, pr = id) {
  const start = Date.parse('2026-11-02T00:00:00Z') + id * 3600000;
  return { id, run_attempt: 1, event: 'merge_group', head_sha: SHA(id), head_branch: `gh-readonly-queue/main/pr-${pr}-${base}`,
    status: 'completed', conclusion, created_at: new Date(start).toISOString(), run_started_at: new Date(start).toISOString(),
    updated_at: new Date(start + minutesLong * 60000).toISOString(), html_url: `https://example.test/runs/${id}` };
}
const jobFor = (minutes, labels = ['ubuntu-24.04'], steps = []) => ({ id: minutes, name: 'Vitest shard 1/4', run_attempt: 1, status: 'completed',
  conclusion: 'success', labels, steps, started_at: '2026-11-02T00:00:00Z',
  completed_at: new Date(Date.parse('2026-11-02T00:00:00Z') + minutes * 60000).toISOString() });

// Removal i hours and 30 minutes after 2026-11-02T00:00Z, the start of run i.
const removedAfter = (run, reason) => ({ createdAt: new Date(Date.parse('2026-11-02T00:30:00Z') + run * 3600000).toISOString(), reason });

test('the failure rate counts neither invalidated runs nor runs removed for another cause', () => {
  const raw = { repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', pushes: [], merges: [], queueJobs: {},
    queueRuns: [
      queueRun(1, 'failure', SHA('c1'), 10, 10), queueRun(2, 'success', SHA('c2'), 10, 10),
      queueRun(3, 'failure', SHA('c1'), 10, 11), queueRun(4, 'failure', SHA('c1'), 10, 12), queueRun(5, 'cancelled', SHA('c1'), 10, 13),
      queueRun(6, 'failure', SHA('c1'), 10, 14), queueRun(7, 'success', SHA('c3'), 10, 14), queueRun(8, 'success', SHA('c1'), 10, 15),
    ],
    removals: {
      10: [removedAfter(2, 'merged')], 11: [removedAfter(3, 'failed_checks')], 12: [removedAfter(4, 'manual')],
      13: [removedAfter(5, 'failed_checks')], 14: [removedAfter(6, 'failed_checks'), removedAfter(7, 'merged')],
      15: [removedAfter(8, 'merge_conflict')],
    } };
  const { queue, verdicts } = computeMetrics(raw);
  assert.equal(verdicts.failureRate.value, 3 / 5);
  assert.equal(queue.completed, 8);
  assert.equal(queue.counted, 5);
  assert.equal(queue.failed, 3);
  assert.equal(queue.invalidated.runs, 1);
  assert.equal(queue.removed, 2);
  // A replacement created after the window still invalidates the run inside it.
  const after = { ...queueRun(30, 'success', SHA('c9'), 10, 11), created_at: '2026-11-03T01:00:00Z' };
  assert.equal(computeMetrics({ ...raw, removals: {}, queueRuns: [queueRun(3, 'failure', SHA('c1'), 10, 11)],
    laterQueueRuns: [after] }).queue.invalidated.runs, 1);
  // The entry ends at a removal before the run's first attempt starts; a re-run attempt starts later still.
  const late = { ...queueRun(4, 'failure', SHA('c1'), 10, 12), run_started_at: '2026-11-02T05:00:00Z' };
  assert.equal(computeMetrics({ ...raw, queueRuns: [late] }).queue.removed, 1);
});

test('a run rebuilt on another base counts as invalidated waste', () => {
  const ahead = SHA('b1');
  const raw = { repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z', pushes: [],
    queueRuns: [queueRun(1, 'failure', SHA('c1')), queueRun(2, 'success', ahead), queueRun(3, 'success', SHA('c1'), 10, 2),
      { ...queueRun(4, null, SHA('c1')), status: 'in_progress' }],
    queueJobs: { 1: [jobFor(100)], 2: [jobFor(90, ['ubicloud-standard-2'])], 3: [jobFor(80, ['ubuntu-24.04'], [{ name: REUSE_STEP, conclusion: 'success' }])] },
    removals: {},
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
  assert.deepEqual(metrics.verdicts.failureRate, { value: 1 / 2, limit: 0.3, verdict: 'above limit: roll back' });
  assert.deepEqual(metrics.verdicts.runnerMinutesPerMerge, { value: 270, limit: 179.2, verdict: 'above limit: roll back' });
});

test('no merges and no runs print n/a and no verdict', () => {
  const metrics = computeMetrics({ repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-09T00:00:00Z',
    queueRuns: [], queueJobs: {}, pushes: [], removals: {}, merges: [] });
  assert.equal(metrics.verdicts.failureRate.verdict, 'no data');
  assert.equal(metrics.verdicts.runnerMinutesPerMerge.verdict, 'no data');
});

test('fallback reasons rebuild the checks queue-ci-proof.cjs makes', () => {
  const proof = conclusion => ({ name: PROOF_JOB, conclusion, completed_at: '2026-11-02T01:00:00Z' });
  const gate = REQUIRED_QUEUE_JOBS.map((name, i) => ({ id: i + 1, name, run_attempt: 1, status: 'completed', conclusion: 'success' }));
  const done = { ...queueRun(1, 'success', SHA('c')), updated_at: '2026-11-02T00:59:00Z' };
  const push = (jobs, evidence) => ({ run: { html_url: 'u' }, jobs, evidence });
  assert.equal(proofReason(push([])), 'proof-job-missing');
  assert.equal(proofReason(push([proof('failure')])), 'proof-job-failure');
  assert.equal(proofReason(push([proof('success')], { queueRun: null, queueJobs: [] })), 'no-exact-queue-run');
  assert.equal(proofReason(push([proof('success')], { queueRun: { ...done, updated_at: '2026-11-02T01:00:01Z' }, queueJobs: gate })), 'source-pending');
  assert.equal(proofReason(push([proof('success')], { queueRun: { ...done, conclusion: 'failure' }, queueJobs: gate })), 'source-not-successful');
  assert.equal(proofReason(push([proof('success')], { queueRun: done, queueJobs: gate.slice(1) })), 'incomplete-gate');
  assert.equal(proofReason(push([proof('success')], { queueRun: done, queueJobs: gate })), 'unexplained');
  // A queue run from before the eight-shard matrices is judged by the roster of its own shard count.
  const four = REQUIRED_QUEUE_JOBS.filter(name => !/ shard \d+\/8$/.test(name))
    .concat(['Vitest shard', 'Cockpit browser E2E shard'].flatMap(prefix => [1, 2, 3, 4].map(n => `${prefix} ${n}/4`)))
    .map((name, i) => ({ id: 100 + i, name, run_attempt: 1, status: 'completed', conclusion: 'success' }));
  assert.equal(proofReason(push([proof('success')], { queueRun: done, queueJobs: four })), 'unexplained');
  const missing = four.filter(job => job.name !== 'Cockpit browser E2E shard 4/4');
  assert.equal(proofReason(push([proof('success')], { queueRun: done, queueJobs: missing })), 'incomplete-gate');
});

test('a main push counts as a fallback only when Typecheck ran', () => {
  const push = (id, proof, typecheck) => ({ run: { id, html_url: `u${id}` },
    jobs: [{ name: PROOF_JOB, conclusion: proof, completed_at: '2026-11-02T01:00:00Z' }, { name: FALLBACK_JOB, conclusion: typecheck }],
    evidence: { queueRun: null, queueJobs: [] } });
  const metrics = computeMetrics({ repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', queueRuns: [], queueJobs: {},
    removals: {}, merges: [], pushes: [push(1, 'cancelled', 'skipped'), push(2, 'success', 'skipped'), push(3, 'failure', 'success'),
      push(4, 'success', 'failure')] });
  assert.deepEqual(metrics.mainPush, { pushes: 4, fallbacks: 2, reasons: { 'proof-job-failure': 1, 'no-exact-queue-run': 1 }, unexplained: [] });
});

test('the runner-minute limit is 128 x 1.4 = 179.2', () => {
  const merge = number => ({ number, mergedAt: '2026-11-02T12:00:00Z', enqueuedAt: ['2026-11-02T11:00:00Z'] });
  const metrics = computeMetrics({ repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', pushes: [], removals: {},
    queueRuns: [queueRun(1, 'success', SHA('c1'))], queueJobs: { 1: [jobFor(1791)] },
    merges: Array.from({ length: 10 }, (_, i) => merge(i + 1)) });
  assert.deepEqual(metrics.verdicts.runnerMinutesPerMerge, { value: 179.1, limit: 179.2, verdict: 'within limit' });
});

test('a re-run main push is classified by its latest attempt', () => {
  const job = (name, attempt, conclusion) => ({ name, run_attempt: attempt, conclusion, completed_at: '2026-11-02T01:00:00Z' });
  const push = (id, jobs) => ({ run: { id, run_attempt: 2, html_url: `u${id}` }, jobs, evidence: { queueRun: null, queueJobs: [] } });
  const metrics = computeMetrics({ repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', queueRuns: [], queueJobs: {},
    removals: {}, merges: [], pushes: [
      push(1, [job(FALLBACK_JOB, 1, 'success'), job(PROOF_JOB, 1, 'failure'), job(PROOF_JOB, 2, 'success'), job(FALLBACK_JOB, 2, 'skipped')]),
      push(2, [job(PROOF_JOB, 1, 'success'), job(FALLBACK_JOB, 1, 'skipped'), job(PROOF_JOB, 2, 'cancelled'), job(FALLBACK_JOB, 2, 'success')]),
    ] });
  assert.deepEqual(metrics.mainPush, { pushes: 2, fallbacks: 1, reasons: { 'proof-job-cancelled': 1 }, unexplained: [] });
});

test('fallback evidence is the newest exact queue run that existed when the proof ran', () => {
  const run = (id, createdAt) => ({ id, created_at: createdAt });
  const proof = { completed_at: '2026-11-02T01:00:00Z' };
  const runs = [run(1, '2026-11-02T00:10:00Z'), run(2, '2026-11-02T00:40:00Z'), run(3, '2026-11-02T01:30:00Z')];
  assert.equal(evidenceRun(runs, proof).id, 2);
  assert.equal(evidenceRun([runs[2]], proof), null);
  assert.equal(evidenceRun(runs, undefined).id, 3);
});

test('a queue run re-run after a decision is read as the attempt that ran when the decision was made', () => {
  // Attempt 1 fails and its entry is removed for failed checks; a re-run three hours later succeeds.
  const first = { ...queueRun(1, 'failure', SHA('c1')), updated_at: '2026-11-02T01:20:00Z' };
  const rerun = { ...queueRun(1, 'success', SHA('c1')), run_attempt: 2, run_started_at: '2026-11-02T04:00:00Z', updated_at: '2026-11-02T04:12:00Z' };
  const raw = { repo: 'o/r', from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z', pushes: [], merges: [],
    queueRuns: [rerun], queueJobs: { 1: [{ ...jobFor(10), run_attempt: 1 }, { ...jobFor(12), id: 99, run_attempt: 2 }] },
    attempts: { 1: [first, rerun] }, removals: { 1: [removedAfter(1, 'failed_checks')] } };
  const { queue } = computeMetrics(raw);
  assert.equal(queue.failed, 1);
  assert.deepEqual(queue.conclusions, { failure: 1 });
  assert.equal(queue.minutes.all, 22);
  // The proof completed between the two attempts and read attempt 1.
  const proof = { name: PROOF_JOB, run_attempt: 1, conclusion: 'success', completed_at: '2026-11-02T02:00:00Z' };
  const push = { run: { run_attempt: 1, html_url: 'u' }, jobs: [proof],
    evidence: { queueRun: rerun, attempts: [first, rerun], queueJobs: [] } };
  assert.equal(proofReason(push), 'source-not-successful');
});

test('the command reads each attempt of a re-run queue run', async () => {
  const runAt = attempt => ({ ...queueRun(1, attempt === 1 ? 'failure' : 'success', SHA('c1'), 10, 5), run_attempt: attempt,
    run_started_at: attempt === 1 ? '2026-11-02T01:00:00Z' : '2026-11-02T04:00:00Z' });
  const calls = [];
  const gh = async args => {
    calls.push(args[1]);
    if (args[1].includes('/runs?event=merge_group')) return JSON.stringify({ total_count: 1, workflow_runs: [runAt(2)] });
    if (args[1].includes('/runs?event=push')) return JSON.stringify({ total_count: 0, workflow_runs: [] });
    if (args[1].includes('/jobs?')) return JSON.stringify({ total_count: 0, jobs: [] });
    const attempt = /\/attempts\/(\d+)$/.exec(args[1]);
    if (attempt) return JSON.stringify(runAt(Number(attempt[1])));
    if (args.some(arg => arg.startsWith('q='))) {
      return JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } });
    }
    return JSON.stringify({ data: { repository: { pr5: { timelineItems: { pageInfo: { hasNextPage: false },
      nodes: [{ createdAt: '2026-11-02T01:30:00Z', reason: 'failed_checks' }] } } } } });
  };
  const { code, out } = await run(['--from', '2026-11-02', '--to', '2026-11-02', '--repo', 'o/r', '--json'], gh);
  assert.equal(code, 0);
  assert.deepEqual(calls.filter(call => call.includes('/attempts/')).sort(),
    ['repos/o/r/actions/runs/1/attempts/1', 'repos/o/r/actions/runs/1/attempts/2']);
  assert.equal(JSON.parse(out).queue.failed, 1);
});

test('group refs name their PR and base', () => {
  assert.deepEqual(groupRef(`gh-readonly-queue/main/pr-12-${SHA(5)}`), { pr: 12, base: SHA(5) });
  assert.equal(groupRef('gh-readonly-queue/main/pr-12-short'), undefined);
  assert.equal(groupRef(undefined), undefined);
});

test('ci.yml keeps main-push proof while PR-suite reuse stays historical', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8');
  assert.match(workflow, new RegExp(`name: ${PROOF_JOB}\\n`));
  assert.doesNotMatch(workflow, new RegExp(`- name: ${REUSE_STEP}\\n`));
  const typecheck = /\n {2}typecheck:\n {4}name: (.+)\n {4}needs: queue-proof\n {4}if: (.+)\n/.exec(workflow);
  assert.ok(typecheck, 'typecheck job needs queue-proof');
  assert.equal(typecheck[1], FALLBACK_JOB);
  assert.match(typecheck[2], /needs\.queue-proof\.outputs\.verified != 'true'/);
});
