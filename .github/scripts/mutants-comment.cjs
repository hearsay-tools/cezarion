'use strict';
// The trusted half of the mutation report: it posts what the pull request's own job found. It runs
// from the default branch with a write token and treats the artifact as untrusted input. It finds the
// pull request through the API, never through the artifact, and keeps one comment current.
// Advisory: nothing here changes a required check.
const fs = require('node:fs');
const path = require('node:path');
const { MARKER, validateArtifact, renderReport, renderUnavailable, shouldCreate } = require('./mutants-report.cjs');

const BOT = 'github-actions[bot]';
const MAX_ARTIFACT_BYTES = 1_000_000;

/** The open pull request whose head is the commit the run tested, or undefined. */
async function findPullRequest({ github, owner, repo, run }) {
  const numbers = (run.pull_requests ?? []).map(p => p.number);
  const candidates = numbers.length
    ? await Promise.all(numbers.map(async number => (await github.rest.pulls.get({ owner, repo, pull_number: number })).data))
    : (await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: run.head_sha })).data;
  return candidates.find(p => p?.state === 'open' && p.head.sha === run.head_sha);
}

/** The artifact the job wrote, or null when it is missing, too large, not JSON or not the expected shape. */
function readArtifact(dir, core) {
  const file = path.join(dir, 'mutants.json');
  try {
    if (fs.statSync(file).size > MAX_ARTIFACT_BYTES) throw new Error('the artifact is too large');
    return validateArtifact(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    core.warning(`Mutation artifact unreadable: ${error.message}`);
    return null;
  }
}

/** Update the bot's marked comment. Create it only when `create` says there is something to say. */
async function upsertComment({ github, owner, repo, number, body, create }) {
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  const existing = comments.find(c => c.user?.login === BOT && c.body?.includes(MARKER));
  if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  else if (create) await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  return existing ? 'updated' : create ? 'created' : 'none';
}

/** What to say for this run, and whether a missing comment should be created for it. */
function decide(run, dir, core, ctx) {
  const artifact = run.conclusion === 'success' ? readArtifact(dir, core) : null;
  if (artifact) return { body: renderReport(artifact, ctx), create: shouldCreate(artifact) };
  return { body: renderUnavailable(run.conclusion === 'success' ? 'unreadable' : 'failed', ctx), create: false };
}

async function publish({ github, context, core, dir }) {
  const run = context.payload.workflow_run;
  const { owner, repo } = context.repo;
  if (run.event !== 'pull_request' || run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
    core.info(`Nothing to post for a ${run.event} run that ${run.conclusion}.`);
    return;
  }
  const pull = await findPullRequest({ github, owner, repo, run });
  if (!pull) {
    core.info(`No open pull request has ${run.head_sha} as its head, so the report is stale.`);
    return;
  }
  const ctx = { head: run.head_sha, runUrl: run.html_url, blobBase: `https://github.com/${owner}/${repo}/blob/${run.head_sha}` };
  const { body, create } = decide(run, dir, core, ctx);
  const outcome = await upsertComment({ github, owner, repo, number: pull.number, body, create });
  core.info(`Pull request #${pull.number}: comment ${outcome}.`);
}

module.exports = { publish };
