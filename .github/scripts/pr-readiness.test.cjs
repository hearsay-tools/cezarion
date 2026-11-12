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
} = require('./pr-readiness.cjs');
// The board follows the merged per-PR job of Reconcile CodeRabbit admission.
const { discover, reconcile } = require('./coderabbit-reconcile.cjs');
const { reader } = require('./queue-ci-proof.cjs');

const { reviewState, reviewData, providerRead } = require('./coderabbit.testkit.cjs');
const workflowPath = path.join(__dirname, '..', 'workflows', 'coderabbit-reconcile.yml');
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
    draft: false,
    head: { sha, ref: 'feature', repo: { full_name: `${owner}/${repo}` } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: `${owner}/${repo}` } },
    ...overrides,
  };
}

function checkRun(id, name, conclusion, status = 'completed') {
  return { id, name, status, conclusion };
}

// A GitHub client double: every call is recorded, and each read answers from `state`.
// Its only write is the targeted native rerun; nothing changes draft state.
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
      calls.push(['request', route, params]);
      s.pr = s.live?.(params.pull_number ?? 7) ?? s.pulls.find(p => p.number === (params.pull_number ?? 7)) ?? s.pulls[0];
      return { data: structuredClone(reviewData(s, route, params)) };
    },
  };
  return github;
}

const workflowRun = (overrides = {}) => ({ action: 'completed',
  workflow_run: { ...reviewState().run, ...overrides } });

function eventArgs(args) {
  const payload = { repository: { full_name: 'o/r' }, ...args.payload };
  if (args.eventName === 'check_run') {
    payload.action ??= 'completed';
    payload.check_run = { ...args.github.state.checks[0], ...payload.check_run };
  }
  const s = args.github.state;
  return { now: () => s.clock, sleep: async ms => { s.clock += ms; }, ...args, owner, repo, payload };
}
async function handleEvent(args) {
  const input = eventArgs(args);
  const { numbers } = await discover(input);
  return Promise.all(numbers.map(pullNumber => reconcile({ ...input, pullNumber })));
}

async function completeRun(github, extra = {}) {
  const logs = [];
  await handleEvent({ github, owner, repo, eventName: 'workflow_run', payload: workflowRun(), log: (m) => logs.push(m), ...extra });
  return logs;
}

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
  const board = { moves: [], numbers: [], data: data ?? boardData({ pullItems: [boardItem('PR_ITEM', current)], issueItems: [boardItem('ISSUE_ITEM', current)] }) };
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
    board.numbers.push(variables.number);
    return structuredClone(board.data);
  };
  return board;
}

// The status of the PR card and the closing issue card, in that order.
function cards(board) {
  const pull = board.data.repository.pullRequest;
  return [pull.projectItems.nodes[0], pull.closingIssuesReferences.nodes[0].projectItems.nodes[0]]
    .map(item => item.fieldValueByName?.name ?? null);
}
const IN_REVIEW = ['In review', 'In review'];
const IN_PROGRESS = ['In progress', 'In progress'];

test('requires the ruleset checks plus the automated review check', async () => {
  const github = fakeGithub({ rules: [
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: VERIFY }, { context: '' }, {}] } },
  ] });
  const read = client => reader(client, owner, repo, Date.now() + 60000, Date.now);
  assert.deepEqual(await requiredCheckNames(read(github), 'main'), [REVIEW_CHECK, VERIFY].sort());
  await assert.rejects(requiredCheckNames(read(fakeGithub({ rules: { message: 'not a list' } })), 'main'), /branch rules/);
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

test('a ready PR whose head checks are green moves its linked cards to In review', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(board.moves.map(({ itemId, optionId }) => [itemId, optionId]), [['PR_ITEM', 'opt-review'], ['ISSUE_ITEM', 'opt-review']]);
  assert.ok(github.calls.some(([, route, params]) => route.endsWith('/commits/{ref}/check-runs') && !params.check_name
    && params.ref === sha), 'checks are read for the run head, not a branch');
});

test('a skipped protected review cannot replace native success', async () => {
  const github = fakeGithub({ checkRuns: [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'skipped')] });
  const board = fakeBoard({ current: 'In review' });
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(cards(board), IN_PROGRESS);
});

test('a red, pending or missing required check keeps the PR ready and moves its cards to In progress', async () => {
  for (const checkRuns of [
    [checkRun(1, VERIFY, 'failure'), checkRun(2, REVIEW_CHECK, 'success')],
    [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'failure')],
    [checkRun(1, VERIFY, null, 'in_progress'), checkRun(2, REVIEW_CHECK, 'success')],
    [checkRun(2, REVIEW_CHECK, 'success')],
    [checkRun(1, VERIFY, 'success')],
  ]) {
    const github = fakeGithub({ checkRuns });
    const board = fakeBoard({ current: 'In review' });
    const logs = await completeRun(github, { projectGithub: board });
    assert.equal(github.state.pulls[0].draft, false, JSON.stringify(checkRuns));
    assert.deepEqual(cards(board), IN_PROGRESS, JSON.stringify(checkRuns));
    assert.match(logs.join('\n'), /board follows In progress \(admitted=false, draft=false\)/);
  }
});

test('an unresolved review thread of any author keeps the PR ready and moves its cards to In progress', async () => {
  for (const login of ['github-actions', 'octocat']) {
    const github = fakeGithub({ threads: [
      { id: 'T0', isResolved: true, comments: { nodes: [{ databaseId: 1, author: { login } }] } },
      { id: 'T1', isResolved: false, comments: { nodes: [{ databaseId: 2, author: { login } }] } },
    ] });
    const board = fakeBoard({ current: 'In review' });
    await completeRun(github, { projectGithub: board });
    assert.equal(github.state.pulls[0].draft, false, login);
    assert.deepEqual(cards(board), IN_PROGRESS, login);
  }
});

test('a human draft stays a draft, and its cards stay In progress with green checks', async () => {
  const github = fakeGithub({ pulls: [pullFixture({ draft: true })] });
  const board = fakeBoard({ current: 'In review' });
  const logs = await completeRun(github, { projectGithub: board });
  assert.equal(github.state.pulls[0].draft, true);
  assert.deepEqual(cards(board), IN_PROGRESS);
  assert.match(logs.join('\n'), /admitted=true, draft=true/);
});

test('a Done card never moves back, whatever the head state', async () => {
  for (const checkRuns of [[checkRun(1, VERIFY, 'failure')], [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'success')]]) {
    const board = fakeBoard({ current: 'Done' });
    await completeRun(fakeGithub({ checkRuns }), { projectGithub: board });
    assert.deepEqual(board.moves, []);
    assert.deepEqual(cards(board), ['Done', 'Done']);
  }
});

test('skips moved, closed, fork and unrelated PRs', async () => {
  const cases = [
    ['head moved while checking', { live: () => pullFixture({ head: { sha: 'b'.repeat(40), repo: { full_name: 'o/r' } } }) }],
    ['closed while checking', { live: () => pullFixture({ state: 'closed' }) }],
    ['fork', { pulls: [pullFixture({ head: { sha, repo: { full_name: 'fork/r' } } })] }],
    ['another head', { pulls: [pullFixture({ head: { sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } })] }],
    ['another base', { pulls: [pullFixture({ base: { ref: 'release' } })] }],
  ];
  for (const [label, state] of cases) {
    const board = fakeBoard({ current: 'In progress' });
    await completeRun(fakeGithub(state), { projectGithub: board });
    assert.deepEqual(board.moves, [], label);
  }
});

test('ignores workflow runs that did not come from a pull request', async () => {
  for (const payload of [workflowRun({ event: 'merge_group' }), workflowRun({ event: 'push' }), workflowRun({ event: 'workflow_dispatch' }), workflowRun({ head_sha: undefined })]) {
    const github = fakeGithub();
    const board = fakeBoard({ current: 'In progress' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'workflow_run', payload });
    assert.deepEqual(board.numbers, []);
    assert.equal(github.calls.some(([, route]) => route === 'GET /repos/{owner}/{repo}/pulls'), false);
  }
});

test('a new head keeps a ready PR ready and moves its cards to In progress', async () => {
  for (const action of ['opened', 'reopened', 'synchronize']) {
    const github = fakeGithub({ checkRuns: [] });
    const board = fakeBoard({ current: 'In review' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture() } });
    assert.equal(github.state.pulls[0].draft, false, action);
    assert.deepEqual(board.moves.map(({ optionId }) => optionId), ['opt-progress', 'opt-progress'], action);
  }
  const fork = fakeGithub({ pulls: [pullFixture({ head: { sha, ref: 'feature', repo: { full_name: 'fork/r' } } })] });
  const board = fakeBoard({ current: 'In review' });
  await handleEvent({ github: fork, projectGithub: board, owner, repo, eventName: 'pull_request_target',
    payload: { action: 'synchronize', pull_request: pullFixture({ head: { sha, repo: { full_name: 'fork/r' } } }) } });
  assert.deepEqual(board.moves, [], 'a fork PR is not synced');
});

test('human flips reevaluate fresh admission and sync the board without changing draft state', async () => {
  for (const [action, draft, status] of [['ready_for_review', false, 'opt-review'], ['converted_to_draft', true, 'opt-progress']]) {
    const github = fakeGithub({ pulls: [pullFixture({ draft })] });
    const board = fakeBoard({ current: 'Todo' });
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture({ draft }) } });
    assert.equal(github.state.pulls[0].draft, draft, action);
    assert.deepEqual(board.moves.map((move) => move.optionId), [status, status], action);
  }
});

test('board moves skip Done, already-set, duplicate and statusless cards', () => {
  const noStatusField = { ...boardItem('NO_FIELD', null), project: { id: 'P2', field: null } };
  const moves = boardMoves(boardData({
    pullItems: [boardItem('A', 'In progress'), boardItem('B', 'Done'), boardItem('C', null), noStatusField],
    issueItems: [boardItem('C', null), boardItem('D', 'in review'), boardItem('E', 'Todo', 'P3')],
  }), BOARD.review);
  assert.deepEqual(moves, [
    { projectId: 'P1', itemId: 'A', fieldId: 'F1', optionId: 'opt-review' },
    { projectId: 'P1', itemId: 'C', fieldId: 'F1', optionId: 'opt-review' },
    { projectId: 'P3', itemId: 'E', fieldId: 'F1', optionId: 'opt-review' },
  ]);
  assert.deepEqual(boardMoves(null, BOARD.progress), []);
});

test('board sync degrades quietly without a token or permission', async () => {
  const logs = [];
  assert.deepEqual(await syncBoard({ projectGithub: null, owner, repo, pullNumber: 7, status: BOARD.progress, log: (m) => logs.push(m) }),
    { moved: 0, skipped: 'no-token' });
  assert.deepEqual(await syncBoard({ projectGithub: fakeBoard({ fail: true }), owner, repo, pullNumber: 7, status: BOARD.progress, log: (m) => logs.push(m) }),
    { moved: 0, skipped: 'error' });
  assert.match(logs.join('\n'), /no project token[\s\S]*Resource not accessible/);
  const runLogs = await completeRun(fakeGithub(), { projectGithub: fakeBoard({ fail: true }) });
  assert.match(runLogs.join('\n'), /board follows In review[\s\S]*Board sync skipped/);
});

test('a manual dispatch re-checks one PR after a thread is resolved by hand', async () => {
  const github = fakeGithub({ pulls: [pullFixture(), pullFixture({ number: 8, node_id: 'PR_8' })] });
  const board = fakeBoard({ current: 'In progress' });
  await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '8' } } });
  assert.deepEqual(board.numbers, [8]);
  assert.deepEqual(cards(board), IN_REVIEW);
  const closed = fakeGithub({ pulls: [pullFixture({ state: 'closed' })] });
  const closedBoard = fakeBoard({ current: 'In progress' });
  await handleEvent({ github: closed, projectGithub: closedBoard, owner, repo, eventName: 'workflow_dispatch', payload: { inputs: { pr_number: 7 } } });
  assert.deepEqual(closedBoard.numbers, []);
  for (const pr_number of ['0', '-1', 'abc', undefined]) {
    await assert.rejects(handleEvent({ github: fakeGithub(), owner, repo, eventName: 'workflow_dispatch', payload: { inputs: { pr_number } } }), /positive integer/);
  }
});

for (const condition of ['pending', 'failed', 'reopened thread', 'native failure', 'native dispatch']) {
  test(`cards leave In review on fresh ${condition} despite historical green check names`, async () => {
    const github = fakeGithub();
    const board = fakeBoard({ current: 'In review' });
    if (condition === 'pending') github.state.checks[0].status = 'in_progress';
    if (condition === 'failed') github.state.checks[0].conclusion = 'failure';
    if (condition === 'reopened thread') github.state.threads = [{ id: 't', isResolved: false, isOutdated: true }];
    if (condition === 'native failure') github.state.jobs[0].conclusion = 'failure';
    if (condition === 'native dispatch') github.state.run.event = 'workflow_dispatch';
    await handleEvent({ github, projectGithub: board, owner, repo, eventName: 'check_run', payload: { check_run: {
      name: 'CodeRabbit', app: { id: 347564, slug: 'coderabbitai' }, head_sha: sha,
    } } });
    assert.equal(github.state.pulls[0].draft, false);
    assert.deepEqual(cards(board), IN_PROGRESS);
  });
}
test('a wrong-App provider wake reads nothing', async () => {
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
  const expression = workflow.jobs.reconcile.concurrency.group;
  const slots = new Map();
  function group(input, number) {
    const context = { github: { event: input.payload }, inputs: input.payload.inputs, matrix: { pr: number } };
    return expression.replace(/\$\{\{(.*?)\}\}/g, (_, source) => source.split('||')
      .map(term => term.trim().split('.').reduce((value, key) => value?.[key], context)).find(Boolean) ?? '');
  }
  return async args => {
    const input = eventArgs(args);
    const { numbers } = await discover(input);
    return Promise.all(numbers.map(number => {
      const key = group(input, number);
      const work = () => reconcile({ ...input, pullNumber: number });
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

// Holds the first board read: the job has decided its status from proof and
// admission, and still holds the PR lock, but has not moved a card yet.
function holdBoard(board) {
  const held = barrier(), release = barrier();
  const graphql = board.graphql;
  let blocked = false;
  board.graphql = async (query, variables) => {
    if (!blocked && !query.includes('updateProjectV2ItemFieldValue')) {
      blocked = true;
      held.resolve();
      await release.promise;
    }
    return graphql(query, variables);
  };
  return { held: held.promise, release: release.resolve };
}

// bound: barriers identify the exact admitted-read and queued-job boundaries;
// this timeout only detects a broken fixture or workflow deadlock.
test('cross-kind readiness jobs serialize revocation after an older admitted CI job', { timeout: 10000 }, async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  const hold = holdBoard(board), queued = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => { if (++count === 2) queued.resolve(); });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await hold.held;
  github.state.checks[0].status = 'in_progress';
  github.state.checks[0].conclusion = null;
  const revocation = enqueue({ github, projectGithub: board, eventName: 'check_run', payload: { action: 'created' } });
  await queued.promise;
  hold.release();
  await Promise.all([older, revocation]);
  assert.deepEqual(cards(board), IN_PROGRESS, 'pending provider must win after both jobs settle');
});

test('a late synchronize wake uses current green proof', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  const enqueue = await workflowQueue();
  await enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: { action: 'synchronize',
    pull_request: pullFixture({ head: { sha: 'c'.repeat(40), ref: 'feature', repo: { full_name: 'o/r' } } }) } });
  assert.deepEqual(cards(board), IN_REVIEW);
});

test('a valid old CI wake discovers current PRs and reads the newest live proof', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  const old = { ...github.state.run, id: 19, head_sha: 'c'.repeat(40) };
  const request = github.request;
  github.request = async (route, args) => args.run_id === old.id && route.endsWith('/runs/{run_id}')
    ? { data: structuredClone(old) } : request(route, args);
  const enqueue = await workflowQueue();
  await enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun(old) });
  assert.deepEqual(cards(board), IN_REVIEW, 'historical event cannot select historical proof');
});

test('a stale human flip uses live failed proof instead of its ready payload', async () => {
  const github = fakeGithub();
  github.state.checks[0].conclusion = 'failure';
  const board = fakeBoard({ current: 'In review' });
  await handleEvent({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'ready_for_review', pull_request: pullFixture() } });
  assert.deepEqual(board.moves.map(move => move.optionId), ['opt-progress', 'opt-progress']);
});

// bound: B's board move is the signal that independent PR work progressed while A
// was held; the timeout detects accidental repository-wide serialization.
test('independent automatic A and B events keep separate discovery and production PR queues', { timeout: 10000 }, async () => {
  const a = fakeGithub(), b = fakeGithub({ pulls: [pullFixture({ number: 8, node_id: 'PR_8' })] });
  a.state.checks[0].pull_requests = structuredClone(a.state.run.pull_requests);
  b.state.checks[0].pull_requests = structuredClone(b.state.run.pull_requests);
  const boardA = fakeBoard({ current: 'In progress' }), boardB = fakeBoard({ current: 'In progress' });
  const held = barrier(), release = barrier(), bMoved = barrier();
  const graphqlA = boardA.graphql, graphql = boardB.graphql;
  boardA.graphql = async (query, vars) => { held.resolve(); await release.promise; return graphqlA(query, vars); };
  boardB.graphql = async (query, vars) => {
    const result = await graphql(query, vars);
    if (query.includes('updateProjectV2ItemFieldValue')) bMoved.resolve();
    return result;
  };
  const enqueue = await workflowQueue();
  const first = enqueue({ github: a, projectGithub: boardA, eventName: 'check_run', payload: {} });
  await held.promise;
  const second = enqueue({ github: b, projectGithub: boardB, eventName: 'check_run', payload: {} });
  await bMoved.promise;
  assert.deepEqual(boardB.numbers, [8]);
  assert.deepEqual(boardA.moves, []);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(cards(boardA), IN_REVIEW);
  assert.deepEqual(cards(boardB), IN_REVIEW);
});

// bound: explicit read/queue barriers control replacement, not elapsed time.
test('a human wake replacing a pending revoker still revokes failed admission', { timeout: 10000 }, async () => {
  const github = fakeGithub(), board = fakeBoard({ current: 'In progress' });
  const hold = holdBoard(board), pending = barrier(), replacement = barrier();
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
    action: 'ready_for_review', pull_request: pullFixture() } });
  await replacement.promise;
  hold.release();
  await Promise.all([older, revoker, human]);
  assert.deepEqual(cards(board), IN_PROGRESS);
});

test('a human ready request with failed admission keeps the PR ready and its cards In progress', async () => {
  const github = fakeGithub();
  github.state.checks[0].conclusion = 'failure';
  const board = fakeBoard({ current: 'In review' });
  const enqueue = await workflowQueue();
  await enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'ready_for_review', pull_request: pullFixture() } });
  assert.equal(github.state.pulls[0].draft, false);
  assert.deepEqual(cards(board), IN_PROGRESS);
});


test('a head change after proof is read refuses a stale board move', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  let providerReads = 0;
  const request = github.request;
  github.request = async (route, args) => {
    const result = await request(route, args);
    if (providerRead(route, args) && ++providerReads === 2) {
      github.state.pulls[0].head.sha = 'd'.repeat(40);
    }
    return result;
  };
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(board.numbers, []);
});

test('readiness accepts the official no-permission signal association instead of its merge SHA', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  github.state.signal = { id: 40, name: 'CodeRabbit review signal', run_attempt: 1, workflow_id: 4,
    path: '.github/workflows/coderabbit-review-signal.yml', event: 'pull_request_review_comment',
    head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'failure', repository: { id: 1, full_name: 'o/r' },
    head_repository: { full_name: 'o/r' }, pull_requests: [{ number: 7, head: { sha, repo: { id: 1 } },
      base: { ref: 'main', repo: { id: 1 } } }] };
  const payload = { action: 'completed', workflow_run: structuredClone(github.state.signal) };
  await handleEvent({ github, projectGithub: board, eventName: 'workflow_run', payload });
  assert.deepEqual(cards(board), IN_REVIEW);
  github.state.signal.workflow_id = 9;
  assert.deepEqual(await discover(eventArgs({ github, eventName: 'workflow_run', payload })), { numbers: [] });
});


// bound: hold the exact old failed decision while two pending jobs coalesce.
test('a human wake replacing pending promotion still promotes current admitted proof', { timeout: 10000 }, async () => {
  // The old native gate failed with the provider, so the old job decides
  // In progress without a rerun; a new CI attempt then passes both.
  const github = fakeGithub({ checkRuns: [checkRun(1, VERIFY, 'success'), checkRun(2, REVIEW_CHECK, 'failure')] });
  github.state.checks[0].conclusion = 'failure';
  github.state.jobs[0].conclusion = 'failure';
  const board = fakeBoard({ current: 'In review' });
  const hold = holdBoard(board), pending = barrier(), replacement = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => {
    if (++count === 2) pending.resolve();
    if (count === 3) replacement.resolve();
  });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await hold.held;
  github.state.checks[0].conclusion = 'success';
  github.state.jobs[0].conclusion = 'success';
  github.state.checkRuns[1].conclusion = 'success';
  const promotion = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun() });
  await pending.promise;
  const human = enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'converted_to_draft', pull_request: pullFixture({ draft: true }) } });
  await replacement.promise;
  hold.release();
  await Promise.all([older, promotion, human]);
  assert.deepEqual(cards(board), IN_REVIEW, 'fresh admitted proof must survive replacement of pending promotion');
});

for (const event of ['CI', 'provider']) test(`readiness ${event} discovery bounds proof work with 63 unrelated PRs`, async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  github.state.pulls.push(...Array.from({ length: 63 }, (_, i) => pullFixture({ number: i + 100, node_id: `PR_${i + 100}`,
    head: { sha: 'b'.repeat(40), ref: 'other', repo: { full_name: 'o/r' } } })));
  github.state.checks[0].pull_requests = structuredClone(github.state.run.pull_requests);
  const input = eventArgs({ github, projectGithub: board, eventName: event === 'CI' ? 'workflow_run' : 'check_run', payload: event === 'CI' ? workflowRun() : {} });
  const result = await discover(input);
  assert.deepEqual(result, { numbers: [7] });
  assert.equal(github.calls.some(([, route]) => route === 'GET /repos/{owner}/{repo}/pulls'), false);
  await Promise.all(result.numbers.map(pullNumber => reconcile({ ...input, pullNumber })));
  assert.deepEqual(board.numbers, [7]);
  assert.deepEqual(cards(board), IN_REVIEW);
});

test('trusted no-files decision moves a verified head to In review and unresolved threads move it back', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  Object.assign(github.state.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(cards(board), IN_REVIEW);
  github.state.threads = [{ id: 'open', isResolved: false, isOutdated: true }];
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(cards(board), IN_PROGRESS);
  assert.equal(github.state.pulls[0].draft, false);
});

for (const condition of ['failed native aggregate', 'skipped native review', 'missing required check']) test(`trusted no-files cannot reach In review with ${condition}`, async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  Object.assign(github.state.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  if (condition === 'failed native aggregate') github.state.jobs[2].conclusion = 'failure';
  if (condition === 'skipped native review') github.state.jobs[0].conclusion = 'skipped';
  if (condition === 'missing required check') github.state.checkRuns = [];
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(board.moves, []);
});

// Per-PR reads with a board token: 4 head reads, then native proof (6) and
// admission (5) only when they can change the decision, then one final PR read.
for (const [label, checkRuns, reads, cardState] of [
  ['a running native review', [checkRun(1, VERIFY, null, 'in_progress'), checkRun(2, REVIEW_CHECK, null, 'in_progress')], 5, IN_PROGRESS],
  ['a green head', undefined, 16, IN_REVIEW],
]) test(`board sync for ${label} costs ${reads} reads`, async () => {
  const github = fakeGithub(checkRuns ? { checkRuns } : {});
  const board = fakeBoard({ current: 'Todo' });
  await reconcile({ ...eventArgs({ github, projectGithub: board }), pullNumber: 7 });
  assert.equal(github.calls.length, reads);
  assert.deepEqual(cards(board), cardState);
});

// The board follows before the rerun attempt: a POST that fails or stays
// ambiguous cannot leave a card In review once admission is lost.
for (const [label, accepted] of [['a rejected', false], ['an ambiguous but accepted', true]]) {
  test(`${label} rerun POST still moves the cards to In progress`, async () => {
    const github = fakeGithub();
    github.state.checks[0].conclusion = 'failure';
    github.state.writeError = true;
    const request = github.request;
    github.request = async (route, params) => {
      if (accepted && github.state.writes.length && route.endsWith('/runs/{run_id}')) github.state.run.run_attempt = 2;
      return request(route, params);
    };
    const board = fakeBoard({ current: 'In review' });
    const result = reconcile({ ...eventArgs({ github, projectGithub: board }), pullNumber: 7 });
    if (accepted) assert.equal(await result, 'rerun-requested');
    else await assert.rejects(result, /acceptance not yet visible/);
    assert.deepEqual(github.state.writes, [30], 'one POST, never retried');
    assert.deepEqual(cards(board), IN_PROGRESS);
  });
}
