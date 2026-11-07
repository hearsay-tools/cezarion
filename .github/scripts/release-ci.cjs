'use strict';

// Start the existing, read-only CI workflow at a release PR's head. No synthetic
// check is posted. Dispatch verifies code but cannot satisfy PR branch protection.
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const CHECK_NAME = 'Unit, build, E2E, and package';

function recoveryCommand(repo, prNumber, expectedSha) {
  return `node .github/scripts/release-ci.cjs ${repo.owner}/${repo.repo} ${prNumber} ${expectedSha}`;
}

function assertValidReleaseInputs(expectedSha, prNumber) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('Expected a PR number and its full, lowercase head SHA.');
  }
}

function expectConsistentReleasePr(pr, fullName, expectedSha) {
  if (pr.head.sha !== expectedSha || pr.head.repo?.full_name !== fullName
    || pr.base.repo?.full_name !== fullName || !/^release\/v\d+\.\d+\.\d+$/.test(pr.head.ref)) {
    throw new Error('Release PR repository, branch, or head changed; inspect the PR before retrying.');
  }
}

function expectOpenAtExpectedSha(pr, expectedSha) {
  if (pr.head.sha !== expectedSha || pr.state !== 'open') {
    throw new Error('Release PR changed while waiting for native CI.');
  }
}

async function getPull({ github, repo, prNumber }) {
  return (await github.rest.pulls.get({ ...repo, pull_number: prNumber })).data;
}

async function listReleaseRuns({ github, repo, branch, expectedSha }) {
  return (await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo, workflow_id: 'ci.yml', branch, head_sha: expectedSha, per_page: 100,
  })).filter((run) => run.head_sha === expectedSha && run.head_branch === branch
    && ['workflow_dispatch', 'pull_request_target', 'pull_request'].includes(run.event));
}

async function listRunJobs({ github, repo, run }) {
  return github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo, run_id: run.id, filter: 'latest', per_page: 100,
  });
}

function hasRequiredCheck(jobs) {
  return jobs.some((job) => job.name === CHECK_NAME && job.conclusion === 'success');
}

// Creating a PR with an installation token emits the native event. Never
// dispatch in this path: the shared concurrency group would cancel it.
async function awaitNativeCi({ github, repo, prNumber, expectedSha, branch, sleep }) {
  for (let attempt = 0; attempt < 12; attempt++) {
    expectOpenAtExpectedSha(await getPull({ github, repo, prNumber }), expectedSha);
    const run = (await listReleaseRuns({ github, repo, branch, expectedSha })).find(r => r.event !== 'workflow_dispatch');
    if (run) {
      if (run.status !== 'completed') return { status: 'active', mergeEligible: true, sha: expectedSha, url: run.html_url };
      const jobs = await listRunJobs({ github, repo, run });
      if (run.conclusion === 'success' && hasRequiredCheck(jobs)) {
        return { status: 'passed', mergeEligible: true, sha: expectedSha, url: run.html_url };
      }
      throw new Error(`Native CI did not pass. Inspect and rerun failed jobs: ${run.html_url}`);
    }
    if (attempt < 11) await sleep(5000);
  }
  throw new Error('No native PR CI appeared within 55 seconds. Check the release App installation and ci.yml base-branch triggers. A legacy GITHUB_TOKEN-created PR needs a maintainer close/reopen once; dispatch cannot satisfy required checks.');
}

async function dispatchReleaseCi({ github, repo, prNumber, expectedSha, branch, sleep }) {
  const runs = await listReleaseRuns({ github, repo, branch, expectedSha });
  const active = runs.find((run) => run.status !== 'completed');
  if (active) return { status: 'active', mergeEligible: active.event !== 'workflow_dispatch', sha: expectedSha, url: active.html_url };
  // The API lists newest runs first. An old success cannot hide a newer
  // failure, and a workflow without the required job is not verified CI.
  const run = runs[0];
  if (run?.conclusion === 'success' && hasRequiredCheck(await listRunJobs({ github, repo, run }))) {
    return { status: run.event === 'workflow_dispatch' ? 'verified-only' : 'passed', mergeEligible: run.event !== 'workflow_dispatch', sha: expectedSha, url: run.html_url };
  }
  const ref = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data;
  if (ref.object.sha !== expectedSha || (await getPull({ github, repo, prNumber })).head.sha !== expectedSha) {
    throw new Error('Release branch moved before CI dispatch; no run was requested.');
  }
  // GitHub dispatch accepts a branch/tag, not a checkout override. Dispatch at
  // the release branch so the check belongs to its commit, never main's SHA.
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'ci.yml', ref: branch, inputs: { pr_number: String(prNumber) } });
  const priorIds = new Set(runs.map((entry) => entry.id));
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await getPull({ github, repo, prNumber })).head.sha !== expectedSha) {
      throw new Error('Release PR moved during dispatch; inspect CI and recover the new head explicitly.');
    }
    const found = (await listReleaseRuns({ github, repo, branch, expectedSha })).find((entry) => !priorIds.has(entry.id));
    if (found) return { status: 'dispatched', mergeEligible: found.event !== 'workflow_dispatch', sha: expectedSha, url: found.html_url };
    if (attempt < 11) await sleep(5000);
  }
  throw new Error('Dispatch accepted, but no CI run appeared for the expected commit within 55 seconds. Inspect Actions before retrying; the recovery command reuses active runs.');
}

function ciTriggerFailure(error, { native, recovery }) {
  // Finalization bounds its summary errors; reserve space for the recovery.
  const reason = String(error.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 1000);
  // Octokit uses status for HTTP; execFileSync uses it for the process exit.
  const httpStatus = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599;
  const hint = native
    ? 'Native CI recovery: inspect the PR Checks tab; rerun its eligible CI or have a maintainer close/reopen a legacy PR once.'
    : `Check actions: write permission, Actions policy, and ci.yml workflow_dispatch on the release branch. Dispatch is verification-only, not merge-eligible. Recovery: ${recovery}`;
  return new Error(`CI trigger failed${httpStatus ? ` (HTTP ${error.status})` : ''}: ${reason}. ${hint}`, { cause: error });
}

async function ensureReleaseCi({ github, repo, prNumber, expectedSha, sleep = delay, native = false }) {
  const recovery = recoveryCommand(repo, prNumber, expectedSha);
  try {
    assertValidReleaseInputs(expectedSha, prNumber);
    const fullName = `${repo.owner}/${repo.repo}`;
    const pr = await getPull({ github, repo, prNumber });
    expectConsistentReleasePr(pr, fullName, expectedSha);
    if (pr.merged_at) return { status: 'not-needed', sha: expectedSha, url: pr.html_url };
    if (pr.state !== 'open') throw new Error('Release PR is closed without merging.');
    const branch = pr.head.ref;
    if (native) return await awaitNativeCi({ github, repo, prNumber, expectedSha, branch, sleep });
    return await dispatchReleaseCi({ github, repo, prNumber, expectedSha, branch, sleep });
  } catch (error) {
    throw ciTriggerFailure(error, { native, recovery });
  }
}

// Keep authentication in gh's environment/keychain. This adapter exposes only
// the same API calls used inside actions/github-script, without an SDK install.
function githubViaGh() {
  const api = (endpoint, args = [], paginate = false) => {
    const out = execFileSync('gh', ['api', endpoint, ...args, ...(paginate ? ['--paginate', '--slurp'] : [])], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : null;
  };
  const path = (a) => `repos/${a.owner}/${a.repo}`;
  const listWorkflowRuns = (a) => api(`${path(a)}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(a.branch)}&head_sha=${a.head_sha}&per_page=100`, [], true).flatMap((page) => page.workflow_runs);
  const listJobsForWorkflowRun = (a) => api(`${path(a)}/actions/runs/${a.run_id}/jobs?filter=latest&per_page=100`, [], true).flatMap((page) => page.jobs);
  return {
    paginate: async (method, args) => method(args),
    rest: {
      pulls: { get: async (a) => ({ data: api(`${path(a)}/pulls/${a.pull_number}`) }) },
      git: { getRef: async (a) => ({ data: api(`${path(a)}/git/ref/${a.ref}`) }) },
      actions: {
        listWorkflowRuns, listJobsForWorkflowRun,
        createWorkflowDispatch: async (a) => api(`${path(a)}/actions/workflows/ci.yml/dispatches`, ['--method', 'POST', '-f', `ref=${a.ref}`, '-f', `inputs[pr_number]=${a.inputs.pr_number}`]),
      },
    },
  };
}

if (require.main === module) {
  const [repository, number, expectedSha, extra] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[1-9]\d*$/.test(number ?? '') || extra) {
    console.error('Usage: node .github/scripts/release-ci.cjs OWNER/REPO PR_NUMBER EXPECTED_HEAD_SHA');
    process.exitCode = 1;
  } else {
    const [owner, repo] = repository.split('/');
    ensureReleaseCi({ github: githubViaGh(), repo: { owner, repo }, prNumber: Number(number), expectedSha })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { ensureReleaseCi, recoveryCommand };
