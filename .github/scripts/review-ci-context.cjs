'use strict';

// Review-first context is not a full verification claim. Read only official run
// metadata; never borrow a successful old run/attempt to fill missing evidence.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { withGhRetry, resolveCiResults, renderCiResults } = require('./fetch-ci-results.cjs');
const CI_PATH = '.github/workflows/ci.yml';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => /^[1-9][0-9]*$/.test(String(value));

function api(gh, repo, suffix) {
  return JSON.parse(gh(['api', `repos/${repo}/${suffix}`]));
}

function jobsForAttempt(gh, repo, run) {
  const jobs = [];
  for (let page = 1; page <= 2; page++) {
    const data = api(gh, repo, `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count) || data.total_count > 200) {
      throw new Error('Incomplete current-attempt CI jobs');
    }
    jobs.push(...data.jobs);
    if (jobs.length === data.total_count) return jobs;
    if (data.jobs.length !== 100) break;
  }
  throw new Error('Incomplete current-attempt CI jobs');
}

function assertNativeRun(run, repo, head, pr) {
  if (!positive(run?.id) || !positive(run.run_attempt) || run.path !== CI_PATH
    || run.event !== 'pull_request_target' || run.repository?.full_name !== repo || run.head_sha !== head
    || run.head_branch !== pr.head.ref || run.head_repository?.full_name !== pr.head.repo?.full_name) {
    throw new Error('CI context is not native current-head PR evidence');
  }
}

function assertCaller(env, event, head, pullNumber) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request_target'
    || env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/${CI_PATH}@refs/heads/main`
    || env.REVIEW_PREFLIGHT_RESULT !== 'success'
    || env.REVIEW_CALLER_RUN_ID !== env.GITHUB_RUN_ID
    || env.REVIEW_CALLER_ATTEMPT !== env.GITHUB_RUN_ATTEMPT
    || env.REVIEW_CALLER_HEAD !== head || event.pull_request?.head?.sha !== head
    || event.pull_request?.number !== pullNumber || event.pull_request?.base?.ref !== 'main'
    || event.pull_request?.base?.repo?.full_name !== env.GITHUB_REPOSITORY) {
    throw new Error('Invalid trusted preflight caller provenance');
  }
}

function assertLiveHead(gh, repo, pullNumber, head, baseRef) {
  const pr = api(gh, repo, `pulls/${pullNumber}`);
  if (pr.state !== 'open' || pr.head?.sha !== head || typeof pr.head?.ref !== 'string'
    || typeof pr.head?.repo?.full_name !== 'string' || typeof pr.base?.ref !== 'string' || !pr.base.ref
    || (baseRef !== undefined && pr.base.ref !== baseRef) || pr.base?.repo?.full_name !== repo) {
    throw new Error('PR head changed before review context was read');
  }
  return pr;
}

function nativeContext(gh, env, event, head, pullNumber) {
  assertCaller(env, event, head, pullNumber);
  const repo = env.GITHUB_REPOSITORY;
  const readRun = () => api(gh, repo, `actions/runs/${env.GITHUB_RUN_ID}`);
  const run = readRun();
  assertNativeRun(run, repo, head, assertLiveHead(gh, repo, pullNumber, head, 'main'));
  if (String(run.id) !== env.GITHUB_RUN_ID || String(run.run_attempt) !== env.GITHUB_RUN_ATTEMPT || run.status !== 'in_progress') {
    throw new Error('Caller run or attempt changed');
  }
  // Native target runs can have an empty pull_requests list (observed run
  // 40903818807). The event and live PR supply identity; official run metadata
  // must match its SHA, branch and head repository.
  // needs.preflight.result is the caller's scheduling authority. Check the actual
  // run too. A retried provider may retain a successful prerequisite; the API's
  // latest view is that same run's retained jobs, never an older-run fallback.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]));
  const jobs = pages.flatMap(page => page.jobs ?? []);
  const preflight = jobs.filter(job => job.name === 'Review preflight');
  if (pages.some(page => page.total_count !== jobs.length) || preflight.length !== 1
    || preflight[0].status !== 'completed' || preflight[0].conclusion !== 'success') {
    throw new Error('Caller preflight did not succeed');
  }
  assertLiveHead(gh, repo, pullNumber, head, 'main');
  const final = readRun();
  if (final.id !== run.id || final.run_attempt !== run.run_attempt || final.status !== 'in_progress') {
    throw new Error('Caller run changed while collecting preflight');
  }
  return `# CI review context\n\nHead: ${head}\nRun: ${run.id}\nAttempt: ${run.run_attempt}\nPreflight: success\n\nHeavy verification: pending behind review. This is not a test pass.\nDo not wait for CI or run the test suite. Review the code now; full verification remains required before merge.\n`;
}

function latestNative(gh, repo, head) {
  const runs = JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--event', 'pull_request_target',
    '--commit', head, '--limit', '20', '--json', 'databaseId,headSha,event']));
  return runs.filter(run => run.event === 'pull_request_target' && run.headSha === head)
    .sort((a, b) => b.databaseId - a.databaseId)[0];
}

function skippedMatrix(jobs, prefix, count) {
  const matches = jobs.filter(job => job.name.startsWith(prefix));
  const names = new Set(matches.map(job => job.name));
  const complete = matches.length === count && Array.from({ length: count }, (_, i) => `${prefix}${i + 1}/${count}`)
    .every(name => names.has(name));
  // GitHub can skip before expansion, leaving an empty or literal shard expression.
  const unexpanded = matches.length === 1
    && (names.has(`${prefix}/${count}`) || names.has(`${prefix}${'${{ matrix.shard }}'}/${count}`));
  return (complete || unexpanded) && matches.every(job => job.status === 'completed' && job.conclusion === 'skipped');
}

function blockedByReview(run, jobs) {
  const completedWith = (name, conclusion) => {
    const matches = jobs.filter(job => job.name === name);
    return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === conclusion;
  };
  return run.status === 'completed' && run.conclusion === 'failure'
    && completedWith('Review preflight', 'success')
    && completedWith('Automated Code Review', 'failure')
    && completedWith('Unit, build, E2E, and package', 'failure')
    && completedWith('Unit, build, and package', 'skipped')
    && skippedMatrix(jobs, 'Vitest shard ', 3)
    && skippedMatrix(jobs, 'Cockpit browser E2E shard ', 4);
}

function matchesPullTarget(run, pullNumber, baseRef) {
  // Unlike native calls, dispatch has no trusted PR event to bind an empty
  // association list. Missing target evidence stays pending, never a CI pass.
  return Array.isArray(run.pull_requests) && run.pull_requests.some(pr =>
    pr.number === pullNumber && pr.base?.ref === baseRef);
}

function manualContext(gh, env, head, pullNumber) {
  const repo = env.GITHUB_REPOSITORY;
  const pr = assertLiveHead(gh, repo, pullNumber, head);
  const latest = latestNative(gh, repo, head);
  assertLiveHead(gh, repo, pullNumber, head, pr.base.ref);
  if (!latest) return renderCiResults(resolveCiResults([]));
  const run = api(gh, repo, `actions/runs/${latest.databaseId}`);
  assertNativeRun(run, repo, head, assertLiveHead(gh, repo, pullNumber, head, pr.base.ref));
  if (run.id !== latest.databaseId) throw new Error('Current CI run changed');
  if (!matchesPullTarget(run, pullNumber, pr.base.ref)) return renderCiResults(resolveCiResults([]));
  const jobs = jobsForAttempt(gh, repo, run);
  const result = resolveCiResults([{ databaseId: run.id, headSha: head, event: run.event, url: run.html_url }], { jobs, headSha: head });
  const final = api(gh, repo, `actions/runs/${run.id}`);
  assertNativeRun(final, repo, head, pr);
  if (!matchesPullTarget(final, pullNumber, pr.base.ref) || final.id !== run.id || final.run_attempt !== run.run_attempt || final.status !== run.status
    || final.conclusion !== run.conclusion || latestNative(gh, repo, head)?.databaseId !== run.id) {
    throw new Error('Current CI attempt changed while collecting context');
  }
  assertLiveHead(gh, repo, pullNumber, head, pr.base.ref);
  const context = blockedByReview(run, jobs)
    ? '# CI review context\n\nHeavy verification: not started: blocked by review.\nVerification aggregate: failure because the review gate failed; tests did not run.\n'
    : renderCiResults(result);
  return `${context}\nHead: ${head}\nRun: ${run.id}\nAttempt: ${run.run_attempt}\nWorkflow status: ${run.status}\nWorkflow conclusion: ${run.conclusion || 'pending'}\nDo not wait for CI or run the test suite. Missing current-attempt verification is pending, never a prior success.\n`;
}

function reviewCiContext({ gh, env, event }) {
  const head = env.HEAD_SHA;
  const pullNumber = Number(env.PR_NUMBER);
  if (!sha(head) || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) {
    throw new Error('Invalid review context identity');
  }
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') return manualContext(gh, env, head, pullNumber);
  return nativeContext(gh, env, event, head, pullNumber);
}

if (require.main === module) {
  const gh = withGhRetry(argv => execFileSync('gh', argv, { encoding: 'utf8', timeout: 15000 }),
    ms => execFileSync('sleep', [String(ms / 1000)]));
  const text = reviewCiContext({ gh, env: process.env, event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) });
  fs.writeFileSync(process.argv[2], text);
}
module.exports = { reviewCiContext };
