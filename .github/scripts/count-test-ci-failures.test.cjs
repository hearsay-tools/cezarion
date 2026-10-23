const {test} = require('node:test');
const assert = require('node:assert/strict');
const {scan, parseArgs, formatReport} = require('./count-test-ci-failures.cjs');

const repo = 'owner/repo';
const root = `/repos/${repo}`;
const run = (id = 1, attempts = 2) => ({id, run_attempt: attempts, status: 'completed', updated_at: '2026-10-23T00:00:00Z'});
const job = (id, attempt) => ({id, run_id: 1, run_attempt: attempt, name: `browser ${id}`, status: 'completed', check_run_url: `https://api.github.com/repos/${repo}/check-runs/${id}`});
const annotation = (title = '[e2e] live-preview.e2e.ts > preview') => ({annotation_level: 'failure', path: 'packages/web/e2e/agent-browser.ts', title, message: 'timeout'});
function fixture({annotations = [annotation()], secondJobs = [job(11, 1), job(12, 2)], runs = [run()], broken, total = runs.length} = {}) {
  const calls = [];
  return {calls, request(endpoint) {
    calls.push(endpoint);
    if (broken?.(endpoint)) throw new Error('unavailable');
    if (endpoint.includes('/workflows/ci.yml/runs?')) return {total_count: total, workflow_runs: runs};
    if (endpoint === `${root}/actions/runs/1/attempts/1`) return {...run(), run_attempt: 1};
    if (endpoint.includes('/attempts/1/jobs?')) return {total_count: 1, jobs: [job(11, 1)]};
    if (endpoint.includes('/attempts/2/jobs?')) return {total_count: secondJobs.length, jobs: secondJobs};
    if (endpoint === `${root}/actions/runs/1`) return run();
    if (endpoint === `${root}/check-runs/11`) return {output: {annotations_count: annotations.length}};
    if (endpoint === `${root}/check-runs/12`) return {output: {annotations_count: 0}};
    if (endpoint.includes('/check-runs/11/annotations?')) return annotations;
    throw new Error(`Unexpected request: ${endpoint}`);
  }};
}
const options = {repo, testFile: 'live-preview.e2e.ts', runs: 20};
test('counts an earlier failed attempt even after success; retained jobs count once', () => {
  const api = fixture();
  const result = scan(options, api);
  assert.equal(result.complete, true);
  assert.equal(result.runsScanned, 1);
  assert.equal(result.failingRuns, 1);
  assert.equal(result.failingAttempts, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].attempt, 1);
  assert.equal(result.failures[0].jobId, 11);
  assert.equal(api.calls.filter(x => x === `${root}/check-runs/11`).length, 1);
  assert.match(formatReport(result), /1 of 1 runs/);
  assert.match(formatReport(result), /does not prove.*passed/);
});
test('file matching is literal and does not attribute helper stack references', () => {
  const result = scan(options, fixture({annotations: [annotation('[e2e] not-live-preview.e2e.ts > x'), annotation('[e2e] live-previewXe2eXts > x'), {...annotation('other.e2e.ts > x'), message: 'at live-preview.e2e.ts:12'}]}));
  assert.equal(result.failures.length, 0);
});
test('unavailable annotations leave explicit incomplete coverage', () => {
  const result = scan(options, fixture({broken: x => x.includes('/annotations?')}));
  assert.equal(result.complete, false);
  assert.match(result.problems.join('\n'), /unavailable/);
});
test('in-progress run cannot produce complete coverage', () => {
  assert.equal(scan(options, fixture({runs: [{...run(), status: 'in_progress'}]})).complete, false);
});
test('request and time limits leave incomplete coverage', () => {
  assert.equal(scan(options, {...fixture(), maxRequests: 1}).complete, false);
  let time = 0;
  assert.equal(scan(options, {...fixture(), now: () => time++ * 1000, durationMs: 1}).complete, false);
});
test('date query at GitHub cap is explicitly incomplete', () => {
  assert.equal(scan({...options, runs: undefined, since: '2026-10-22T00:00:00Z', until: '2026-10-23T00:00:00Z'}, fixture({total: 1000})).complete, false);
});
test('CLI accepts explicit selectors and rejects ambiguous or invalid input', () => {
  assert.deepEqual(parseArgs(['x.test.ts', '--repo', repo]), {testFile: 'x.test.ts', repo, runs: 20});
  assert.throws(() => parseArgs(['x', '--runs', '0']));
  assert.throws(() => parseArgs(['x', '--since', '2026-01-01']));
  assert.throws(() => parseArgs(['x', '--since', '2026-01-01T00:00:00Z', '--until', '2026-01-02T00:00:00Z', '--runs', '2']));
});
test('paginates runs, jobs and annotations and keeps distinct count units', () => {
  const calls = [];
  const many = Array.from({length: 101}, (_, i) => ({...run(i + 1, 1)}));
  const result = scan({...options, runs: 101}, {request(endpoint) {
    calls.push(endpoint);
    const url = new URL(endpoint, 'https://api.github.com');
    const page = Number(url.searchParams.get('page'));
    if (url.pathname.endsWith('/workflows/ci.yml/runs')) return {total_count: 101, workflow_runs: page === 1 ? many.slice(0, 100) : many.slice(100)};
    if (url.pathname.endsWith('/jobs')) {
      const runId = Number(url.pathname.split('/')[6]);
      const jobs = runId === 1 ? Array.from({length: 101}, (_, i) => ({...job(i + 11, 1)})) : [];
      return {total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100)};
    }
    if (url.pathname.includes('/annotations')) return Array.from({length: page === 1 ? 100 : 1}, () => annotation());
    if (url.pathname.includes('/check-runs/')) return {output: {annotations_count: url.pathname.endsWith('/11') ? 101 : 0}};
    const id = Number(url.pathname.split('/').at(-1));
    return run(id, 1);
  }});
  assert.equal(result.complete, true, result.problems.join('\n'));
  assert.equal(result.runsScanned, 101);
  assert.equal(result.failingRuns, 1);
  assert.equal(result.failingAttempts, 1);
  assert.equal(result.failures.length, 101);
  for (const kind of ['runs', 'jobs', 'annotations']) assert.ok(calls.some(x => x.includes(`${kind}?per_page=100&page=2`)), kind);
});
test('partial job pages, missing annotation rows and changed metadata are incomplete', () => {
  const cases = [
    (endpoint, data) => endpoint.includes('/jobs?') ? {...data, total_count: data.total_count + 1} : data,
    (endpoint, data) => endpoint.endsWith('/check-runs/11') ? {output: {annotations_count: 2}} : data,
    (endpoint, data) => endpoint === `${root}/actions/runs/1` ? {...data, run_attempt: 3} : data,
  ];
  for (const change of cases) {
    const api = fixture();
    const result = scan(options, {request: endpoint => change(endpoint, api.request(endpoint))});
    assert.equal(result.complete, false);
  }
});
test('CLI uses only GET API calls, prints results and exits nonzero for incomplete evidence', () => {
  const {main} = require('./count-test-ci-failures.cjs');
  const api = fixture();
  let output = '';
  const gh = args => {
    if (args[0] === 'repo') return repo;
    assert.deepEqual(args.slice(0, 3), ['api', '--method', 'GET']);
    return JSON.stringify(api.request(args[3]));
  };
  assert.equal(main(['live-preview.e2e.ts'], {gh, stdout: text => {output += text;}}), 0);
  assert.match(output, /Run 1, attempt 1, job 11/);
  output = '';
  assert.equal(main(['live-preview.e2e.ts', '--repo', repo], {gh: () => {throw new Error('private diagnostic');}, stdout: text => {output += text;}}), 1);
  assert.match(output, /INCOMPLETE/);
  assert.doesNotMatch(output, /private diagnostic/);
});
test('separates failing attempts from failing runs when the same test fails twice', () => {
  const api = fixture();
  const result = scan(options, {request(endpoint) {
    if (endpoint === `${root}/check-runs/12`) return {output: {annotations_count: 1}};
    if (endpoint.includes('/check-runs/12/annotations?')) return [annotation()];
    return api.request(endpoint);
  }});
  assert.equal(result.complete, true);
  assert.equal(result.runsScanned, 1);
  assert.equal(result.failingRuns, 1);
  assert.equal(result.failingAttempts, 2);
  assert.equal(result.failures.length, 2);
});
test('successful runs are listed without a conclusion filter and date bounds reach the API', () => {
  const api = fixture({runs: [{...run(), conclusion: 'success'}]});
  const result = scan({...options, runs: undefined, since: '2026-10-22T00:00:00Z', until: '2026-10-23T00:00:00Z'}, api);
  assert.equal(result.failingRuns, 1);
  assert.equal(result.complete, true);
  assert.ok(api.calls[0].includes('created=2026-10-22T00%3A00%3A00Z..2026-10-23T00%3A00%3A00Z'));
  assert.ok(!api.calls[0].includes('status='));
});
test('historical attempt is required when rerun jobs omit the original failed job', () => {
  const result = scan(options, fixture({secondJobs: [job(12, 2)]}));
  assert.equal(result.complete, true);
  assert.equal(result.failingRuns, 1);
  assert.equal(result.failures[0].jobId, 11);
  assert.equal(result.failures[0].attempt, 1);
});
