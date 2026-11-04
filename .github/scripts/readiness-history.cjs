'use strict';
// The trusted readiness job installs no packages. The graph test pins this
// dependency-free snapshot, including the result-checking step, to ci.yml.
const graph = require('./readiness-graph.json');
const { REVIEW, reader, pages, positive, successfulJobs } = require('./queue-ci-proof.cjs');

function dependentJobs(nodes = graph) {
  const result = new Set(['review-result']);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, job] of Object.entries(nodes)) {
      if (!result.has(id) && job.needs.some(parent => result.has(parent))) {
        result.add(id); changed = true;
      }
    }
  }
  return result;
}
function namesFor(id, job) {
  if (id === 'review-result') return [REVIEW];
  let names = [job.name, job.name.replace(/^\$\{\{\s*|\s*\}\}$/g, '')];
  for (const [axis, values] of Object.entries(job.matrix ?? {})) {
    names = names.flatMap(name => values.map(value => name.replace(`\${{ matrix.${axis} }}`, String(value))));
  }
  return [...new Set([job.name, ...names])];
}
const toleratedNames = new Set([...dependentJobs()].flatMap(id => namesFor(id, graph[id])));
const knownNames = new Set(Object.entries(graph).flatMap(([id, job]) => namesFor(id, job)));

function sameAttempt(run, current, head, attempt) {
  return run.id === current.id && run.head_sha === head && run.run_attempt === attempt && run.status === 'completed'
    && ['workflow_id', 'path', 'event', 'head_branch'].every(key => run[key] === current[key])
    && run.repository?.full_name === current.repository?.full_name
    && run.head_repository?.full_name === current.head_repository?.full_name;
}
async function completedReviewAt(read, runId, attempt, head) {
  for (let prior = attempt; prior >= 1; prior--) {
    const jobs = await pages(read, 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
      { run_id: runId, attempt_number: prior }, 'jobs');
    if (jobs.some(job => job.head_sha !== head || job.run_attempt !== prior)) return false;
    if (jobs.some(job => job.name === REVIEW)) return successfulJobs(jobs, [REVIEW]);
  }
  return false;
}
async function admittedAttempt(read, proof, head) {
  for (let attempt = proof.run.run_attempt - 1; attempt >= 1; attempt--) {
    const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',
      { run_id: proof.run.id, attempt_number: attempt });
    if (!sameAttempt(run, proof.run, head, attempt)) return null;
    if (run.conclusion !== 'success') continue;
    // Partial reruns carry successful jobs from earlier attempts. Walk back to
    // the most recent review execution at or before this successful attempt.
    if (!await completedReviewAt(read, run.id, attempt, head)) return null;
    return attempt;
  }
  return null;
}
function unchangedIndependentJobs(jobs, attempt, head) {
  return jobs.every(job => {
    if (!knownNames.has(job.name) || !positive(job.id) || job.head_sha !== head) return false;
    if (toleratedNames.has(job.name)) return true;
    return positive(job.run_attempt) && job.run_attempt <= attempt && job.status === 'completed'
      && ['success', 'skipped'].includes(job.conclusion);
  });
}
function blockedDependents(jobs, timeout) {
  return jobs.filter(job => toleratedNames.has(job.name) && job.name !== REVIEW).every(job => {
    if (['queued', 'in_progress'].includes(job.status)) return job.conclusion == null;
    if (job.status !== 'completed') return false;
    if (['success', 'skipped'].includes(job.conclusion)) return true;
    if (!timeout || job.conclusion !== 'failure' || !Array.isArray(job.steps)) return false;
    // This existing aggregate step checks REVIEW_RESULT before executing any
    // remaining verification. Its trusted definition is pinned by the test.
    const failed = job.steps.filter(step => step.conclusion === 'failure');
    const gate = Object.entries(graph).find(([id, node]) => namesFor(id, node).includes(job.name))?.[1].reviewResultGate;
    return failed.length === 1 && gate && failed[0].name === gate.name
      && job.steps.every(step => ['success', 'skipped', 'failure'].includes(step.conclusion));
  });
}
async function retainedHistory({ github, owner, repo, proof, checks, admission, deadline, timeout }) {
  if (!['pending', 'failing', 'missing'].every(kind => checks[kind].every(name => toleratedNames.has(name)))) return false;
  if (!blockedDependents(proof.jobs, timeout)) return false;
  const read = reader(github, owner, repo, deadline, Date.now);
  const attempt = await admittedAttempt(read, proof, admission.head);
  return attempt !== null && unchangedIndependentJobs(proof.jobs, attempt, admission.head);
}
module.exports = { dependentJobs, namesFor, retainedHistory };
