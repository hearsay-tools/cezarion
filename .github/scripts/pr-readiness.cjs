'use strict';

// The board follows the head (hearsay-tools/cezarion#603, hearsay-tools/cezarion#3288).
// Reconcile CodeRabbit admission (coderabbit-reconcile.cjs) reads the live head
// once and calls these helpers for the board decision. It never changes draft
// state: agents open pull requests ready, and a human's draft stays a draft.
//   - The PR's and its closing issues' cards move to In review once the PR is
//     ready, every required check on the live head passes and no thread is open.
//   - Any other state moves them to In progress: a new head, a pending or red
//     check, an open thread, or a draft.
// Human draft/ready flips arrive as their own events and resync the board.

const { pages } = require('./queue-ci-proof.cjs');

const REVIEW_CHECK = 'Automated Code Review';
const PASSING = new Set(['success', 'skipped', 'neutral']);
const BOARD = { progress: 'In progress', review: 'In review' };
const DONE_STATUS = 'done';

// `read` is the deadline-bound reader from queue-ci-proof.cjs.
async function requiredCheckNames(read, branch) {
  const rules = await read('GET /repos/{owner}/{repo}/rules/branches/{branch}', { branch, per_page: 100 });
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

// Three reads: the branch rules, the head's check runs and its commit statuses.
async function readHeadChecks(read, sha) {
  const required = await requiredCheckNames(read, 'main');
  const checkRuns = await pages(read, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ref: sha }, 'check_runs');
  const combined = await read('GET /repos/{owner}/{repo}/commits/{ref}/status', { ref: sha, per_page: 100 });
  return { checkRuns, ...evaluateChecks({ required, checkRuns, statuses: combined?.statuses || [] }) };
}

// The native review job's check run. While no run of it on the head has
// completed, neither the targeted rerun nor In review can follow, so the
// native proof and admission reads are skipped.
function reviewCheckCompleted(checkRuns) {
  return (checkRuns || []).some(run => run?.name === REVIEW_CHECK && run.status === 'completed');
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
// The whole board sync shares one budget, apart from the rerun's 120-second
// read deadline: a stalled project request costs the rerun at most this long.
const BOARD_BUDGET_MS = 15000;
// Ends when the request ends or the budget aborts it, even for a client that
// ignores the signal. A late result after the abort is dropped.
function bounded(request, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('board request budget exhausted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function syncBoard({ projectGithub, owner, repo, pullNumber, status, log,
  signal = AbortSignal.timeout(BOARD_BUDGET_MS) }) {
  if (!projectGithub) {
    log(`Board sync skipped for #${pullNumber}: no project token (grant the release App Organization projects access).`);
    return { moved: 0, skipped: 'no-token' };
  }
  const graphql = (query, variables) => bounded(Promise.resolve()
    .then(() => projectGithub.graphql(query, { ...variables, request: { signal, retries: 0 } })), signal);
  try {
    const data = await graphql(BOARD_QUERY, { owner, repo, number: pullNumber });
    const moves = boardMoves(data, status);
    for (const move of moves) {
      await graphql(`mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
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

// One board decision: In review only when the PR is ready, every required
// check on the live head passes, and native proof and fresh admission hold.
function boardStatus({ checks, admitted, draft }) {
  return checks?.ready && admitted && !draft ? BOARD.review : BOARD.progress;
}

module.exports = {
  REVIEW_CHECK,
  BOARD,
  requiredCheckNames,
  latestByName,
  evaluateChecks,
  readHeadChecks,
  reviewCheckCompleted,
  boardMoves,
  boardStatus,
  syncBoard,
  BOARD_BUDGET_MS,
};
