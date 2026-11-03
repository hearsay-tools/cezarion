'use strict';
const { pages, positive, validSha } = require('./queue-ci-proof.cjs');
const CLAIM_NAME = 'CodeRabbit full-review recovery';
const ACTIONS_APP = 15368;
const claimKey = (number, head) => `coderabbit-full-review:v1:${number}:${head}`;
const inspect = message => new Error(`${message}. Inspect recovery checks and PR comments before any manual @coderabbitai full review; no automatic resend.`);
function trustedRun(run, fullName, runId) {
  return run?.id === runId && run.repository?.full_name === fullName && run.head_repository?.full_name === fullName
    && run.path === '.github/workflows/coderabbit-reconcile.yml' && run.head_branch === 'main'
    && ['check_run', 'workflow_run', 'workflow_dispatch'].includes(run.event);
}
function validateClaim(check, number, head) {
  if (!positive(check?.id) || check.name !== CLAIM_NAME || check.head_sha !== head
    || check.app?.id !== ACTIONS_APP || check.app.slug !== 'github-actions'
    || check.external_id !== claimKey(number, head)) throw inspect('Unknown recovery claim ownership');
  // These checks only suppress sends. App identity and caller-supplied URL/key
  // cannot prove which workflow created an existing check, or authorize a send.
}
async function claims(read, number, head) {
  const checks = await pages(read, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
    { ref: head, filter: 'all', check_name: CLAIM_NAME }, 'check_runs');
  const found = [];
  if (new Set(checks.map(c => c?.id)).size !== checks.length) throw inspect('Duplicate recovery check IDs');
  for (const check of checks) {
    const key = /^coderabbit-full-review:v1:([1-9][0-9]*):([a-f0-9]{40})$/.exec(check?.external_id ?? '');
    if (!key || !positive(Number(key[1])) || key[2] !== head || check.name !== CLAIM_NAME) throw inspect('Malformed recovery inventory');
    if (Number(key[1]) !== number) continue;
    validateClaim(check, number, head);
    found.push(check);
  }
  return found;
}
async function reserve({ read, fullName, number, head, runId, inspectionDue }) {
  if (!positive(number) || !validSha(head) || !positive(runId)) throw inspect('Invalid recovery identity');
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: runId });
  if (!trustedRun(run, fullName, runId)) throw inspect('Recovery must run from the trusted main workflow');
  let check;
  try {
    check = await read('POST /repos/{owner}/{repo}/check-runs', { name: CLAIM_NAME, head_sha: head,
      external_id: claimKey(number, head), details_url: `https://github.com/${fullName}/actions/runs/${runId}`,
      status: 'completed', conclusion: 'neutral', output: { title: 'claimed',
        summary: `One automatic full-review attempt is reserved. A crash before send may leave no command. Inspection due: ${inspectionDue}. If no provider execution appears, a maintainer must inspect PR comments and provider. No timer resends.` } });
    validateClaim(check, number, head);
    const visible = await claims(read, number, head);
    if (visible.length !== 1 || visible[0].id !== check.id) throw inspect('Recovery claim not uniquely visible');
  } catch { throw inspect('Recovery reservation outcome is uncertain; no comment was sent'); }
  return check;
}
async function record(read, check, state, summary, log) {
  try {
    await read('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', { check_run_id: check.id,
      status: 'completed', conclusion: 'neutral',
      output: { title: state, summary } });
  } catch { log(`Recovery claim ${check.id}: diagnostic update failed; reservation still blocks automatic resend.`); }
}
module.exports = { CLAIM_NAME, ACTIONS_APP, claimKey, claims, reserve, record, inspect };
