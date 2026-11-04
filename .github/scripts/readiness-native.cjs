'use strict';
const { REVIEW, VERIFY, positive, successfulJobs, reader } = require('./queue-ci-proof.cjs');
const WAIT_STEP = 'Require fresh CodeRabbit admission and resolved threads';
const TIMEOUT_NOTICE = 'CodeRabbit admission blocked: provider-wait-timeout. CodeRabbit did not settle within the 20-minute review wait. Inspect the provider check; reconciliation can retry after it completes. The reconciler refreshes this job after provider/CI/review events. For eventless thread resolution, dispatch Reconcile CodeRabbit admission with pr_number.';

function reviewOnlyBlock(checks) {
  return ['pending', 'failing', 'missing'].every(kind => checks[kind].every(name => name === REVIEW));
}
function waitingJob(job) {
  if (!['queued', 'in_progress'].includes(job.status) || job.conclusion != null) return false;
  const steps = job.steps;
  if (!Array.isArray(steps)) return false;
  return steps.every(step => ['queued', 'in_progress'].includes(step.status)
    || (step.status === 'completed' && ['success', 'skipped'].includes(step.conclusion)));
}
function timeoutJob(job) {
  if (job.status !== 'completed' || job.conclusion !== 'failure' || !Array.isArray(job.steps)) return false;
  const failed = job.steps.filter(step => step.conclusion === 'failure');
  return failed.length === 1 && failed[0].name === WAIT_STEP && failed[0].status === 'completed'
    && job.steps.every(step => step.status === 'completed' && ['success', 'skipped', 'failure'].includes(step.conclusion));
}
async function retainedNativeReview({ github, owner, repo, proof, checks, admission, deadline }) {
  if (!admission.retained || !reviewOnlyBlock(checks)
    || !successfulJobs(proof.jobs, [VERIFY, 'Review preflight'])) return false;
  const jobs = proof.jobs.filter(job => job.name === REVIEW);
  if (jobs.length !== 1 || !positive(jobs[0].id)) return false;
  const job = jobs[0];
  if (waitingJob(job)) return true;
  if (!timeoutJob(job)) return false;
  const prefix = `https://api.github.com/repos/${owner}/${repo}/check-runs/`;
  if (typeof job.check_run_url !== 'string' || !job.check_run_url.startsWith(prefix)) return false;
  const checkId = Number(job.check_run_url.slice(prefix.length));
  if (!positive(checkId)) return false;
  const read = reader(github, owner, repo, deadline, Date.now);
  // One page suffices only when every annotation fits; a full page is ambiguous.
  const annotations = await read('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations',
    { check_run_id: checkId, per_page: 100, page: 1 });
  return Array.isArray(annotations) && annotations.length === 1
    && annotations[0].annotation_level === 'notice' && annotations[0].message === TIMEOUT_NOTICE;
}
module.exports = { retainedNativeReview };
