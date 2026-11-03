'use strict';
const { CI_PATH, VERIFY, REVIEW, reader, positive, readCiRuns, readCiJobs, newest, successfulJobs } = require('./queue-ci-proof.cjs');
function pullAssociation(run, pr) {
  if (!Array.isArray(run.pull_requests)) return false;
  return run.pull_requests.some(p => p.number === pr.number
    && p.head?.sha === pr.head.sha && p.base?.ref === 'main');
}
function nativeRun(run, fullName, workflowId, pr) {
  return positive(run?.id) && positive(run.run_attempt) && run.workflow_id === workflowId && run.path === CI_PATH
    && run.event === 'pull_request_target' && run.repository?.full_name === fullName
    && run.head_repository?.full_name === pr.head.repo.full_name && run.head_sha === pr.head.sha
    && run.head_branch === pr.head.ref && pullAssociation(run, pr);
}
function requireSameRun(candidate, run, fullName, workflowId, pr) {
  if (!nativeRun(candidate, fullName, workflowId, pr) || candidate.id !== run.id || candidate.run_attempt !== run.run_attempt
    || candidate.status !== run.status || candidate.conclusion !== run.conclusion) throw new Error('Native CI changed');
}
async function readNativeReview({ github, owner, repo, pr, now = Date.now, deadline = now() + 60000 }) {
  const read = reader(github, owner, repo, deadline, now), fullName = `${owner}/${repo}`;
  if (pr?.state !== 'open' || pr.base?.ref !== 'main' || pr.base.repo?.full_name !== fullName) throw new Error('Invalid PR target');
  const workflow = await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { workflow_id: 'ci.yml' });
  if (!positive(workflow?.id) || workflow.path !== CI_PATH || workflow.state !== 'active') throw new Error('CI workflow unavailable');
  const listed = newest(await readCiRuns(read, workflow.id, pr.head.sha, 'pull_request_target'));
  if (!nativeRun(listed, fullName, workflow.id, pr)) throw new Error('No current native CI');
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: listed.id });
  if (!nativeRun(run, fullName, workflow.id, pr) || run.id !== listed.id || run.run_attempt !== listed.run_attempt) {
    throw new Error('Native CI changed');
  }
  const jobs = await readCiJobs(read, run.id);
  const final = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: run.id });
  const latest = newest(await readCiRuns(read, workflow.id, pr.head.sha, 'pull_request_target'));
  for (const candidate of [final, latest]) {
    requireSameRun(candidate, run, fullName, workflow.id, pr);
  }
  return { run, jobs, passed: successfulJobs(jobs, [VERIFY, REVIEW]) };
}
module.exports = { readNativeReview, nativeRun };
