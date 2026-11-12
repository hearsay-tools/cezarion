'use strict';
// Trusted control plane: read live evidence once per PR, rerun one native job and
// sync the board. Never check out PR code, request a model review, post findings
// or dispatch the CI workflow.
const { setTimeout: delay } = require('node:timers/promises');
const { reader, positive, validSha, REVIEW, successfulJobs } = require('./queue-ci-proof.cjs');
const { readCodeRabbitAdmission, trustedCheck } = require('./coderabbit-admission.cjs');
const { readNativeReview } = require('./native-review-proof.cjs');
const { signalTarget } = require('./review-signal.cjs');
const { readHeadChecks, reviewCheckCompleted, boardStatus, syncBoard } = require('./pr-readiness.cjs');
const TARGET_LIMIT = 4;
const PULL_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft']);
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
  if (eventName === 'pull_request_target') {
    const number = payload.pull_request?.number;
    return PULL_ACTIONS.has(payload.action) && positive(number) ? { numbers: [number] } : null;
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
const EXECUTION_GATE_STEP = 'Require fresh CodeRabbit execution and resolved threads';
function gatePolicy(proof) {
  if (proof.run.referenced_workflows?.some(w => w.path?.includes('/automated-code-review.yml@'))) return null;
  const steps = proof.jobs.find(j => j.name === REVIEW)?.steps;
  if (steps?.some(step => step.name === GATE_STEP)) return 'admission';
  return steps?.some(step => step.name === EXECUTION_GATE_STEP) ? 'execution-only' : null;
}
function refuseLegacy(pr, log) {
  log(`PR ${pr.number}: native CI uses an older review policy. Push a new head or start a new native run after rollout; targeted retries cannot replace its definition.`);
  return 'legacy-workflow';
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
// The native job and policy a targeted rerun would act on, or why none can.
function nativeDecision(proof, pr, log) {
  if (!proof) return { outcome: 'native-evidence-unavailable' };
  const policy = gatePolicy(proof);
  if (!policy) return { outcome: refuseLegacy(pr, log) };
  const job = reviewJob(proof);
  if (!job) return { outcome: 'job-not-completed-or-preflight-failed' };
  // An immutable success-only reader can revoke shared rejections, but cannot
  // promote a failed historical job under the newer no-files admission policy.
  if (policy === 'execution-only' && job.conclusion !== 'success') return { outcome: refuseLegacy(pr, log) };
  return { policy, job };
}
// Current-policy read failures still revoke green. Historical jobs need a
// validated rejection: an error alone cannot prove that their reader fails.
const desiredAdmission = (evidence, policy) => evidence.error ? (policy === 'admission' ? false : null) : evidence.result.admitted;
async function readAdmission(admission) {
  try { return { result: await admission() }; }
  catch (error) { return { error }; }
}
async function rerunIfChanged({ args, read, write, owner, repo, pr, proof, policy, job, first, admission, now, sleep, log }) {
  const admitted = desiredAdmission(first, policy);
  if (admitted === null) return 'review-evidence-unavailable';
  if (admitted === (job.conclusion === 'success')) return 'unchanged';
  if (!rerunnable(proof.run, now())) {
    log(`PR ${pr.number}: native CI cannot rerun (30 days / 50 attempts / active run). Repair CI or push a new head; no dispatch fallback.`);
    return 'rerun-unavailable';
  }
  if (desiredAdmission(await readAdmission(admission), policy) !== admitted) return 'changed';
  const final = await nativeProof(args, pr, log);
  if (!final) return 'native-evidence-unavailable';
  if (gatePolicy(final) !== policy || !unchangedJob(proof, final, job)) return 'changed';
  let live;
  try { live = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number }); }
  catch { return 'pull-evidence-unavailable'; }
  if (!sameLivePull(live, pr, `${owner}/${repo}`)) return 'changed';
  // No retry: a timeout can mean GitHub accepted the write. A later event reads
  // the authoritative attempt before deciding again. Per-PR concurrency
  // serializes this workflow's writes; external manual reruns remain observable.
  let ambiguous = false;
  try { await write('POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun', { job_id: job.id }); }
  catch { ambiguous = true; }
  // A timeout can hide an accepted write. Keep serialization while observing
  // both successful and ambiguous responses; neither path retries the POST.
  try { await observeRerun(read, proof.run, now, sleep, args.deadline); }
  catch {
    throw new Error('Rerun acceptance not yet visible. Inspect the native run before further retries; this execution made one POST and cannot prove its outcome.');
  }
  if (ambiguous) log(`PR ${pr.number}: targeted rerun became visible after an ambiguous API response.`);
  log(`PR ${pr.number}: rerun native review job ${job.id}, run ${proof.run.id}, attempt ${proof.run.run_attempt}; admission=${admitted}.`);
  return 'rerun-requested';
}
// One read of native proof and admission serves both the rerun and the board.
// Each read happens only when its result can change a decision.
async function reconcilePull({ github, read, write, owner, repo, pr, checks, board, releaseAppBotLogin, now, deadline, sleep, log }) {
  const args = { github, owner, repo, now, deadline };
  // Before any review check run on the head completes, the native job cannot be
  // complete and no required check set can be green. Unreadable checks read on.
  const reviewDone = !checks || reviewCheckCompleted(checks.checkRuns);
  const proof = reviewDone ? await nativeProof(args, pr, log) : null;
  const native = reviewDone ? nativeDecision(proof, pr, log) : { outcome: 'job-not-completed-or-preflight-failed' };
  const boardNeedsAdmission = Boolean(board && checks?.ready && proof?.passed);
  const admission = () => readCodeRabbitAdmission({ ...args, pullNumber: pr.number, head: pr.head.sha, releaseAppBotLogin });
  const first = native.job || boardNeedsAdmission ? await readAdmission(admission) : null;
  if (first?.error) log(`PR ${pr.number}: fresh review admission unavailable.`);
  const outcome = native.job
    ? await rerunIfChanged({ args, read, write, owner, repo, pr, proof, ...native, first, admission, now, sleep, log })
    : native.outcome;
  return { outcome, admitted: Boolean(boardNeedsAdmission && first?.result?.admitted) };
}
async function headChecks(read, pr, log) {
  try { return await readHeadChecks(read, pr.head.sha); }
  catch {
    log(`PR ${pr.number}: required checks unavailable; board sync skipped.`);
    return null;
  }
}
// A final read refuses a stale board move when the head, state or target
// changed while this job read. Without a project token it is not needed.
async function followBoard({ read, projectGithub, owner, repo, pr, checks, admitted, log }) {
  if (!checks) return;
  const sync = status => syncBoard({ projectGithub, owner, repo, pullNumber: pr.number, status, log });
  if (!projectGithub) return sync(boardStatus({ checks, admitted, draft: pr.draft }));
  let final;
  try { final = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number }); }
  catch {
    log(`PR ${pr.number}: board sync skipped: the final PR read failed.`);
    return;
  }
  if (!sameLivePull(final, pr, `${owner}/${repo}`)) return;
  const status = boardStatus({ checks, admitted, draft: final.draft });
  log(`PR ${final.number}: board follows ${status} (admitted=${checks.ready && admitted}, draft=${final.draft}).`);
  return sync(status);
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
// `github` (GITHUB_TOKEN) makes the one targeted rerun write; `readGithub`
// (the release App when available) makes every read; `projectGithub` syncs the board.
async function reconcile({ github, readGithub = github, projectGithub = null, owner, repo, pullNumber, releaseAppBotLogin,
  now = Date.now, sleep = delay, log = () => {} }) {
  if (!positive(pullNumber)) throw new Error('Missing trusted discovery PR number');
  const deadline = now() + 120000, read = reader(readGithub, owner, repo, deadline, now);
  const pr = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
  if (pr?.number !== pullNumber || !eligiblePull(pr, `${owner}/${repo}`)) return 'ineligible';
  // The admitted event is only a wake hint. Queue only PR identity, then prove
  // the newest live head/run at the lock head; never carry historical proof.
  const checks = await headChecks(read, pr, log);
  const { outcome, admitted } = await reconcilePull({ github: readGithub, read, write: reader(github, owner, repo, deadline, now),
    owner, repo, pr, checks, board: Boolean(projectGithub), releaseAppBotLogin, now, deadline, sleep, log });
  await followBoard({ read, projectGithub, owner, repo, pr, checks, admitted, log });
  return outcome;
}
module.exports = { discover, reconcile, eventTarget, eligiblePull, reviewJob, rerunnable, GATE_STEP };
