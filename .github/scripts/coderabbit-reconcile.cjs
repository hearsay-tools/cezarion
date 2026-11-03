'use strict';
// Trusted control plane: read live evidence, rerun one native job. Never check out
// PR code, request a model review, post findings or dispatch the CI workflow.
const { setTimeout: delay } = require('node:timers/promises');
const { reader, positive, validSha, REVIEW, successfulJobs } = require('./queue-ci-proof.cjs');
const { readCodeRabbitAdmission, trustedCheck } = require('./coderabbit-admission.cjs');
const { readNativeReview } = require('./native-review-proof.cjs');
const { signalTarget } = require('./review-signal.cjs');
const TARGET_LIMIT = 4;
const recovery = reason => new Error(`${reason}; dispatch with pr_number for manual recovery`);
function associationNumbers(pulls) {
  if (!Array.isArray(pulls) || pulls.length > TARGET_LIMIT
    || pulls.some(pr => !positive(pr?.number) || !validSha(pr.head?.sha) || typeof pr.base?.ref !== 'string')) {
    throw recovery('Malformed or oversized PR association');
  }
  return [...new Set(pulls.map(pr => pr.number))];
}
async function openPulls(read) {
  const pulls = [];
  for (let page = 1; page <= 2; page++) {
    const rows = await read('GET /repos/{owner}/{repo}/pulls', { state: 'open', base: 'main', page, per_page: 100 });
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('Malformed open PR listing');
    pulls.push(...rows);
    if (rows.length < 100) return pulls;
  }
  throw recovery('Open PR pagination limit');
}
async function checkTarget(read, payload) {
  if (!['created', 'completed'].includes(payload.action) || !trustedCheck(payload.check_run)
    || !positive(payload.check_run.id) || !validSha(payload.check_run.head_sha)) return null;
  const check = await read('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', { check_run_id: payload.check_run.id });
  if (!trustedCheck(check) || check.id !== payload.check_run.id || check.head_sha !== payload.check_run.head_sha) return null;
  const numbers = associationNumbers(check.pull_requests);
  return numbers.length ? { numbers } : { head: check.head_sha };
}
async function workflowTarget(read, payload, fullName) {
  const source = payload.workflow_run;
  if (payload.action !== 'completed' || source?.name !== 'CI' || source.event !== 'pull_request_target'
    || !positive(source.id) || !positive(source.run_attempt)) return null;
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: source.id });
  if (run.id !== source.id || run.run_attempt !== source.run_attempt || run.status !== 'completed'
    || run.event !== 'pull_request_target' || run.path !== '.github/workflows/ci.yml'
    || run.repository?.full_name !== fullName || run.head_sha !== source.head_sha) return null;
  const numbers = associationNumbers(run.pull_requests);
  if (!numbers.length) throw recovery('Missing native CI PR association');
  return { numbers };
}
async function eventTarget(read, eventName, payload, fullName) {
  if (payload.repository?.full_name !== fullName) throw new Error('Foreign event');
  if (eventName === 'workflow_dispatch') {
    const number = Number(payload.inputs?.pr_number);
    if (!positive(number)) throw new Error('pr_number must be a positive integer');
    return { numbers: [number] };
  }
  if (eventName === 'check_run') return checkTarget(read, payload);
  if (eventName === 'workflow_run') {
    if (payload.workflow_run?.name !== 'CodeRabbit review signal') return workflowTarget(read, payload, fullName);
    const signal = await signalTarget(read, payload, fullName);
    return signal ? { numbers: [signal.number] } : null;
  }
  return null;
}
async function observeRerun(read, run, now, sleep, deadline) {
  // bound: do not release the workflow's serialization lock until the accepted
  // rerun is visible. Never repeat an ambiguous POST within this execution.
  const until = Math.min(deadline, now() + 30000);
  for (let poll = 0; poll < 7; poll++) {
    const live = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: run.id });
    if (live.run_attempt > run.run_attempt || live.status !== 'completed') return;
    if (now() >= until || poll === 6) break;
    await sleep(Math.min(5000, until - now()));
  }
  throw new Error('Rerun acceptance not yet visible. Inspect the native run before any manual retry; no automatic write retry was made.');
}
function unchangedJob(proof, final, job) {
  const finalJob = reviewJob(final);
  return final.run.id === proof.run.id && final.run.run_attempt === proof.run.run_attempt
    && finalJob?.id === job.id && finalJob.conclusion === job.conclusion;
}
function sameLivePull(live, pr, fullName) {
  return live.state === 'open' && live.head?.sha === pr.head.sha && live.base?.ref === 'main'
    && live.head.repo?.full_name === fullName && live.base.repo?.full_name === fullName;
}
const GATE_STEP = 'Require fresh CodeRabbit admission and resolved threads';
function currentGate(proof) {
  return !proof.run.referenced_workflows?.some(w => w.path?.includes('/automated-code-review.yml@'))
    && proof.jobs.some(j => j.name === REVIEW && j.steps?.some(step => step.name === GATE_STEP));
}
function reviewJob(proof) {
  const matches = proof.jobs.filter(j => j.name === REVIEW);
  if (matches.length !== 1 || !positive(matches[0].id) || matches[0].status !== 'completed'
    || !['success', 'failure'].includes(matches[0].conclusion)
    || !successfulJobs(proof.jobs, ['Review preflight'])) return null;
  return matches[0];
}
function rerunnable(run, now) {
  const created = Date.parse(run.created_at);
  return run.status === 'completed' && run.run_attempt < 50 && Number.isFinite(created)
    && now - created >= 0 && now - created < 30 * 86400000;
}
async function nativeProof(args, pr, log) {
  try { return await readNativeReview({ ...args, pr }); }
  catch {
    log(`PR ${pr.number}: native evidence unavailable or changed; skipped this PR.`);
    return null;
  }
}
async function reconcilePull({ github, owner, repo, pr, releaseAppBotLogin, now, deadline, sleep, log }) {
  const args = { github, owner, repo, now, deadline };
  const proof = await nativeProof(args, pr, log);
  if (!proof) return 'native-evidence-unavailable';
  if (!currentGate(proof)) {
    log(`PR ${pr.number}: native CI uses an older review policy. Push a new head or start a new native run after rollout; targeted retries cannot replace its definition.`);
    return 'legacy-workflow';
  }
  const job = reviewJob(proof);
  if (!job) return 'job-not-completed-or-preflight-failed';
  const admission = () => readCodeRabbitAdmission({ ...args, pullNumber: pr.number, head: pr.head.sha, releaseAppBotLogin });
  // A failed reader cannot authorize anything. Rerun a historical green to make
  // its native gate fail closed too; never turn an API error into an approval.
  const desired = async () => { try { return (await admission()).admitted; } catch { return false; } };
  const admitted = await desired();
  if (admitted === (job.conclusion === 'success')) return 'unchanged';
  if (!rerunnable(proof.run, now())) {
    log(`PR ${pr.number}: native CI cannot rerun (30 days / 50 attempts / active run). Repair CI or push a new head; no dispatch fallback.`);
    return 'rerun-unavailable';
  }
  if (await desired() !== admitted) return 'changed';
  const final = await nativeProof(args, pr, log);
  if (!final) return 'native-evidence-unavailable';
  if (!unchangedJob(proof, final, job)) return 'changed';
  const read = reader(github, owner, repo, deadline, now);
  let live;
  try { live = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number }); }
  catch { return 'pull-evidence-unavailable'; }
  if (!sameLivePull(live, pr, `${owner}/${repo}`)) return 'changed';
  // No retry: a timeout can mean GitHub accepted the write. A later event reads
  // the authoritative attempt before deciding again. Per-PR concurrency
  // serializes this workflow's writes; external manual reruns remain observable.
  let ambiguous = false;
  try { await read('POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun', { job_id: job.id }); }
  catch { ambiguous = true; }
  // A timeout can hide an accepted write. Keep serialization while observing
  // both successful and ambiguous responses; neither path retries the POST.
  try { await observeRerun(read, proof.run, now, sleep, deadline); }
  catch {
    throw new Error('Rerun acceptance not yet visible. Inspect the native run before further retries; this execution made one POST and cannot prove its outcome.');
  }
  if (ambiguous) log(`PR ${pr.number}: targeted rerun became visible after an ambiguous API response.`);
  log(`PR ${pr.number}: rerun native review job ${job.id}, run ${proof.run.id}, attempt ${proof.run.run_attempt}; admission=${admitted}.`);
  return 'rerun-requested';
}
function eligiblePull(pr, fullName) {
  return positive(pr?.number) && pr.state === 'open' && validSha(pr.head?.sha)
    && typeof pr.head.ref === 'string' && pr.head.repo?.full_name === fullName
    && pr.base?.ref === 'main' && pr.base.repo?.full_name === fullName;
}
async function discover({ github, owner, repo, eventName, payload, now = Date.now, log = () => {} }) {
  const deadline = now() + 120000, read = reader(github, owner, repo, deadline, now);
  const target = await eventTarget(read, eventName, payload, `${owner}/${repo}`);
  if (!target) return { numbers: [] };
  // Discovery runs independently for each event. Carry only associated stable
  // numbers; old events never select a historical head or native proof.
  const fullName = `${owner}/${repo}`;
  const candidates = target.numbers ?? [...new Set((await openPulls(read))
    .filter(pr => eligiblePull(pr, fullName) && pr.head.sha === target.head).map(pr => pr.number))];
  if (candidates.length > TARGET_LIMIT) throw recovery('Too many matching PR targets');
  const numbers = [];
  for (const number of candidates) {
    const pr = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: number });
    if (pr?.number !== number || !eligiblePull(pr, fullName) || (target.head && pr.head.sha !== target.head)) {
      log('Skipped changed or ineligible PR; forks require a maintainer native review rerun.');
      continue;
    }
    numbers.push(number);
  }
  return { numbers };
}
async function reconcile({ github, owner, repo, pullNumber, releaseAppBotLogin,
  now = Date.now, sleep = delay, log = () => {} }) {
  if (!positive(pullNumber)) throw new Error('Missing trusted discovery PR number');
  const deadline = now() + 120000, read = reader(github, owner, repo, deadline, now);
  const pr = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
  if (pr?.number !== pullNumber || !eligiblePull(pr, `${owner}/${repo}`)) return 'ineligible';
  // The admitted event is only a wake hint. Queue only PR identity, then prove
  // the newest live head/run at the lock head; never carry historical proof.
  return reconcilePull({ github, owner, repo, pr,
    releaseAppBotLogin, now, deadline, sleep, log });
}
module.exports = { discover, reconcile, eventTarget, eligiblePull, reviewJob, rerunnable, GATE_STEP };
