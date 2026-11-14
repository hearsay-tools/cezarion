'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const CI_PATH = '.github/workflows/ci.yml';
const VERIFY = 'Unit, build, E2E, and package';
const REVIEW = 'Automated Code Review';
// The shard count of ci.yml's vitest and cockpit-browser matrices.
const SHARDS = 8;
// A matrix job that its `if` skipped is listed once, under its unexpanded name.
const suitesOf = count => ['Vitest shard', 'Cockpit browser E2E shard'].map(prefix => ({
  shards: Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}/${count}`),
  skipped: `${prefix} \${{ matrix.shard }}/${count}` }));
const requiredQueueJobs = (count = SHARDS) => [
  'Classify pull request change surface', 'Classify PR shape', 'Check function complexity', 'Check new code clones', 'Review preflight', 'Typecheck', 'Unit tests (package)', 'Unit tests (scripts)', 'Build and package',
  ...suitesOf(count).flatMap(suite => suite.shards), VERIFY, REVIEW, 'Validate reviewed queue entry',
];
const SUITES = suitesOf(SHARDS);
const SUITE_JOBS = SUITES.flatMap(suite => suite.shards);
// Workflow parity tests expand matrices and compare this complete roster.
const REQUIRED_QUEUE_JOBS = requiredQueueJobs();
const SKIPPED_SUITE_JOBS = SUITES.map(suite => suite.skipped);
const SKIPPABLE_SURFACES = ['docs-only', 'infra-only'];
const QUEUE_BASE = /^gh-readonly-queue\/main\/pr-[1-9][0-9]*-([a-f0-9]{40})$/;
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
// GitHub fails a read now and then with a 5xx (a timed-out fetch is one too) or
// with a rate limit that names its wait. Such a read runs again, at most
// READ_ATTEMPTS times in all and only inside the deadline. A real refusal fails
// at once. A write never runs twice: its failure does not prove it did not land.
const READ_ATTEMPTS = 3;
// A GraphQL document is a read only when it starts with a query, after blanks and comments.
const isRead = (route, args) => route.startsWith('GET ')
  || (route === 'POST /graphql' && /^(?:\s|#[^\r\n]*(?=[\r\n]|$))*(?:query\b|\{)/.test(args.query ?? ''));
function retryDelay(error, attempt) {
  if (error?.status >= 500) return 1000 * attempt;
  if (![403, 429].includes(error?.status)) return null;
  const after = Number(error.response?.headers?.['retry-after']);
  if (Number.isFinite(after)) return after * 1000;
  return /secondary rate limit/i.test(error.message) ? 60000 : null;
}
function reader(github, owner, repo, deadline, now, sleep = delay) {
  const once = async (route, args) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('deadline');
    // github-script v9's fetch transport ignores numeric request.timeout.
    const budget = Math.min(10000, remaining);
    const result = await github.request(route, { owner, repo, ...args,
      request: { timeout: budget, signal: AbortSignal.timeout(budget), retries: 0 } });
    if (now() > deadline) throw new Error('deadline');
    return result.data;
  };
  return async (route, args = {}) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(route, args);
      } catch (error) {
        const wait = attempt < READ_ATTEMPTS && isRead(route, args) ? retryDelay(error, attempt) : null;
        if (wait === null || now() + wait >= deadline) throw error;
        await sleep(wait);
      }
    }
  };
}
async function pages(read, route, args, field) {
  const result = [];
  let total;
  for (let page = 1; page <= 2; page++) {
    const data = await read(route, { ...args, page, per_page: 100 });
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.total_count > 200
      || !Array.isArray(data[field]) || data[field].length > 100) throw new Error('incomplete-metadata');
    if (total !== undefined && total !== data.total_count) throw new Error('changing-metadata');
    total = data.total_count;
    result.push(...data[field]);
    if (result.length === total) return result;
    if (result.length > total || data[field].length !== 100) throw new Error('incomplete-metadata');
  }
  throw new Error('incomplete-metadata');
}
const readCiRuns = (read, workflowId, sha, event) => pages(read,
  'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
  { workflow_id: workflowId, head_sha: sha, event }, 'workflow_runs');
const readCiJobs = (read, runId) => pages(read, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
  { run_id: runId, filter: 'latest' }, 'jobs');
function successfulJobs(jobs, names) {
  return names.every(name => {
    const matching = jobs.filter(job => job.name === name);
    return matching.length === 1 && positive(matching[0].id)
      && matching[0].status === 'completed' && matching[0].conclusion === 'success';
  });
}
function skippedSuite(jobs, suite) {
  const matching = jobs.filter(job => job.name === suite.skipped);
  return matching.length === 1 && positive(matching[0].id) && matching[0].status === 'completed'
    && matching[0].conclusion === 'skipped' && !jobs.some(job => suite.shards.includes(job.name));
}
// 'ran' or 'skipped' when the gate is complete, null otherwise. Skipped suites
// count only for a docs-only or infra-only queued commit, as its queue run's
// verify accepted them.
async function completeGate(jobs, run, surfaceOf) {
  if (!successfulJobs(jobs, REQUIRED_QUEUE_JOBS.filter(name => !SUITE_JOBS.includes(name)))) return null;
  const notRun = SUITES.filter(suite => !successfulJobs(jobs, suite.shards));
  if (notRun.length === 0) return 'ran';
  if (!notRun.every(suite => skippedSuite(jobs, suite))) return null;
  const base = QUEUE_BASE.exec(run.head_branch)?.[1];
  return base && surfaceOf && SKIPPABLE_SURFACES.includes(await surfaceOf(base)) ? 'skipped' : null;
}
// The surface of the queued commit, from a main checkout that holds it and its
// parent. Its own parent diff is the group diff only when its first parent is
// the group base, so any other parent, and any failure, is full-matrix. The
// classifier comes from that base: the queued commit cannot vouch for itself.
function mainCommitSurface({ sha, base, cwd = process.cwd(), tmpDir }) {
  try {
    if (!validSha(sha) || !validSha(base)) return 'full-matrix';
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (git('rev-parse', '--verify', '--end-of-options', `${sha}^1`).trim() !== base) return 'full-matrix';
    const classifier = path.join(fs.mkdtempSync(path.join(tmpDir, 'queue-proof-')), 'change-surface.cjs');
    fs.writeFileSync(classifier, git('show', `${base}:.github/scripts/change-surface.cjs`));
    const paths = git('diff', '--name-only', '--no-renames', '-z', base, sha).split('\0').filter(Boolean);
    const surface = execFileSync(process.execPath, [classifier], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
      input: paths.map(file => `${JSON.stringify(file)}\n`).join('') }).trim();
    return SKIPPABLE_SURFACES.includes(surface) ? surface : 'full-matrix';
  } catch {
    return 'full-matrix';
  }
}
const newest = runs => runs.reduce((latest, run) => {
  if (!positive(run?.id)) throw new Error('invalid-run');
  return !latest || run.id > latest.id ? run : latest;
}, null);
function queueRun(run, fullName, workflowId, sha) {
  return positive(run?.id) && positive(run.run_attempt) && run.workflow_id === workflowId && run.path === CI_PATH
    && run.repository?.full_name === fullName && run.head_repository?.full_name === fullName
    && run.head_sha === sha && run.event === 'merge_group'
    && typeof run.head_branch === 'string' && run.head_branch.startsWith('gh-readonly-queue/main/');
}

// The race re-check: the run just verified, and the same run as the newest
// merge-group run for the sha, must still read back completed and successful.
function sameCompletedRun(final, authoritative, run, fullName, workflowId, sha) {
  return queueRun(final, fullName, workflowId, sha) && final.id === run.id && final.run_attempt === run.run_attempt
    && final.status === 'completed' && final.conclusion === 'success'
    && queueRun(authoritative, fullName, workflowId, sha) && authoritative?.id === run.id
    && authoritative.run_attempt === run.run_attempt
    && authoritative.status === 'completed' && authoritative.conclusion === 'success';
}

// One poll iteration: list and read the queue run for sha, then wait while it
// is pending. Returns the completed run, a fallback reason, or nothing after
// a pending wait (the caller polls again).
async function pollQueueRun({ read, fullName, workflowId, sha, poll, deadline, now, sleep }) {
  const listed = newest(await readCiRuns(read, workflowId, sha, 'merge_group'));
  if (!queueRun(listed, fullName, workflowId, sha)) return { reason: 'no-exact-queue-run' };
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: listed.id });
  if (!queueRun(run, fullName, workflowId, sha) || run.id !== listed.id) return { reason: 'source-changed' };
  if (run.status !== 'completed') {
    if (poll === 6 || now() >= deadline) return { reason: 'source-pending' };
    await sleep(Math.min(10000, deadline - now()));
    // No read fits after the deadline, so a run still pending then is the reason.
    return now() >= deadline ? { reason: 'source-pending' } : {};
  }
  return { run };
}

async function queueCiProof({ github, owner, repo, eventName, ref, sha, now = Date.now, sleep = delay, surfaceOf }) {
  const fallback = reason => ({ verified: false, reason });
  if (eventName !== 'push' || ref !== 'refs/heads/main' || !validSha(sha)) return fallback('not-main-push');
  const deadline = now() + 60000;
  const read = reader(github, owner, repo, deadline, now);
  try {
    const workflow = await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { workflow_id: 'ci.yml' });
    if (!positive(workflow?.id) || workflow.path !== CI_PATH || workflow.state !== 'active') return fallback('workflow-unavailable');
    const fullName = `${owner}/${repo}`;
    for (let poll = 0; poll < 7; poll++) {
      const step = await pollQueueRun({ read, fullName, workflowId: workflow.id, sha, poll, deadline, now, sleep });
      if (step.reason) return fallback(step.reason);
      if (!step.run) continue;
      const run = step.run;
      if (run.conclusion !== 'success') return fallback('source-not-successful');
      const jobs = await readCiJobs(read, run.id);
      const suites = await completeGate(jobs, run, surfaceOf);
      if (!suites) return fallback('incomplete-gate');
      const final = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: run.id });
      const authoritative = newest(await readCiRuns(read, workflow.id, sha, 'merge_group'));
      if (!sameCompletedRun(final, authoritative, run, fullName, workflow.id, sha)) return fallback('source-changed');
      return { verified: true, runId: run.id, attempt: run.run_attempt, sha, suites,
        url: `https://github.com/${fullName}/actions/runs/${run.id}/attempts/${run.run_attempt}` };
    }
    return fallback('source-pending');
  } catch {
    // API errors may contain headers/signed URLs. Missing proof only costs CI.
    return fallback('proof-unavailable');
  }
}
module.exports = { queueCiProof, mainCommitSurface, requiredQueueJobs, REQUIRED_QUEUE_JOBS, SUITE_JOBS, SKIPPED_SUITE_JOBS, VERIFY, REVIEW, CI_PATH,
  validSha, positive, reader, pages, readCiRuns, readCiJobs, successfulJobs, newest };
