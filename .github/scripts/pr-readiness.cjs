'use strict';

// The board follows the head (hearsay-tools/cezarion#603, hearsay-tools/cezarion#3288).
// Readiness never changes draft state: agents open pull requests ready, and a
// human's draft stays a draft.
//   - The PR's and its closing issues' cards move to In review once the PR is
//     ready, every required check on the live head passes and no thread is open.
//   - Any other state moves them to In progress: a new head, a pending or red
//     check, an open thread, or a draft.
// Human draft/ready flips arrive as their own events and resync the board.

const { readCodeRabbitAdmission } = require('./coderabbit-admission.cjs');
const { readNativeReview } = require('./native-review-proof.cjs');
const { positive } = require('./queue-ci-proof.cjs');
const { discover: discoverAdmission, eligiblePull } = require('./coderabbit-reconcile.cjs');

const REVIEW_CHECK = 'Automated Code Review';
const PASSING = new Set(['success', 'skipped', 'neutral']);
const BOARD = { progress: 'In progress', review: 'In review' };
const DONE_STATUS = 'done';
const PULL_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft']);

async function requiredCheckNames({ github, owner, repo, branch }) {
  const { data: rules } = await github.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { owner, repo, branch, per_page: 100 });
  if (!Array.isArray(rules)) throw new Error('Could not read the branch rules.');
  const names = new Set([REVIEW_CHECK]);
  for (const rule of rules) {
    if (rule?.type !== 'required_status_checks') continue;
    for (const check of rule.parameters?.required_status_checks || []) {
      if (typeof check?.context === 'string' && check.context) names.add(check.context);
    }
  }
  return [...names].sort();
}

// A re-run adds a newer check run with the same name; only the latest counts.
function latestByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns || []) {
    if (typeof run?.name !== 'string' || !Number.isSafeInteger(run.id)) continue;
    if (!latest.has(run.name) || latest.get(run.name).id < run.id) latest.set(run.name, run);
  }
  return latest;
}

function evaluateChecks({ required, checkRuns, statuses = [] }) {
  const runs = latestByName(checkRuns);
  const states = new Map();
  for (const status of statuses) {
    if (typeof status?.context === 'string' && !states.has(status.context)) states.set(status.context, status.state);
  }
  const result = { ready: true, pending: [], failing: [], missing: [] };
  for (const name of required) {
    const run = runs.get(name);
    if (run) {
      if (run.status !== 'completed') result.pending.push(name);
      else if (!(name === REVIEW_CHECK || name === 'Unit, build, E2E, and package' ? run.conclusion === 'success' : PASSING.has(run.conclusion))) result.failing.push(name);
      continue;
    }
    const state = states.get(name);
    if (state === 'success') continue;
    if (state === 'pending') result.pending.push(name);
    else if (state) result.failing.push(name);
    else result.missing.push(name);
  }
  result.ready = !result.pending.length && !result.failing.length && !result.missing.length;
  return result;
}

async function readHeadChecks({ github, owner, repo, sha }) {
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 });
  const { data: combined } = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 });
  return { checkRuns, statuses: combined?.statuses || [] };
}

const BOARD_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      projectItems(first: 20) { nodes { ...item } }
      closingIssuesReferences(first: 20) { nodes { projectItems(first: 20) { nodes { ...item } } } }
    }
  }
}
fragment item on ProjectV2Item {
  id
  project { id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } }
  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
}`;

function projectItems(pull) {
  return [
    ...(pull?.projectItems?.nodes || []),
    ...(pull?.closingIssuesReferences?.nodes || []).flatMap((issue) => issue?.projectItems?.nodes || []),
  ];
}

function statusOption(field, status) {
  return field?.options?.find((candidate) => candidate?.name?.toLowerCase() === status.toLowerCase());
}

// One card's move, or null when the card must stay where it is.
function cardMove(item, status) {
  const option = statusOption(item?.project?.field, status);
  const current = item?.fieldValueByName?.name?.toLowerCase() || null;
  if (!item?.id || !option || current === DONE_STATUS || current === status.toLowerCase()) return null;
  return { projectId: item.project.id, itemId: item.id, fieldId: item.project.field.id, optionId: option.id };
}

// Every card the PR or its closing issues have, on any board with a Status
// field that names the target option. Done cards never move back.
function boardMoves(data, status) {
  const moves = [];
  const seen = new Set();
  for (const item of projectItems(data?.repository?.pullRequest)) {
    const move = cardMove(item, status);
    if (!move || seen.has(move.itemId)) continue;
    seen.add(move.itemId);
    moves.push(move);
  }
  return moves;
}

// Board access is optional: without a project-capable token the sync reports
// why and returns.
async function syncBoard({ projectGithub, owner, repo, pullNumber, status, log }) {
  if (!projectGithub) {
    log(`Board sync skipped for #${pullNumber}: no project token (grant the release App Organization projects access).`);
    return { moved: 0, skipped: 'no-token' };
  }
  try {
    const data = await projectGithub.graphql(BOARD_QUERY, { owner, repo, number: pullNumber });
    const moves = boardMoves(data, status);
    for (const move of moves) {
      await projectGithub.graphql(`mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } }
      }`, move);
    }
    log(`Board sync for #${pullNumber}: moved ${moves.length} card(s) to ${status}.`);
    return { moved: moves.length };
  } catch (error) {
    log(`Board sync skipped for #${pullNumber}: ${error.message}`);
    return { moved: 0, skipped: 'error' };
  }
}

// Board sync covers same-repository PRs only.
function sameRepo(pull, owner, repo) {
  return pull?.head?.repo?.full_name === `${owner}/${repo}`;
}

async function followPull({ github, projectGithub, owner, repo, candidate, sha, checks, deadline, log }) {
  const { data: live } = await github.rest.pulls.get({ owner, repo, pull_number: candidate.number });
  if (live?.state !== 'open' || live.head?.sha !== sha || !sameRepo(live, owner, repo)) return;
  let admitted = false;
  try {
    const proof = await readNativeReview({ github, owner, repo, pr: live, deadline });
    const admission = await readCodeRabbitAdmission({ github, owner, repo, pullNumber: live.number, head: sha, deadline,
      releaseAppBotLogin: process.env.RELEASE_APP_BOT_LOGIN });
    admitted = checks.ready && proof.passed && admission.admitted;
  } catch (error) {
    log(`PR ${live.number}: fresh review proof unavailable: ${error.message}`);
  }
  const { data: final } = await github.rest.pulls.get({ owner, repo, pull_number: live.number });
  if (final?.state !== 'open' || final.head?.sha !== sha || !sameRepo(final, owner, repo) || final.base?.ref !== 'main') return;
  const status = admitted && !final.draft ? BOARD.review : BOARD.progress;
  log(`PR ${final.number}: board follows ${status} (admitted=${admitted}, draft=${final.draft}).`);
  await syncBoard({ projectGithub, owner, repo, pullNumber: final.number, status, log });
}

async function discoverReadiness({ github, owner, repo, eventName, payload, log = () => {} }) {
  if (eventName !== 'pull_request_target') {
    return discoverAdmission({ github, owner, repo, eventName, payload, log });
  }
  if (payload.repository?.full_name !== `${owner}/${repo}`) throw new Error('Foreign event');
  if (!PULL_ACTIONS.has(payload.action) || !positive(payload.pull_request?.number)) return { numbers: [] };
  const number = payload.pull_request.number;
  const { data: live } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  return { numbers: live?.number === number && eligiblePull(live, `${owner}/${repo}`) ? [number] : [] };
}

async function refreshReadiness({ github, projectGithub = null, owner, repo, pullNumber,
  now = Date.now, log = () => {} }) {
  if (!positive(pullNumber)) throw new Error('Missing trusted readiness PR number');
  const deadline = now() + 120000;
  // The workflow's PR-number lock is already held. Re-read all mutable state;
  // an old event can wake this PR but cannot supply a head or draft decision.
  const { data: live } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (live?.number !== pullNumber || !eligiblePull(live, `${owner}/${repo}`)) return;
  const required = await requiredCheckNames({ github, owner, repo, branch: 'main' });
  const sha = live.head.sha;
  const checks = evaluateChecks({ required, ...(await readHeadChecks({ github, owner, repo, sha })) });
  return followPull({ github, projectGithub, owner, repo, candidate: live, sha, checks, deadline, log });
}

module.exports = {
  REVIEW_CHECK,
  BOARD,
  requiredCheckNames,
  latestByName,
  evaluateChecks,
  boardMoves,
  syncBoard,
  discoverReadiness,
  refreshReadiness,
};
