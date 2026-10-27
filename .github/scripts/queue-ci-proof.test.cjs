'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queueCiProof, REQUIRED_QUEUE_JOBS } = require('./queue-ci-proof.cjs');
const SHA = 'a'.repeat(40);
function fixture() {
  const run = { id: 20, run_attempt: 1, workflow_id: 3, path: '.github/workflows/ci.yml',
    event: 'merge_group', head_sha: SHA, head_branch: 'gh-readonly-queue/main/pr-7-base',
    repository: { full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, status: 'completed', conclusion: 'success' };
  const jobs = REQUIRED_QUEUE_JOBS.map((name, i) => ({ id: 100 + i, name, status: 'completed', conclusion: 'success' }));
  const state = { run, jobs, runs: [run], calls: [], now: 0 };
  const github = { request: async (route, args) => {
    state.calls.push({ route, args });
    state.onRequest?.(route, args);
    if (state.fail) throw new Error('private API error');
    if (route.endsWith('/workflows/{workflow_id}')) return { data: { id: 3, path: '.github/workflows/ci.yml', state: 'active' } };
    if (route.endsWith('/workflows/{workflow_id}/runs')) return { data: { total_count: state.count ?? state.runs.length, workflow_runs: structuredClone(state.runs) } };
    if (route.endsWith('/runs/{run_id}/jobs')) return { data: { total_count: state.jobCount ?? state.jobs.length, jobs: structuredClone(state.jobs) } };
    if (route.endsWith('/runs/{run_id}')) {
      if (state.onRead) state.onRead();
      return { data: structuredClone(state.run) };
    }
    throw new Error(`Unexpected route: ${route}`);
  } };
  return { state, options: { github, owner: 'o', repo: 'r', eventName: 'push', ref: 'refs/heads/main', sha: SHA,
    now: () => state.now, sleep: async ms => { state.now += ms; state.onSleep?.(); } } };
}
test('reuses only complete official queue verification of the exact main commit', async () => {
  const h = fixture(); const proof = await queueCiProof(h.options);
  assert.equal(proof.verified, true); assert.equal(proof.sha, SHA); assert.equal(proof.runId, 20); assert.equal(proof.attempt, 1);
  for (const { args } of h.state.calls) assert.ok(args.request.timeout <= 10000);
});
for (const [label, change] of Object.entries({
  'different SHA even with the same tree': s => { s.run.head_sha = 'b'.repeat(40); },
  'foreign repository': s => { s.run.repository.full_name = 'evil/r'; },
  'foreign head': s => { s.run.head_repository.full_name = 'evil/r'; },
  'PR run': s => { s.run.event = 'pull_request_target'; },
  'dispatch': s => { s.run.event = 'workflow_dispatch'; },
  'wrong workflow': s => { s.run.workflow_id = 4; },
  'wrong path': s => { s.run.path = '.github/workflows/other.yml'; },
  'wrong queue': s => { s.run.head_branch = 'gh-readonly-queue/release/pr-7'; },
  'failed latest attempt': s => { s.run.run_attempt = 2; s.run.conclusion = 'failure'; },
  'skipped aggregate': s => { s.jobs.find(j => j.name === 'Unit, build, E2E, and package').conclusion = 'skipped'; },
  'missing typecheck': s => { s.jobs = s.jobs.filter(j => j.name !== 'Typecheck'); },
  'missing browser shard': s => { s.jobs = s.jobs.filter(j => j.name !== 'Cockpit browser E2E shard 4/4'); },
  'duplicate required job': s => { s.jobs.push({ ...s.jobs[0], id: 999 }); },
  'missing history': s => { s.runs = []; },
  'incomplete pagination': s => { s.count = 201; },
  'incomplete jobs': s => { s.jobCount = 201; },
  'missing admission job': s => { s.jobs = s.jobs.filter(j => j.name !== 'Validate reviewed queue entry'); },
  'neutral leaf': s => { s.jobs[2].conclusion = 'neutral'; },
  'API error': s => { s.fail = true; },
  'newer failed run': s => { s.runs.push({ ...s.run, id: 21, conclusion: 'failure' }); },
})) test(`full CI fallback: ${label}`, async () => {
  const h = fixture(); change(h.state); assert.equal((await queueCiProof(h.options)).verified, false);
});
test('pending queue completion gets a bounded wait and then full fallback', async () => {
  const h = fixture(); h.state.run.status = 'in_progress'; h.state.run.conclusion = null;
  assert.equal((await queueCiProof(h.options)).verified, false); assert.equal(h.state.now, 60000);
});
test('completion during the short metadata wait is accepted', async () => {
  const h = fixture(); h.state.run.status = 'in_progress'; h.state.run.conclusion = null;
  h.state.onSleep = () => Object.assign(h.state.run, { status: 'completed', conclusion: 'success' });
  assert.equal((await queueCiProof(h.options)).verified, true);
});
test('a new attempt while jobs are read invalidates old proof', async () => {
  const h = fixture(); let reads = 0;
  h.state.onRead = () => { if (++reads === 2) h.state.run.run_attempt++; };
  assert.equal((await queueCiProof(h.options)).verified, false);
});
for (const eventName of ['merge_group', 'pull_request_target', 'workflow_dispatch']) test(`${eventName} never recursively reuses proof`, async () => {
  const h = fixture(); h.options.eventName = eventName;
  assert.equal((await queueCiProof(h.options)).verified, false); assert.equal(h.state.calls.length, 0);
});


test('metadata request consuming the deadline falls back without unbounded retry', async () => {
  const h = fixture(); h.state.onRequest = () => { h.state.now += 60001; };
  assert.equal((await queueCiProof(h.options)).verified, false);
  assert.equal(h.state.calls.length, 1);
});
test('newer run arriving after jobs are read invalidates proof', async () => {
  const h = fixture(); let lists = 0;
  h.state.onRequest = route => {
    if (route.endsWith('/workflows/{workflow_id}/runs') && ++lists === 2) h.state.runs.push({ ...h.state.run, id: 21, status: 'in_progress' });
  };
  assert.equal((await queueCiProof(h.options)).verified, false);
});
