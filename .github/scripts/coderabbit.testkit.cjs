'use strict';
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
function reviewState() {
  const pr = { number: 7, node_id: 'PR_7', state: 'open', draft: true, changed_files: 1, user: { login: 'author' },
    head: { sha: HEAD, ref: 'feature', repo: { full_name: 'o/r' } },
    base: { sha: BASE, ref: 'main', repo: { full_name: 'o/r' } } };
  const run = { id: 20, run_attempt: 1, workflow_id: 3, path: '.github/workflows/ci.yml', event: 'pull_request_target',
    name: 'CI', repository: { id: 1, full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, head_sha: HEAD,
    head_branch: 'feature', status: 'completed', conclusion: 'failure', created_at: '2026-11-02T00:00:00Z', pull_requests: [{ number: 7, head: { sha: HEAD }, base: { ref: 'main' } }] };
  const jobs = ['Automated Code Review', 'Review preflight', 'Unit, build, E2E, and package'].map((name, i) =>
    ({ id: i + 30, name, steps: i === 0 ? [{ name: 'Require fresh CodeRabbit admission and resolved threads' }] : [], status: 'completed', conclusion: i === 0 ? 'failure' : 'success' }));
  const check = { id: 100, app: { id: 347564, slug: 'coderabbitai' }, name: 'CodeRabbit', head_sha: HEAD,
    status: 'completed', conclusion: 'success', pull_requests: [], started_at: '2026-11-02T00:00:00Z', completed_at: '2026-11-02T00:01:00Z' };
  return { pr, run, jobs, checks: [check], threads: [], calls: [], writes: [], files: [], contents: {}, clock: Date.parse('2026-11-02T12:00:00Z') };
}
function actionsData(s, route, args) {
  if (route.endsWith('/workflows/{workflow_id}')) return args.workflow_id === 'ci.yml'
    ? { id: 3, path: '.github/workflows/ci.yml', state: 'active' }
    : { id: 4, path: '.github/workflows/coderabbit-review-signal.yml', state: 'active' };
  if (route.endsWith('/workflows/{workflow_id}/runs')) return { total_count: s.runs?.length ?? 1, workflow_runs: s.runs ?? [s.run] };
  if (route.endsWith('/runs/{run_id}/jobs')) return { total_count: s.jobs.length, jobs: s.jobs };
  if (route.endsWith('/runs/{run_id}')) return args.run_id === 40 ? s.signal : s.run;
  if (route.endsWith('/actions/jobs/{job_id}/rerun')) {
    s.writes.push(args.job_id);
    if (s.writeError) throw new Error('ambiguous write');
    if (!s.delayAttempt) { s.run.run_attempt++; s.run.status = 'queued'; }
    return {};
  }
  throw new Error(`Unexpected actions route ${route}`);
}
// The head's check runs follow the native jobs unless a test sets `checkRuns`.
const headCheckRuns = s => s.checkRuns ?? s.jobs.map(({ id, name, status, conclusion }) => ({ id, name, status, conclusion }));
// A provider read names the CodeRabbit check; the board's head listing does not.
const providerRead = (route, args) => route.endsWith('/commits/{ref}/check-runs') && Boolean(args?.check_name);
function checkRunsData(s, route, args) {
  if (route.endsWith('/check-runs/{check_run_id}')) return s.checks.find(c => c.id === args.check_run_id);
  if (args.check_name) return { total_count: s.checkTotal ?? s.checks.length, check_runs: s.checkPages?.[args.page - 1] ?? s.checks };
  const runs = headCheckRuns(s);
  return { total_count: runs.length, check_runs: runs };
}
function reviewData(s, route, args) {
  if (route.endsWith('/pulls/{pull_number}')) return s.pr;
  if (route.endsWith('/rules/branches/{branch}')) return s.rules ?? [{ type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: 'Unit, build, E2E, and package' }] } }];
  if (route.endsWith('/commits/{ref}/status')) return { statuses: s.statuses ?? [] };
  if (route.includes('/check-runs')) return checkRunsData(s, route, args);
  if (route.endsWith('/pulls/{pull_number}/files')) return s.files;
  if (route.endsWith('/contents/{path}')) return s.contents[`${args.ref}:${args.path}`];
  if (route.includes('/actions/')) return actionsData(s, route, args);
  if (route === 'GET /repos/{owner}/{repo}/pulls') return s.pulls ?? [s.pr];
  if (route === 'POST /graphql') return { data: { repository: { pullRequest: { reviewThreads: s.threadPage ?? {
    nodes: s.threads, pageInfo: { hasNextPage: false, endCursor: null } } } } } };
  if (route === 'GET /rate_limit') return { resources: { core: { remaining: s.coreRemaining ?? 5000, reset: 1 } } };
  throw new Error(`Unexpected route ${route}`);
}
function fixture() {
  const s = reviewState();
  const github = { request: async (route, args) => {
    s.calls.push([route, args]); s.onRead?.(route, args);
    if (s.fail) throw new Error('API unavailable');
    return { data: structuredClone(reviewData(s, route, args)) };
  } };
  return { s, github, now: () => s.clock, sleep: async ms => { s.clock += ms; } };
}
module.exports = { fixture, reviewState, reviewData, providerRead, HEAD, BASE };
