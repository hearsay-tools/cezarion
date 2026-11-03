'use strict';
const { positive, validSha } = require('./queue-ci-proof.cjs');
const SIGNAL_PATH = '.github/workflows/coderabbit-review-signal.yml';
function signalRun(run, workflow, fullName) {
  return positive(run?.id) && positive(run.run_attempt) && run.workflow_id === workflow.id
    && run.path === SIGNAL_PATH && run.repository?.full_name === fullName
    && run.head_repository?.full_name === fullName && run.status === 'completed'
    && ['pull_request_review', 'pull_request_review_comment'].includes(run.event);
}
function associationTarget(run) {
  if (!positive(run.repository?.id) || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) return null;
  const pr = run.pull_requests[0];
  if (!positive(pr?.number) || !validSha(pr.head?.sha) || pr.base?.ref !== 'main'
    || pr.base.repo?.id !== run.repository.id || pr.head.repo?.id !== run.repository.id) return null;
  return { number: pr.number, head: pr.head.sha };
}
async function signalTarget(read, payload, fullName) {
  const source = payload.workflow_run;
  if (payload.action !== 'completed' || source?.name !== 'CodeRabbit review signal'
    || !positive(source.id) || !positive(source.run_attempt)) return null;
  const workflow = await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', { workflow_id: 'coderabbit-review-signal.yml' });
  if (!positive(workflow?.id) || workflow.path !== SIGNAL_PATH || workflow.state !== 'active') return null;
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: source.id });
  if (!signalRun(run, workflow, fullName) || run.id !== source.id || run.run_attempt !== source.run_attempt
    || run.head_sha !== source.head_sha || run.event !== source.event) return null;
  // Signal merge SHA is not the PR head. Official association identifies only
  // a candidate; every consumer must read live admission independently.
  return associationTarget(run);
}
module.exports = { signalTarget, SIGNAL_PATH };
