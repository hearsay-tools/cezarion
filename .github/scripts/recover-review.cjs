'use strict';

const { countAutomatedReviews } = require('./automated-review.cjs');

const CI_PATH = '.github/workflows/ci.yml';
const REVIEW_PATH = '.github/workflows/automated-code-review.yml';
const VERIFY = 'Unit, build, E2E, and package';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const allowedActor = actor => typeof actor?.login === 'string' &&
  (!actor.login.endsWith('[bot]') || actor.login === 'claude[bot]');
const completed = (job, conclusion) => job?.status === 'completed' && job.conclusion === conclusion;

function oneJob(jobs, name) {
  const matches = jobs.filter(job => job.name === name);
  return matches.length === 1 ? matches[0] : null;
}

// All input is API metadata, never a PR artifact, checkout, or shell fragment.
// The caller serializes recovery events by head. Inspect twice before the sole
// write, then rerun the original trusted gate and dependents (not dispatch, which
// deliberately bypasses the normal round cap). Original PR concurrency and the
// provider/context/posting guards remain in force on that same workflow run.
async function recoverReview({ github, owner, repo, event, maxRounds = '', log = console.log }) {
  const roundsRaw = maxRounds === '' ? '3' : String(maxRounds);
  const rounds = Number(roundsRaw);
  if (!/^[1-9][0-9]*$/.test(roundsRaw) || !Number.isSafeInteger(rounds)) {
    throw new Error('AUTOMATED_REVIEW_ROUNDS must be a positive integer.');
  }
  const repository = `${owner}/${repo}`;
  const trigger = event?.workflow_run;
  let ciIdentity = trigger?.path === CI_PATH ? `CI ${trigger.id} attempt ${trigger.run_attempt}` : 'CI unresolved';
  const params = { owner, repo };
  const get = async (route, args) => (await github.request(`GET /repos/{owner}/{repo}/${route}`, { ...params, ...args })).data;
  const list = (route, args) => github.paginate(`GET /repos/{owner}/{repo}/${route}`, { ...params, per_page: 100, ...args });
  const runDetails = run_id => get('actions/runs/{run_id}', { run_id });
  const jobs = run => list('actions/runs/{run_id}/attempts/{attempt_number}/jobs', { run_id: run.id, attempt_number: run.run_attempt });
  const skip = reason => ({ recovered: false, reason });
  const sameAttempt = (a, b) => a?.id === b?.id && a?.run_attempt === b?.run_attempt && a?.head_sha === b?.head_sha;
  const sameRepo = run => run?.head_repository?.full_name === repository;

  async function inspect() {
    if (!positiveId(trigger?.id) || !positiveId(trigger?.run_attempt) || !/^[a-f0-9]{40}$/i.test(trigger?.head_sha || '')) {
      return skip('invalid completion identity');
    }
    const source = await runDetails(trigger.id);
    if (!sameAttempt(source, trigger) || source.status !== 'completed') return skip('superseded or unfinished completion');
    if (!sameRepo(source) || !allowedActor(source.actor)) return skip('ineligible source repository or bot actor');
    const fromCi = source.path === CI_PATH && source.event === 'pull_request';
    const fromReview = source.path === REVIEW_PATH && source.event === 'pull_request_target';
    if (!fromCi && !fromReview) return skip('not a CI or automatic review completion');

    // workflow_run.pull_requests can be empty. Resolve the live PR through the
    // repository instead of trusting its event snapshot or parsing branch names.
    const pulls = await list('pulls', { state: 'open', base: 'main', head: `${owner}:${source.head_branch}` });
    const matches = pulls.filter(pull => pull.state === 'open' && pull.base?.ref === 'main' &&
      pull.base?.repo?.full_name === repository && pull.head?.repo?.full_name === repository &&
      pull.head?.sha === source.head_sha && pull.head?.ref === source.head_branch);
    if (matches.length !== 1) return skip('no unique current open same-repository PR on main');
    const pull = await get('pulls/{pull_number}', { pull_number: matches[0].number });
    if (pull?.state !== 'open' || pull.head?.sha !== source.head_sha || pull.head?.repo?.full_name !== repository ||
        pull.base?.ref !== 'main' || pull.base?.repo?.full_name !== repository) return skip('PR changed during resolution');

    const ciRuns = await list('actions/workflows/{workflow_id}/runs', { workflow_id: 'ci.yml', event: 'pull_request', head_sha: pull.head.sha });
    const latestCi = ciRuns.filter(run => run.event === 'pull_request' && run.head_sha === pull.head.sha).sort((a, b) => b.id - a.id)[0];
    if (!latestCi) return skip('no CI for the current head');
    const ci = await runDetails(latestCi.id);
    ciIdentity = `CI ${ci.id} attempt ${ci.run_attempt}`;
    if (ci.path !== CI_PATH || ci.event !== 'pull_request' || !sameRepo(ci) || ci.head_sha !== pull.head.sha ||
        !positiveId(ci.run_attempt) || ci.status !== 'completed' || ci.conclusion === 'cancelled') return skip('latest CI attempt is ineligible or unfinished');
    if (fromCi && !sameAttempt(ci, source)) return skip('CI completion was superseded by a newer run or attempt');
    const verification = oneJob(await jobs(ci), VERIFY);
    if (!completed(verification, 'success')) return skip(`CI ${ci.id} attempt ${ci.run_attempt}: aggregate verification is not successful`);

    const reviews = await list('pulls/{pull_number}/reviews', { pull_number: pull.number });
    if (countAutomatedReviews(reviews) >= rounds) return skip('automated review round limit exhausted');
    if (reviews.some(review => review.user?.login === 'github-actions[bot]' && review.commit_id === pull.head.sha)) {
      return skip('automated review already exists on this head');
    }

    const reviewRuns = await list('actions/workflows/{workflow_id}/runs', { workflow_id: 'automated-code-review.yml', head_sha: pull.head.sha });
    const matchingRuns = reviewRuns.filter(run => run.head_sha === pull.head.sha);
    if (matchingRuns.some(run => run.status !== 'completed')) return skip('review already active on this head');
    if (matchingRuns.some(run => run.conclusion === 'success')) return skip('review already completed on this head');
    const latestReview = matchingRuns.sort((a, b) => b.id - a.id)[0];
    if (!latestReview) return skip('no blocked automatic review run');
    const review = await runDetails(latestReview.id);
    if (review.path !== REVIEW_PATH || review.event !== 'pull_request_target' || !sameRepo(review) ||
        !allowedActor(review.actor) || review.head_sha !== pull.head.sha || !positiveId(review.run_attempt) ||
        !completed(review, 'failure') || !review.pull_requests?.some(pr => pr.number === pull.number)) {
      return skip('latest review is active, completed, stale, or ineligible');
    }
    if (fromReview && !sameAttempt(review, source)) return skip('review completion was superseded');
    const reviewJobs = await jobs(review);
    const gate = oneJob(reviewJobs, 'wait-for-ci');
    if (!completed(gate, 'failure') || !positiveId(gate.id) ||
        !['validate-provider', 'review-round'].every(name => completed(oneJob(reviewJobs, name), 'success')) ||
        !['claude-review', 'codex-review', 'post-review'].every(name => completed(oneJob(reviewJobs, name), 'skipped'))) {
      return skip('review was not blocked solely at wait-for-ci');
    }
    // A replay or completion of a failed recovery must not spend another attempt
    // on the same successful verification. A later successful CI attempt gives
    // the gate a new opportunity; a provider failure never does.
    const failedAt = Date.parse(gate.completed_at);
    const startedAt = Date.parse(gate.started_at);
    const verifiedAt = Date.parse(verification.completed_at);
    // REST timestamps have second precision. Equality cannot establish ordering:
    // the waiter may have started before verification succeeded within that second.
    if (![failedAt, startedAt, verifiedAt].every(Number.isFinite) || startedAt > failedAt || startedAt > verifiedAt) {
      return skip('this successful verification was already available when the failed review gate started');
    }
    return { recovered: true, pull: pull.number, head: pull.head.sha, ci: ci.id, ciAttempt: ci.run_attempt,
      review: review.id, reviewAttempt: review.run_attempt, job: gate.id };
  }

  let result = await inspect();
  if (result.recovered) {
    const checked = await inspect();
    result = !checked.recovered ? checked : JSON.stringify(checked) === JSON.stringify(result)
      ? checked : skip('PR, CI attempt, or review attempt changed before scheduling');
  }
  if (result.recovered) {
    await github.request('POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun', { ...params, job_id: result.job });
    log(`Recover PR #${result.pull} head ${result.head}: CI ${result.ci} attempt ${result.ciAttempt} succeeded; rerun review ${result.review} attempt ${result.reviewAttempt}, wait-for-ci job ${result.job} and dependents.`);
  } else {
    log(`Skip recovery for completion ${trigger?.id} attempt ${trigger?.run_attempt}, ${ciIdentity}: ${result.reason}.`);
  }
  return result;
}

module.exports = { recoverReview };
