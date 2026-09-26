'use strict';

// Draft follows the head (#603): Ready for review means a human can look now,
// because agentic work and every required check on THIS head are done.
//   - A new head (opened, reopened, synchronize) converts the PR back to draft.
//   - A completed CI or Automated Code Review run marks the PR ready once every
//     required check on the live head passes and no review thread is open.
//   - The linked issues' board cards follow: draft → In progress, ready → In review.
// Flips made with the workflow token fire no workflow events, so the board is
// synced inline after each flip; human flips arrive as their own events.

const { listReviewThreads } = require('./automated-review.cjs');

const REVIEW_CHECK = 'Automated Code Review';
const PASSING = new Set(['success', 'skipped', 'neutral']);
const BOARD = { draft: 'In progress', ready: 'In review' };
const DONE_STATUS = 'done';
const NEW_HEAD_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);

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
      else if (!PASSING.has(run.conclusion)) result.failing.push(name);
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

async function openPullsForHead({ github, owner, repo, sha, base = 'main' }) {
  const pulls = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base, per_page: 100 });
  return pulls.filter((pull) => pull?.head?.sha === sha && pull.base?.ref === base);
}

async function setDraft({ github, pull, draft }) {
  const mutation = draft
    ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'
    : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
  await github.graphql(mutation, { id: pull.node_id });
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

// Every card the PR or its closing issues have, on any board with a Status
// field that names the target option. Done cards never move back.
function boardMoves(data, status) {
  const pull = data?.repository?.pullRequest;
  const items = [
    ...(pull?.projectItems?.nodes || []),
    ...(pull?.closingIssuesReferences?.nodes || []).flatMap((issue) => issue?.projectItems?.nodes || []),
  ];
  const moves = [];
  const seen = new Set();
  for (const item of items) {
    const field = item?.project?.field;
    const option = field?.options?.find((candidate) => candidate?.name?.toLowerCase() === status.toLowerCase());
    const current = item?.fieldValueByName?.name?.toLowerCase() || null;
    if (!item?.id || seen.has(item.id) || !option || current === DONE_STATUS || current === status.toLowerCase()) continue;
    seen.add(item.id);
    moves.push({ projectId: item.project.id, itemId: item.id, fieldId: field.id, optionId: option.id });
  }
  return moves;
}

// Board access is optional: without a project-capable token the sync reports
// why and returns, and the draft/ready gate is unaffected.
async function syncBoard({ projectGithub, owner, repo, pullNumber, draft, log }) {
  const status = draft ? BOARD.draft : BOARD.ready;
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

// The workflow token cannot flip a fork's PR; those keep their draft state.
function sameRepo(pull, owner, repo) {
  return pull?.head?.repo?.full_name === `${owner}/${repo}`;
}

async function onPullRequest({ github, projectGithub, owner, repo, action, pull, log }) {
  if (!sameRepo(pull, owner, repo)) return log(`#${pull?.number} comes from a fork; draft state is left to its author.`);
  if (NEW_HEAD_ACTIONS.has(action)) {
    if (!pull.draft) {
      await setDraft({ github, pull, draft: true });
      log(`#${pull.number}: new head ${pull.head.sha}; converted back to draft until its checks pass.`);
    }
    return syncBoard({ projectGithub, owner, repo, pullNumber: pull.number, draft: true, log });
  }
  if (action === 'ready_for_review' || action === 'converted_to_draft') {
    return syncBoard({ projectGithub, owner, repo, pullNumber: pull.number, draft: action === 'converted_to_draft', log });
  }
  return null;
}

async function markReadyWhenGreen({ github, projectGithub, owner, repo, sha, pullNumber = null, log }) {
  const pulls = (await openPullsForHead({ github, owner, repo, sha }))
    .filter((pull) => sameRepo(pull, owner, repo) && (pullNumber === null || pull.number === pullNumber));
  if (pulls.length === 0) return log(`No open same-repository PR on main has head ${sha}.`);
  const required = await requiredCheckNames({ github, owner, repo, branch: 'main' });
  const checks = evaluateChecks({ required, ...(await readHeadChecks({ github, owner, repo, sha })) });
  for (const candidate of pulls) {
    if (!candidate.draft) { log(`#${candidate.number} is already ready for review.`); continue; }
    if (!checks.ready) {
      log(`#${candidate.number} stays draft: pending [${checks.pending}] failing [${checks.failing}] missing [${checks.missing}].`);
      continue;
    }
    const open = (await listReviewThreads({ github, owner, repo, pullNumber: candidate.number })).filter((thread) => !thread.isResolved).length;
    if (open > 0) { log(`#${candidate.number} stays draft: ${open} review thread(s) unresolved.`); continue; }
    const { data: live } = await github.rest.pulls.get({ owner, repo, pull_number: candidate.number });
    if (live?.state !== 'open' || live.head?.sha !== sha || !live.draft) { log(`#${candidate.number} changed while checking; leaving it.`); continue; }
    await setDraft({ github, pull: live, draft: false });
    log(`#${candidate.number}: every required check passed on ${sha}; marked ready for review.`);
    await syncBoard({ projectGithub, owner, repo, pullNumber: candidate.number, draft: false, log });
  }
  return null;
}

async function handleEvent({ github, projectGithub = null, owner, repo, eventName, payload, log = () => {} }) {
  if (eventName === 'pull_request_target') {
    return onPullRequest({ github, projectGithub, owner, repo, action: payload.action, pull: payload.pull_request, log });
  }
  if (eventName === 'workflow_run') {
    const run = payload.workflow_run;
    if (run?.event !== 'pull_request_target' || typeof run.head_sha !== 'string') return log('Not a pull request run.');
    return markReadyWhenGreen({ github, projectGithub, owner, repo, sha: run.head_sha, log });
  }
  if (eventName === 'workflow_dispatch') {
    const pullNumber = Number(payload.inputs?.pr_number);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error('pr_number must be a positive integer.');
    const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (pull?.state !== 'open') return log(`#${pullNumber} is not open.`);
    return markReadyWhenGreen({ github, projectGithub, owner, repo, sha: pull.head.sha, pullNumber, log });
  }
  return log(`Ignoring ${eventName}.`);
}

module.exports = {
  REVIEW_CHECK,
  BOARD,
  requiredCheckNames,
  latestByName,
  evaluateChecks,
  openPullsForHead,
  boardMoves,
  syncBoard,
  handleEvent,
};
