const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REVIEW_CHECK,
  BOARD,
  requiredCheckNames,
  evaluateChecks,
  boardMoves,
  syncBoard,
  handleEvent,
} = require('./pr-readiness.cjs');

const workflowPath = path.join(__dirname, '..', 'workflows', 'pr-readiness.yml');
const owner = 'o';
const repo = 'r';
const sha = 'a'.repeat(40);
const VERIFY = 'Unit, build, E2E, and package';

function pullFixture(overrides = {}) {
  return {
    number: 7,
    node_id: 'PR_7',
    state: 'open',
    draft: true,
    head: { sha, repo: { full_name: `${owner}/${repo}` } },
    base: { ref: 'main' },
    ...overrides,
  };
}

function checkRun(id, name, conclusion, status = 'completed') {
  return { id, name, status, conclusion };
}

// A GitHub client double: every call is recorded, and each read answers from `state`.
function fakeGithub(state = {}) {
  const calls = [];
  const s = {
    pulls: [pullFixture()],
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: VERIFY }] } }],
    checkRuns: [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'success')],
    statuses: [],
    threads: [],
    ...state,
  };
  const github = {
    calls,
    state: s,
    request: async (route, params) => { calls.push(['request', route, params.branch]); return { data: s.rules }; },
    paginate: async (method, params) => method(params),
    rest: {
      pulls: {
        list: (params) => { calls.push(['pulls.list', params.base]); return s.pulls; },
        get: async ({ pull_number: number }) => ({ data: s.live?.(number) ?? s.pulls.find((pull) => pull.number === number) }),
      },
      checks: { listForRef: ({ ref }) => { calls.push(['checks', ref]); return s.checkRuns; } },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: s.statuses } }) },
    },
    graphql: async (query, variables) => {
      if (query.includes('reviewThreads')) {
        return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: s.threads } } } };
      }
      const name = query.match(/(convertPullRequestToDraft|markPullRequestReadyForReview)/)?.[1];
      calls.push([name, variables.id]);
      return {};
    },
  };
  return github;
}

const flips = (github) => github.calls.filter(([name]) => name === 'convertPullRequestToDraft' || name === 'markPullRequestReadyForReview');

const workflowRun = (overrides = {}) => ({ workflow_run: { event: 'pull_request_target', head_sha: sha, ...overrides } });

async function completeRun(github, extra = {}) {
  const logs = [];
  await handleEvent({ github, owner, repo, eventName: 'workflow_run', payload: workflowRun(), log: (m) => logs.push(m), ...extra });
  return logs;
}

test('requires the ruleset checks plus the automated review check', async () => {
  const github = fakeGithub({ rules: [
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: VERIFY }, { context: '' }, {}] } },
  ] });
  assert.deepEqual(await requiredCheckNames({ github, owner, repo, branch: 'main' }), [REVIEW_CHECK, VERIFY].sort());
  await assert.rejects(requiredCheckNames({ github: fakeGithub({ rules: null }), owner, repo, branch: 'main' }), /branch rules/);
});

test('evaluates the latest run per required check, and commit statuses as a fallback', () => {
  const required = [VERIFY, REVIEW_CHECK, 'legacy/status'];
  assert.deepEqual(evaluateChecks({
    required,
    checkRuns: [checkRun(1, VERIFY, 'failure'), checkRun(5, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'skipped')],
    statuses: [{ context: 'legacy/status', state: 'success' }],
  }), { ready: true, pending: [], failing: [], missing: [] });
  assert.deepEqual(evaluateChecks({
    required,
    checkRuns: [checkRun(9, VERIFY, 'failure'), checkRun(5, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, null, 'in_progress')],
    statuses: [],
  }), { ready: false, pending: [REVIEW_CHECK], failing: [VERIFY], missing: ['legacy/status'] });
  for (const conclusion of ['cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', null]) {
    assert.equal(evaluateChecks({ required: [VERIFY], checkRuns: [checkRun(1, VERIFY, conclusion)] }).ready, false, String(conclusion));
  }
  assert.deepEqual(evaluateChecks({ required: ['s'], checkRuns: [], statuses: [{ context: 's', state: 'pending' }] }).pending, ['s']);
  assert.deepEqual(evaluateChecks({ required: ['s'], checkRuns: [], statuses: [{ context: 's', state: 'error' }] }).failing, ['s']);
});

test('marks a draft ready once every required check on its head is green', async () => {
  const github = fakeGithub();
  await completeRun(github);
  assert.deepEqual(flips(github), [['markPullRequestReadyForReview', 'PR_7']]);
  assert.ok(github.calls.some(([name, ref]) => name === 'checks' && ref === sha), 'checks are read for the run head, not a branch');
});

test('a skipped review still lets the PR go ready once CI is green', async () => {
  const github = fakeGithub({ checkRuns: [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'skipped')] });
  await completeRun(github);
  assert.deepEqual(flips(github), [['markPullRequestReadyForReview', 'PR_7']]);
});

test('a red, pending or missing required check keeps the PR draft', async () => {
  for (const checkRuns of [
    [checkRun(1, VERIFY, 'failure'), checkRun(2, REVIEW_CHECK, 'success')],
    [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'failure')],
    [checkRun(1, VERIFY, null, 'in_progress'), checkRun(2, REVIEW_CHECK, 'success')],
    [checkRun(2, REVIEW_CHECK, 'success')],
    [checkRun(1, VERIFY, 'success')],
  ]) {
    const github = fakeGithub({ checkRuns });
    const logs = await completeRun(github);
    assert.deepEqual(flips(github), [], JSON.stringify(checkRuns));
    assert.match(logs.join('\n'), /stays draft/);
  }
});

test('an unresolved review thread of any author keeps the PR draft', async () => {
  for (const login of ['github-actions', 'octocat']) {
    const github = fakeGithub({ threads: [
      { id: 'T0', isResolved: true, comments: { nodes: [{ databaseId: 1, author: { login } }] } },
      { id: 'T1', isResolved: false, comments: { nodes: [{ databaseId: 2, author: { login } }] } },
    ] });
    const logs = await completeRun(github);
    assert.deepEqual(flips(github), [], login);
    assert.match(logs.join('\n'), /1 review thread\(s\) unresolved/);
  }
});

test('leaves ready, moved, closed and fork PRs alone', async () => {
  const cases = [
    ['already ready', { pulls: [pullFixture({ draft: false })] }],
    ['head moved while checking', { live: () => pullFixture({ head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r' } } }) }],
    ['closed while checking', { live: () => pullFixture({ state: 'closed' }) }],
    ['made ready by hand while checking', { live: () => pullFixture({ draft: false }) }],
    ['fork', { pulls: [pullFixture({ head: { sha, repo: { full_name: 'fork/r' } } })] }],
    ['another head', { pulls: [pullFixture({ head: { sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } })] }],
    ['another base', { pulls: [pullFixture({ base: { ref: 'release' } })] }],
  ];
  for (const [label, state] of cases) {
    const github = fakeGithub(state);
    await completeRun(github);
    assert.deepEqual(flips(github), [], label);
  }
});

test('ignores workflow runs that did not come from a pull request', async () => {
  for (const payload of [workflowRun({ event: 'push' }), workflowRun({ event: 'workflow_dispatch' }), workflowRun({ head_sha: undefined })]) {
    const github = fakeGithub();
    await handleEvent({ github, owner, repo, eventName: 'workflow_run', payload });
    assert.deepEqual(github.calls, []);
  }
});

test('a new head converts a ready PR back to draft and moves its card to In progress', async () => {
  for (const action of ['opened', 'reopened', 'synchronize']) {
    const github = fakeGithub();
    const board = fakeBoard({ current: 'In review' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture({ draft: false }) } });
    assert.deepEqual(flips(github), [['convertPullRequestToDraft', 'PR_7']], action);
    assert.deepEqual(board.moves.map(({ optionId }) => optionId), ['opt-progress', 'opt-progress'], action);
  }
  const github = fakeGithub();
  await handleEvent({ github, owner, repo, eventName: 'pull_request_target', payload: { action: 'synchronize', pull_request: pullFixture() } });
  assert.deepEqual(flips(github), [], 'a draft stays draft without another mutation');
  const fork = fakeGithub();
  await handleEvent({ github: fork, owner, repo, eventName: 'pull_request_target',
    payload: { action: 'synchronize', pull_request: pullFixture({ draft: false, head: { sha, repo: { full_name: 'fork/r' } } }) } });
  assert.deepEqual(flips(fork), [], 'the workflow token cannot flip a fork PR');
});

test('a human flip moves the board without touching draft state', async () => {
  for (const [action, optionId] of [['ready_for_review', 'opt-review'], ['converted_to_draft', 'opt-progress']]) {
    const github = fakeGithub();
    const board = fakeBoard({ current: 'Todo' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture({ draft: action === 'converted_to_draft' }) } });
    assert.deepEqual(flips(github), []);
    assert.deepEqual(board.moves.map((move) => move.optionId), [optionId, optionId], action);
  }
});

test('marking ready moves the linked cards to In review', async () => {
  const board = fakeBoard({ current: 'In progress' });
  await completeRun(fakeGithub(), { projectGithub: board });
  assert.deepEqual(board.moves.map(({ itemId, optionId }) => [itemId, optionId]), [['PR_ITEM', 'opt-review'], ['ISSUE_ITEM', 'opt-review']]);
});

function boardItem(id, current, projectId = 'P1') {
  return {
    id,
    project: { id: projectId, field: { id: 'F1', options: [
      { id: 'opt-progress', name: 'In progress' }, { id: 'opt-review', name: 'In review' }, { id: 'opt-done', name: 'Done' },
    ] } },
    fieldValueByName: current === null ? null : { name: current },
  };
}

function boardData({ pullItems = [], issueItems = [] }) {
  return { repository: { pullRequest: {
    projectItems: { nodes: pullItems },
    closingIssuesReferences: { nodes: [{ projectItems: { nodes: issueItems } }] },
  } } };
}

function fakeBoard({ current = null, data = null, fail = false } = {}) {
  const board = { moves: [] };
  board.graphql = async (query, variables) => {
    if (fail) throw new Error('Resource not accessible by integration');
    if (query.includes('updateProjectV2ItemFieldValue')) { board.moves.push(variables); return {}; }
    return data ?? boardData({ pullItems: [boardItem('PR_ITEM', current)], issueItems: [boardItem('ISSUE_ITEM', current)] });
  };
  return board;
}

test('board moves skip Done, already-set, duplicate and statusless cards', () => {
  const noStatusField = { ...boardItem('NO_FIELD', null), project: { id: 'P2', field: null } };
  const moves = boardMoves(boardData({
    pullItems: [boardItem('A', 'In progress'), boardItem('B', 'Done'), boardItem('C', null), noStatusField],
    issueItems: [boardItem('C', null), boardItem('D', 'in review'), boardItem('E', 'Todo', 'P3')],
  }), BOARD.ready);
  assert.deepEqual(moves, [
    { projectId: 'P1', itemId: 'A', fieldId: 'F1', optionId: 'opt-review' },
    { projectId: 'P1', itemId: 'C', fieldId: 'F1', optionId: 'opt-review' },
    { projectId: 'P3', itemId: 'E', fieldId: 'F1', optionId: 'opt-review' },
  ]);
  assert.deepEqual(boardMoves(null, BOARD.draft), []);
});

test('board sync degrades quietly without a token or permission, and never blocks the flip', async () => {
  const logs = [];
  assert.deepEqual(await syncBoard({ projectGithub: null, owner, repo, pullNumber: 7, draft: true, log: (m) => logs.push(m) }),
    { moved: 0, skipped: 'no-token' });
  assert.deepEqual(await syncBoard({ projectGithub: fakeBoard({ fail: true }), owner, repo, pullNumber: 7, draft: true, log: (m) => logs.push(m) }),
    { moved: 0, skipped: 'error' });
  assert.match(logs.join('\n'), /no project token[\s\S]*Resource not accessible/);
  const github = fakeGithub();
  await completeRun(github, { projectGithub: fakeBoard({ fail: true }) });
  assert.deepEqual(flips(github), [['markPullRequestReadyForReview', 'PR_7']]);
});

test('a manual dispatch re-checks one PR after a thread is resolved by hand', async () => {
  const github = fakeGithub({ pulls: [pullFixture(), pullFixture({ number: 8, node_id: 'PR_8' })] });
  await handleEvent({ github, owner, repo, eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '8' } } });
  assert.deepEqual(flips(github), [['markPullRequestReadyForReview', 'PR_8']]);
  const closed = fakeGithub({ pulls: [pullFixture({ state: 'closed' })] });
  await handleEvent({ github: closed, owner, repo, eventName: 'workflow_dispatch', payload: { inputs: { pr_number: 7 } } });
  assert.deepEqual(flips(closed), []);
  for (const pr_number of ['0', '-1', 'abc', undefined]) {
    await assert.rejects(handleEvent({ github: fakeGithub(), owner, repo, eventName: 'workflow_dispatch', payload: { inputs: { pr_number } } }), /positive integer/);
  }
});

test('the readiness workflow runs trusted code with the least permissions that can flip drafts', async () => {
  const { parse } = await import('yaml');
  const source = fs.readFileSync(workflowPath, 'utf8');
  const workflow = parse(source);
  assert.deepEqual(workflow.on.pull_request_target.types, ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft']);
  assert.deepEqual(workflow.on.pull_request_target.branches, ['main']);
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['CI', 'Automated Code Review'], types: ['completed'] });
  assert.equal(workflow.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency['cancel-in-progress'], false, 'a flip must not be cancelled half-way');
  const job = workflow.jobs.readiness;
  assert.deepEqual(job.permissions, { checks: 'read', contents: 'write', 'pull-requests': 'write', statuses: 'read' });
  const [checkout, token, script] = job.steps;
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}', 'the script always comes from the default branch');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(job.steps.filter((step) => String(step.uses).startsWith('actions/checkout')).length, 1, 'no pull-request code is checked out');
  assert.doesNotMatch(source, /refs\/pull\/|head\.sha \}\}\n\s+persist/);
  for (const step of job.steps) assert.match(step.uses, /@[0-9a-f]{40}$|@[0-9a-f]{40} /, `${step.name} must be pinned to a commit`);
  assert.match(source, /uses: actions\/[\w-]+@[0-9a-f]{40}/);
  assert.equal(token['continue-on-error'], true, 'a missing App permission must not fail readiness');
  assert.equal(token.with['permission-organization-projects'], 'write');
  assert.match(token.if, /vars\.RELEASE_APP_CLIENT_ID != ''/);
  assert.equal(token.with['client-id'], '${{ vars.RELEASE_APP_CLIENT_ID }}');
  assert.equal(token.with['app-id'], undefined);
  assert.match(script.with.script, /process\.env\.BOARD_TOKEN \? getOctokit\(process\.env\.BOARD_TOKEN\) : null/);
  assert.match(script.with.script, /require\('\.\/\.github\/scripts\/pr-readiness\.cjs'\)/);
  assert.equal(script.env.BOARD_TOKEN, '${{ steps.board_app.outputs.token }}');
});
