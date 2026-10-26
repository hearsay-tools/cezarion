'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const CI_PATH = '.github/workflows/ci.yml';
const VERIFY = 'Unit, build, E2E, and package';
const REVIEW = 'Automated Code Review';
// Workflow parity tests expand matrices and compare this complete roster.
const REQUIRED_QUEUE_JOBS = [
  'Classify pull request change surface', 'Classify PR shape', 'Check function complexity', 'Typecheck, unit, build, and package',
  ...[1, 2, 3].map(n => `Vitest shard ${n}/3`),
  ...[1, 2, 3, 4].map(n => `Cockpit browser E2E shard ${n}/4`), VERIFY, REVIEW, 'Validate reviewed queue entry',
];
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
function reader(github, owner, repo, deadline, now) {
  return async (route, args = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('deadline');
    const result = await github.request(route, { owner, repo, ...args,
      request: { timeout: Math.min(10000, remaining), retries: 0 } });
    if (now() > deadline) throw new Error('deadline');
    return result.data;
  };
}
async function pages(read, route, args, field) {
  const result = [];
  let total;
  for (let page = 1; page <= 2; page++) {
    const data = await read(route, { ...args, page, per_page: 100 });
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.total_count > 200
      || !Array.isArray(data[field])) throw new Error('incomplete-metadata');
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
async function queueCiProof({ github, owner, repo, eventName, ref, sha, now = Date.now, sleep = delay }) {
  const fallback = reason => ({ verified: false, reason });
  if (eventName !== 'push' || ref !== 'refs/heads/main' || !validSha(sha)) return fallback('not-main-push');
  const deadline = now() + 60000;
  const read = reader(github, owner, repo, deadline, now);
  try {
    const workflow = await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { workflow_id: 'ci.yml' });
    if (!positive(workflow?.id) || workflow.path !== CI_PATH || workflow.state !== 'active') return fallback('workflow-unavailable');
    const fullName = `${owner}/${repo}`;
    for (let poll = 0; poll < 7; poll++) {
      const listed = newest(await readCiRuns(read, workflow.id, sha, 'merge_group'));
      if (!queueRun(listed, fullName, workflow.id, sha)) return fallback('no-exact-queue-run');
      const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: listed.id });
      if (!queueRun(run, fullName, workflow.id, sha) || run.id !== listed.id) return fallback('source-changed');
      if (run.status !== 'completed') {
        if (poll === 6 || now() >= deadline) return fallback('source-pending');
        await sleep(Math.min(10000, deadline - now()));
        continue;
      }
      if (run.conclusion !== 'success') return fallback('source-not-successful');
      const jobs = await readCiJobs(read, run.id);
      if (!successfulJobs(jobs, REQUIRED_QUEUE_JOBS)) return fallback('incomplete-gate');
      const final = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: run.id });
      const authoritative = newest(await readCiRuns(read, workflow.id, sha, 'merge_group'));
      if (!queueRun(final, fullName, workflow.id, sha) || final.id !== run.id || final.run_attempt !== run.run_attempt
        || final.status !== 'completed' || final.conclusion !== 'success'
        || !queueRun(authoritative, fullName, workflow.id, sha) || authoritative?.id !== run.id || authoritative.run_attempt !== run.run_attempt
        || authoritative.status !== 'completed' || authoritative.conclusion !== 'success') return fallback('source-changed');
      return { verified: true, runId: run.id, attempt: run.run_attempt, sha,
        url: `https://github.com/${fullName}/actions/runs/${run.id}/attempts/${run.run_attempt}` };
    }
    return fallback('source-pending');
  } catch {
    // API errors may contain headers/signed URLs. Missing proof only costs CI.
    return fallback('proof-unavailable');
  }
}
module.exports = { queueCiProof, REQUIRED_QUEUE_JOBS, VERIFY, REVIEW, CI_PATH, validSha, positive,
  reader, readCiRuns, readCiJobs, successfulJobs, newest };
