const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readiness = require('./pr-readiness.cjs');
const {
  REVIEW_CHECK,
  BOARD,
  requiredCheckNames,
  evaluateChecks,
  boardMoves,
  syncBoard,
  discoverReadiness,
  refreshReadiness,
} = require('./pr-readiness.cjs');

const { reviewState, reviewData } = require('./coderabbit.testkit.cjs');
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
    changed_files: 1,
    user: { login: 'author' },
    draft: true,
    head: { sha, ref: 'feature', repo: { full_name: `${owner}/${repo}` } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: `${owner}/${repo}` } },
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
    ...reviewState(),
    pulls: [pullFixture()],
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: VERIFY }] } }],
    checkRuns: [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'success')],
    statuses: [],
    threads: [],
    ...state,
  };
  s.run.pull_requests = s.pulls.map(p => ({ number: p.number, head: { sha: p.head.sha }, base: { ref: p.base.ref } }));
  s.run.conclusion = 'success';
  s.jobs[0].conclusion = 'success';
  const github = {
    calls,
    state: s,
    request: async (route, params) => {
      calls.push(['request', route, params.branch]);
      if (route.endsWith('/rules/branches/{branch}')) return { data: s.rules };
      s.pr = s.live?.(params.pull_number ?? 7) ?? s.pulls.find(p => p.number === (params.pull_number ?? 7)) ?? s.pulls[0];
      return { data: structuredClone(reviewData(s, route, params)) };
    },
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
      const pull = s.pulls.find(p => p.node_id === variables.id);
      if (pull && name) pull.draft = name === 'convertPullRequestToDraft';
      return {};
    },
  };
  return github;
}

const flips = (github) => github.calls.filter(([name]) => name === 'convertPullRequestToDraft' || name === 'markPullRequestReadyForReview');

const workflowRun = (overrides = {}) => ({ action: 'completed',
  workflow_run: { ...reviewState().run, ...overrides } });

function eventArgs(args) {
  const payload = { repository: { full_name: 'o/r' }, ...args.payload };
  if (args.eventName === 'check_run') {
    payload.action ??= 'completed';
    payload.check_run = { ...args.github.state.checks[0], ...payload.check_run };
  }
  return { ...args, owner, repo, payload };
}
async function handleEvent(args) {
  const input = eventArgs(args);
  const { numbers } = await discoverReadiness(input);
  return Promise.all(numbers.map(pullNumber => refreshReadiness({ ...input, pullNumber })));
}

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
    checkRuns: [checkRun(1, VERIFY, 'failure'), checkRun(5, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'success')],
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

test('a skipped protected review cannot replace native success', async () => {
  const github = fakeGithub({ checkRuns: [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'skipped')] });
  await completeRun(github);
  assert.deepEqual(flips(github), []);
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
    assert.match(logs.join('\n'), /readiness unchanged/);
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
    assert.match(logs.join('\n'), /readiness unchanged/);
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
  for (const payload of [workflowRun({ event: 'merge_group' }), workflowRun({ event: 'push' }), workflowRun({ event: 'workflow_dispatch' }), workflowRun({ head_sha: undefined })]) {
    const github = fakeGithub();
    await handleEvent({ github, owner, repo, eventName: 'workflow_run', payload });
    assert.deepEqual(flips(github), []);
    assert.equal(github.calls.some(([name, route]) => name === 'pulls.list' || route === 'GET /repos/{owner}/{repo}/pulls'), false);
  }
});

test('a new head converts a ready PR back to draft and moves its card to In progress', async () => {
  for (const action of ['opened', 'reopened', 'synchronize']) {
    const github = fakeGithub({ pulls: [pullFixture({ draft: false })], checkRuns: [] });
    const board = fakeBoard({ current: 'In review' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture({ draft: false }) } });
    assert.deepEqual(flips(github), [['convertPullRequestToDraft', 'PR_7']], action);
    assert.deepEqual(board.moves.map(({ optionId }) => optionId), ['opt-progress', 'opt-progress'], action);
  }
  const github = fakeGithub({ checkRuns: [] });
  await handleEvent({ github, owner, repo, eventName: 'pull_request_target', payload: { action: 'synchronize', pull_request: pullFixture() } });
  assert.deepEqual(flips(github), [], 'a draft stays draft without another mutation');
  const fork = fakeGithub({ pulls: [pullFixture({ head: { sha, ref: 'feature', repo: { full_name: 'fork/r' } } })] });
  await handleEvent({ github: fork, owner, repo, eventName: 'pull_request_target',
    payload: { action: 'synchronize', pull_request: pullFixture({ draft: false, head: { sha, repo: { full_name: 'fork/r' } } }) } });
  assert.deepEqual(flips(fork), [], 'the workflow token cannot flip a fork PR');
});

test('human flips reevaluate fresh admission and sync the computed board state', async () => {
  for (const action of ['ready_for_review', 'converted_to_draft']) {
    const github = fakeGithub({ pulls: [pullFixture({ draft: action === 'converted_to_draft' })] });
    const board = fakeBoard({ current: 'Todo' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture({ draft: action === 'converted_to_draft' }) } });
    assert.equal(github.state.pulls[0].draft, false);
    assert.deepEqual(flips(github), action === 'converted_to_draft' ? [['markPullRequestReadyForReview', 'PR_7']] : []);
    assert.deepEqual(board.moves.map((move) => move.optionId), ['opt-review', 'opt-review'], action);
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
  const board = { moves: [], data: data ?? boardData({ pullItems: [boardItem('PR_ITEM', current)], issueItems: [boardItem('ISSUE_ITEM', current)] }) };
  board.graphql = async (query, variables) => {
    if (fail) throw new Error('Resource not accessible by integration');
    if (query.includes('updateProjectV2ItemFieldValue')) {
      board.moves.push(variables);
      const pull = board.data.repository.pullRequest;
      const items = [...pull.projectItems.nodes, ...pull.closingIssuesReferences.nodes.flatMap(issue => issue.projectItems.nodes)];
      for (const item of items.filter(item => item.id === variables.itemId)) {
        item.fieldValueByName = { name: item.project.field.options.find(option => option.id === variables.optionId).name };
      }
      return {};
    }
    return structuredClone(board.data);
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
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['CI', 'CodeRabbit review signal'], types: ['completed'] });
  assert.equal(workflow.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency, undefined, 'discovery cannot coalesce different PRs');
  const discovery = workflow.jobs.discover;
  assert.equal(discovery.concurrency, undefined, 'each event discovers independently');
  assert.deepEqual(discovery.permissions, { actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' });
  assert.deepEqual(discovery.outputs, { numbers: '${{ steps.discover.outputs.numbers }}' });
  assert.equal(discovery.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(discovery.steps[0].with['persist-credentials'], false);
  assert.match(discovery.steps[1].with.script, /discoverReadiness/);
  assert.equal(discovery.steps[1].with.retries, 0);
  const job = workflow.jobs.readiness;
  assert.equal(job.needs, 'discover');
  assert.equal(job.if, "needs.discover.outputs.numbers != '[]'");
  assert.deepEqual(job.strategy, { 'fail-fast': false, 'max-parallel': 4,
    matrix: { pr: '${{ fromJSON(needs.discover.outputs.numbers) }}' } });
  assert.deepEqual(job.concurrency, { group: 'pr-readiness-pr-${{ matrix.pr }}', 'cancel-in-progress': false });
  assert.deepEqual(job.permissions, { actions: 'read', checks: 'read', contents: 'write', 'pull-requests': 'write', statuses: 'read' });
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
  assert.equal(script.env.READINESS_PR, '${{ matrix.pr }}');
  assert.match(script.with.script, /refreshReadiness/);
  assert.doesNotMatch(script.with.script, /payload:|head_sha|head\.sha/);
  assert.equal(script.with.retries, 0);
});

for (const condition of ['pending', 'failed', 'reopened thread', 'native failure', 'native dispatch']) {
  test(`ready state is revoked on fresh ${condition} despite historical green check names`, async () => {
    const github = fakeGithub({ pulls: [pullFixture({ draft: false })] });
    if (condition === 'pending') github.state.checks[0].status = 'in_progress';
    if (condition === 'failed') github.state.checks[0].conclusion = 'failure';
    if (condition === 'reopened thread') github.state.threads = [{ id: 't', isResolved: false, isOutdated: true }];
    if (condition === 'native failure') github.state.jobs[0].conclusion = 'failure';
    if (condition === 'native dispatch') github.state.run.event = 'workflow_dispatch';
    await handleEvent({ github, owner, repo, eventName: 'check_run', payload: { check_run: {
      name: 'CodeRabbit', app: { id: 347564, slug: 'coderabbitai' }, head_sha: sha,
    } } });
    assert.deepEqual(flips(github), [['convertPullRequestToDraft', 'PR_7']]);
  });
}
test('a wrong-App provider wake cannot flip draft state', async () => {
  const github = fakeGithub();
  await handleEvent({ github, owner, repo, eventName: 'check_run', payload: { check_run: { name: 'CodeRabbit', app: { id: 1 }, head_sha: sha } } });
  assert.deepEqual(github.calls, []);
});


function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Execute the checked-in workflow's grouping rule, including its old branch/SHA
// expression in red proof. The test never substitutes a universal test-only lock.
async function workflowQueue(onEnqueue = () => {}) {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const matrix = Boolean(workflow.jobs.discover);
  const expression = (workflow.jobs.readiness.concurrency ?? workflow.concurrency).group;
  const slots = new Map();
  function group(input, number) {
    const context = { github: { event: input.payload }, inputs: input.payload.inputs, matrix: { pr: number } };
    return expression.replace(/\$\{\{(.*?)\}\}/g, (_, source) => source.split('||')
      .map(term => term.trim().split('.').reduce((value, key) => value?.[key], context)).find(Boolean) ?? '');
  }
  return async args => {
    const input = eventArgs(args);
    const numbers = matrix ? (await readiness.discoverReadiness(input)).numbers : [null];
    return Promise.all(numbers.map(number => {
      const key = group(input, number);
      const work = () => matrix ? readiness.refreshReadiness({ ...input, pullNumber: number }) : readiness.handleEvent(input);
      const result = scheduleLatest(slots, key, work);
      onEnqueue(number);
      return result;
    }));
  };
}

// GitHub keeps one running and one pending job per group. A later pending job
// replaces the earlier pending job; it cannot interrupt the running mutation.
function scheduleLatest(slots, key, work) {
  return new Promise((resolve, reject) => {
    const job = { work, resolve, reject };
    const slot = slots.get(key);
    if (slot) {
      slot.pending?.resolve('coalesced');
      slot.pending = job;
    } else {
      const next = { pending: null };
      slots.set(key, next);
      startQueued(slots, key, next, job);
    }
  });
}
function startQueued(slots, key, slot, job) {
  Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
    const pending = slot.pending;
    if (!pending) { slots.delete(key); return; }
    slot.pending = null;
    startQueued(slots, key, slot, pending);
  });
}

function holdFinalPull(github) {
  const held = barrier(), release = barrier();
  const request = github.request, get = github.rest.pulls.get;
  let providerReads = 0, blocked = false;
  github.request = async (route, args) => {
    const result = await request(route, args);
    if (route.endsWith('/commits/{ref}/check-runs')) providerReads++;
    return result;
  };
  github.rest.pulls.get = async args => {
    const result = structuredClone(await get(args));
    if (providerReads >= 2 && !blocked) {
      blocked = true;
      held.resolve();
      await release.promise;
    }
    return result;
  };
  return { held: held.promise, release: release.resolve };
}

// bound: barriers identify the exact admitted-read and queued-job boundaries;
// this timeout only detects a broken fixture or workflow deadlock.
test('cross-kind readiness jobs serialize revocation after an older admitted CI job', { timeout: 10000 }, async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  const hold = holdFinalPull(github), queued = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => { if (++count === 2) queued.resolve(); });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await hold.held;
  github.state.checks[0].status = 'in_progress';
  github.state.checks[0].conclusion = null;
  const revocation = enqueue({ github, projectGithub: board, eventName: 'check_run', payload: { action: 'created' } });
  await queued.promise;
  // The old workflow's different key starts revocation immediately. Drain that
  // job before releasing the older cached decision to make its overwrite exact.
  if (!readiness.refreshReadiness) await revocation;
  hold.release();
  await Promise.all([older, revocation]);
  assert.equal(github.state.pulls[0].draft, true, 'pending provider must win after both jobs settle');
  const pull = board.data.repository.pullRequest;
  assert.deepEqual([pull.projectItems.nodes[0], pull.closingIssuesReferences.nodes[0].projectItems.nodes[0]]
    .map(item => item.fieldValueByName.name), ['In progress', 'In progress']);
});

test('a late synchronize wake uses current green proof instead of forcing draft forever', async () => {
  const github = fakeGithub({ pulls: [pullFixture({ draft: false })] });
  const enqueue = await workflowQueue();
  await enqueue({ github, eventName: 'pull_request_target', payload: { action: 'synchronize',
    pull_request: pullFixture({ draft: false, head: { sha: 'c'.repeat(40), ref: 'feature', repo: { full_name: 'o/r' } } }) } });
  assert.equal(github.state.pulls[0].draft, false);
  assert.deepEqual(flips(github), []);
});

test('a valid old CI wake discovers current PRs and reads the newest live proof', async () => {
  const github = fakeGithub();
  const old = { ...github.state.run, id: 19, head_sha: 'c'.repeat(40) };
  const request = github.request;
  github.request = async (route, args) => args.run_id === old.id && route.endsWith('/runs/{run_id}')
    ? { data: structuredClone(old) } : request(route, args);
  const enqueue = await workflowQueue();
  await enqueue({ github, eventName: 'workflow_run', payload: workflowRun(old) });
  assert.equal(github.state.pulls[0].draft, false, 'historical event cannot select historical proof');
});

test('a stale human flip uses live failed proof instead of its ready payload', async () => {
  const github = fakeGithub({ pulls: [pullFixture({ draft: true })] });
  github.state.checks[0].conclusion = 'failure';
  const board = fakeBoard({ current: 'In review' });
  await handleEvent({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'ready_for_review', pull_request: pullFixture({ draft: false }) } });
  assert.deepEqual(flips(github), []);
  assert.deepEqual(board.moves.map(move => move.optionId), ['opt-progress', 'opt-progress']);
});

// bound: B's mutation is the signal that independent PR work progressed while A
// was held; the timeout detects accidental repository-wide serialization.
test('independent automatic A and B events keep separate discovery and production PR queues', { timeout: 10000 }, async () => {
  const a = fakeGithub(), b = fakeGithub({ pulls: [pullFixture({ number: 8, node_id: 'PR_8' })] });
  a.state.checks[0].pull_requests = structuredClone(a.state.run.pull_requests);
  b.state.checks[0].pull_requests = structuredClone(b.state.run.pull_requests);
  const held = barrier(), release = barrier(), bReady = barrier();
  const get = a.rest.pulls.get, graphql = b.graphql;
  a.rest.pulls.get = async args => { held.resolve(); await release.promise; return get(args); };
  b.graphql = async (query, vars) => {
    const result = await graphql(query, vars);
    if (vars.id === 'PR_8') bReady.resolve();
    return result;
  };
  const enqueue = await workflowQueue();
  const first = enqueue({ github: a, eventName: 'check_run', payload: {} });
  await held.promise;
  const second = enqueue({ github: b, eventName: 'check_run', payload: {} });
  await bReady.promise;
  assert.equal(b.state.pulls[0].draft, false);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(a.state.pulls[0].draft, false);
});

// bound: explicit read/queue barriers control replacement, not elapsed time.
test('a human wake replacing a pending revoker still revokes failed admission', { timeout: 10000 }, async () => {
  const github = fakeGithub(), board = fakeBoard({ current: 'In progress' });
  const hold = holdFinalPull(github), pending = barrier(), replacement = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => {
    count++;
    if (count === 2) pending.resolve();
    if (count === 3) replacement.resolve();
  });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await hold.held;
  github.state.checks[0].conclusion = 'failure';
  const revoker = enqueue({ github, projectGithub: board, eventName: 'check_run', payload: {} });
  await pending.promise;
  const human = enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'ready_for_review', pull_request: pullFixture({ draft: false }) } });
  await replacement.promise;
  // Under the former branch/SHA grouping the check job runs independently.
  if (!readiness.refreshReadiness) await revoker;
  hold.release();
  await Promise.all([older, revoker, human]);
  assert.equal(github.state.pulls[0].draft, true);
  assert.equal(board.data.repository.pullRequest.projectItems.nodes[0].fieldValueByName.name, 'In progress');
});

test('human ready requests require fresh admission before preserving ready state', async () => {
  const github = fakeGithub({ pulls: [pullFixture({ draft: false })] });
  github.state.checks[0].conclusion = 'failure';
  const board = fakeBoard({ current: 'In review' });
  const enqueue = await workflowQueue();
  await enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'ready_for_review', pull_request: pullFixture({ draft: false }) } });
  assert.equal(github.state.pulls[0].draft, true);
  assert.equal(board.data.repository.pullRequest.projectItems.nodes[0].fieldValueByName.name, 'In progress');
});


test('a head change after proof is read refuses a stale readiness mutation', async () => {
  const github = fakeGithub();
  let providerReads = 0;
  const request = github.request;
  github.request = async (route, args) => {
    const result = await request(route, args);
    if (route.endsWith('/commits/{ref}/check-runs') && ++providerReads === 2) {
      github.state.pulls[0].head.sha = 'd'.repeat(40);
    }
    return result;
  };
  await completeRun(github);
  assert.equal(github.state.pulls[0].draft, true);
  assert.deepEqual(flips(github), []);
});

test('readiness accepts the official no-permission signal association instead of its merge SHA', async () => {
  const github = fakeGithub();
  github.state.signal = { id: 40, name: 'CodeRabbit review signal', run_attempt: 1, workflow_id: 4,
    path: '.github/workflows/coderabbit-review-signal.yml', event: 'pull_request_review_comment',
    head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', repository: { id: 1, full_name: 'o/r' },
    head_repository: { full_name: 'o/r' }, pull_requests: [{ number: 7, head: { sha, repo: { id: 1 } },
      base: { ref: 'main', repo: { id: 1 } } }] };
  const payload = { action: 'completed', workflow_run: structuredClone(github.state.signal) };
  await handleEvent({ github, eventName: 'workflow_run', payload });
  assert.equal(github.state.pulls[0].draft, false);
  github.state.signal.workflow_id = 9;
  assert.deepEqual(await discoverReadiness(eventArgs({ github, eventName: 'workflow_run', payload })), { numbers: [] });
});


// bound: hold the exact old failed decision while two pending jobs coalesce.
test('a human wake replacing pending promotion still promotes current admitted proof', { timeout: 10000 }, async () => {
  const github = fakeGithub({ pulls: [pullFixture({ draft: false })] });
  github.state.checks[0].conclusion = 'failure';
  const board = fakeBoard({ current: 'In review' });
  const hold = holdFinalPull(github), pending = barrier(), replacement = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => {
    if (++count === 2) pending.resolve();
    if (count === 3) replacement.resolve();
  });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await hold.held;
  github.state.checks[0].conclusion = 'success';
  const promotion = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await pending.promise;
  const human = enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'converted_to_draft', pull_request: pullFixture() } });
  await replacement.promise;
  hold.release();
  await Promise.all([older, promotion, human]);
  assert.equal(github.state.pulls[0].draft, false, 'fresh admitted proof must survive replacement of pending promotion');
  assert.equal(board.data.repository.pullRequest.projectItems.nodes[0].fieldValueByName.name, 'In review');
});

for (const event of ['CI', 'provider']) test(`readiness ${event} discovery bounds proof work with 63 unrelated PRs`, async () => {
  const github = fakeGithub();
  github.state.pulls.push(...Array.from({ length: 63 }, (_, i) => pullFixture({ number: i + 100, node_id: `PR_${i + 100}`,
    head: { sha: 'b'.repeat(40), ref: 'other', repo: { full_name: 'o/r' } } })));
  github.state.checks[0].pull_requests = structuredClone(github.state.run.pull_requests);
  const input = eventArgs({ github, eventName: event === 'CI' ? 'workflow_run' : 'check_run', payload: event === 'CI' ? workflowRun() : {} });
  const result = await discoverReadiness(input);
  assert.deepEqual(result, { numbers: [7] });
  assert.equal(github.calls.some(([name, route]) => name === 'pulls.list' || route === 'GET /repos/{owner}/{repo}/pulls'), false);
  await Promise.all(result.numbers.map(pullNumber => refreshReadiness({ ...input, pullNumber })));
  assert.deepEqual(flips(github), [['markPullRequestReadyForReview', 'PR_7']]);
});
