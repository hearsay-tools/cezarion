const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const SHA = 'a'.repeat(40);
const REPO = 'o/n';
const at = minute => `2026-09-09T11:${minute}:00Z`;
const job = (id, name, conclusion, minute = '07') => ({ id, name, status: 'completed', conclusion, started_at: at('04'), completed_at: at(minute) });
function fixture() {
  const ci = { id: 42, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: SHA, head_branch: 'fix/task', head_repository: { full_name: REPO }, status: 'completed', conclusion: 'success', run_attempt: 2, created_at: at('04'), run_started_at: at('10'), actor: { login: 'human' } };
  const review = { ...ci, id: 50, path: '.github/workflows/automated-code-review.yml', event: 'pull_request_target', conclusion: 'failure', run_attempt: 1, run_started_at: at('04'), actor: { login: 'human' }, pull_requests: [{ number: 7 }] };
  return {
    event: { workflow_run: structuredClone(ci) }, ci, review,
    pulls: [{ number: 7, state: 'open', head: { sha: SHA, ref: 'fix/task', repo: { full_name: REPO } }, base: { ref: 'main', repo: { full_name: REPO } } }],
    ciRuns: [ci], reviewRuns: [review], reviews: [],
    ciJobs: [job(101, 'Unit, build, E2E, and package', 'success', '12')],
    reviewJobs: [job(201, 'validate-provider', 'success'), job(202, 'review-round', 'success'), job(203, 'wait-for-ci', 'failure'), job(204, 'claude-review', 'skipped'), job(205, 'codex-review', 'skipped'), job(206, 'post-review', 'skipped'), job(207, 'Automated Code Review', 'failure')],
  };
}

// Only GitHub's HTTP boundary is replaced. Persist the rerun state so a second
// completion event observes what the first request actually scheduled.
function harness(state = fixture(), beforeRead = () => {}) {
  const writes = [], logs = [], calls = [];
  const request = async (route, args) => {
    calls.push([route, args]);
    assert.equal(args.owner, 'o'); assert.equal(args.repo, 'n');
    if (route.startsWith('POST ')) {
      assert.equal(route, 'POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun');
      assert.equal(args.job_id, 203);
      writes.push(args);
      state.review.status = 'queued'; state.review.conclusion = null;
      state.review.run_attempt++;
      return { status: 201 };
    }
    beforeRead(route, args, state);
    let data;
    if (route.endsWith('/pulls')) data = state.pulls;
    else if (route.endsWith('/pulls/{pull_number}')) data = state.pulls.find(p => p.number === args.pull_number);
    else if (route.endsWith('/reviews')) data = state.reviews;
    else if (route.endsWith('/workflows/{workflow_id}/runs')) data = args.workflow_id === 'ci.yml' ? state.ciRuns : state.reviewRuns;
    else if (route.endsWith('/runs/{run_id}')) data = [state.ci, state.review, ...state.ciRuns, ...state.reviewRuns].find(run => run.id === args.run_id);
    else if (route.endsWith('/attempts/{attempt_number}/jobs')) {
      assert.equal(args.attempt_number, args.run_id === 42 ? state.ci.run_attempt : state.review.run_attempt, 'fetch jobs for the exact freshly resolved attempt');
      data = args.run_id === 42 ? state.ciJobs : state.reviewJobs;
    } else throw new Error(`Unexpected route ${route}`);
    return { data: structuredClone(data) };
  };
  return { state, writes, logs, calls, options: { github: { request, paginate: async (route, args) => (await request(route, args)).data }, owner: 'o', repo: 'n', event: state.event, maxRounds: '3', log: text => logs.push(text) } };
}
async function recover(h) {
  const { recoverReview } = require('./recover-review.cjs');
  return recoverReview(h.options);
}

test('failed CI followed by success resumes only the failed review gate and its dependents', async () => {
  const h = harness();
  h.state.ci.run_attempt = 1; h.state.event.workflow_run.run_attempt = 1;
  h.state.ci.conclusion = 'failure';
  h.state.ciJobs[0].conclusion = 'failure';
  await recover(h);
  assert.equal(h.writes.length, 0);
  h.state.ci.run_attempt = 2; h.state.event.workflow_run.run_attempt = 2;
  h.state.ci.conclusion = 'success';
  h.state.ciJobs[0].conclusion = 'success';
  const result = await recover(h);
  assert.equal(result.recovered, true);
  assert.equal(h.writes.length, 1);
  assert.match(h.logs.join('\n'), /CI 42 attempt 2.*review 50 attempt 1.*203/);
});

test('duplicate completion events skip an in-flight and then completed review', async () => {
  const h = harness();
  await recover(h); await recover(h);
  assert.equal(h.writes.length, 1);
  h.state.review.status = 'completed'; h.state.review.conclusion = 'success';
  await recover(h);
  assert.equal(h.writes.length, 1);
});

for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
  test(`active review ${status} is never restarted`, async () => {
    const h = harness(); h.state.review.status = status;
    await recover(h); assert.equal(h.writes.length, 0);
  });
}

for (const mutate of [
  s => { s.pulls[0].head.sha = 'b'.repeat(40); },
  s => { s.pulls[0].state = 'closed'; },
  s => { s.pulls[0].base.ref = 'develop'; },
  s => { s.pulls[0].head.repo.full_name = 'fork/n'; },
  s => { s.ci.head_repository.full_name = 'fork/n'; },
  s => { s.ci.run_attempt = 3; },
  s => { s.ciRuns.unshift({ ...s.ci, id: 60, status: 'in_progress' }); },
  s => { s.ci.event = 'push'; },
  s => { s.ci.path = '.github/workflows/pretend-ci.yml'; },
  s => { s.ci.conclusion = 'cancelled'; },
  s => { s.ciJobs = []; },
  s => { s.ciJobs.push({ ...s.ciJobs[0], id: 102 }); },
  s => { s.review.event = 'workflow_dispatch'; },
  s => { s.review.actor.login = 'dependabot[bot]'; },
  s => { s.review.pull_requests = [{ number: 99 }]; },
  s => { s.reviewJobs.find(j => j.name === 'validate-provider').conclusion = 'failure'; },
  s => { s.reviewJobs.find(j => j.name === 'review-round').conclusion = 'failure'; },
  s => { s.reviewJobs.find(j => j.name === 'wait-for-ci').conclusion = 'success'; },
  s => { s.reviewJobs.find(j => j.name === 'codex-review').conclusion = 'failure'; },
  s => { s.reviewJobs.find(j => j.name === 'post-review').conclusion = 'failure'; },
  s => { s.reviewJobs.find(j => j.name === 'wait-for-ci').started_at = at('13'); },
  s => { s.reviewJobs.find(j => j.name === 'wait-for-ci').completed_at = null; },
]) {
  test(`ineligible history skips: ${mutate.toString()}`, async () => {
    const h = harness(); mutate(h.state);
    const result = await recover(h);
    assert.equal(h.writes.length, 0); assert.equal(result.recovered, false);
    assert.match(h.logs.join('\n'), /skip/i);
  });
}

for (const status of ['queued', 'in_progress', 'completed']) {
  for (const conclusion of [null, 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
    test(`verification ${status}/${conclusion} cannot authorize recovery`, async () => {
      const h = harness(); Object.assign(h.state.ciJobs[0], { status, conclusion });
      await recover(h); assert.equal(h.writes.length, 0);
    });
  }
}

test('published reviews enforce the cap and same-head suppression, pending reviews do not spend rounds', async () => {
  for (const reviews of [
    [1, 2, 3].map(id => ({ id, user: { login: 'github-actions[bot]' }, submitted_at: at('01'), commit_id: 'b'.repeat(40) })),
    [{ user: { login: 'github-actions[bot]' }, submitted_at: at('01'), commit_id: SHA }],
  ]) {
    const h = harness(); h.state.reviews = reviews;
    await recover(h); assert.equal(h.writes.length, 0);
  }
  const h = harness();
  h.state.reviews = [1, 2, 3].map(id => ({ id, user: { login: 'github-actions[bot]' }, submitted_at: null, commit_id: 'b'.repeat(40) }));
  await recover(h); assert.equal(h.writes.length, 1);
});

test('rechecks PR, attempt, review activity and cap immediately before scheduling', async () => {
  for (const mutate of [
    s => { s.pulls[0].head.sha = 'b'.repeat(40); },
    s => { s.ci.run_attempt++; },
    s => { s.review.status = 'in_progress'; },
    s => { s.review.run_attempt++; },
    s => { s.reviews = [1, 2, 3].map(id => ({ id, user: { login: 'github-actions[bot]' }, submitted_at: at('01') })); },
    s => { s.reviews = [{ user: { login: 'github-actions[bot]' }, submitted_at: at('13'), commit_id: SHA }]; },
  ]) {
    let reads = 0;
    const h = harness(fixture(), (route, args, state) => {
      if (route.endsWith('/pulls') && ++reads === 2) mutate(state);
    });
    await recover(h); assert.equal(h.writes.length, 0, mutate.toString());
  }
});

test('review completion closes the race when CI completion observed an active review', async () => {
  const h = harness(); h.state.review.status = 'in_progress';
  await recover(h); assert.equal(h.writes.length, 0);
  h.state.review.status = 'completed';
  h.state.reviewJobs.find(j => j.name === 'wait-for-ci').completed_at = at('13');
  h.options.event = { workflow_run: structuredClone(h.state.review) };
  await recover(h); assert.equal(h.writes.length, 1);
  h.state.review.status = 'completed'; h.state.review.conclusion = 'failure';
  h.state.reviewJobs.find(j => j.name === 'wait-for-ci').started_at = at('13');
  h.options.event = { workflow_run: structuredClone(h.state.review) };
  await recover(h); assert.equal(h.writes.length, 1, 'recovery failure must not cause a rerun loop');
});

test('same-second waiter start and verification completion remain eligible for recovery', async () => {
  const h = harness();
  const gate = h.state.reviewJobs.find(j => j.name === 'wait-for-ci');
  gate.started_at = at('12');
  gate.completed_at = at('13');
  // GitHub REST timestamps discard subsecond ordering: the waiter can start
  // first even though both timestamps are serialized as 11:12:00Z.
  await recover(h);
  assert.equal(h.writes.length, 1);
  await recover(h);
  assert.equal(h.writes.length, 1, 'a repeated event still skips the active recovery');
});

test('publication failure cannot veto successful aggregate verification', async () => {
  const h = harness(); h.state.ci.conclusion = 'failure';
  h.state.ciJobs.push(job(102, 'Publish npm snapshot', 'failure', '13'));
  await recover(h); assert.equal(h.writes.length, 1);
});

test('default and configured round limits apply to recovery; invalid values fail closed', async () => {
  for (const maxRounds of ['', '1', '4']) {
    const h = harness(); h.options.maxRounds = maxRounds;
    h.state.reviews = [{ user: { login: 'github-actions[bot]' }, submitted_at: at('01'), commit_id: 'b'.repeat(40) }];
    await recover(h); assert.equal(h.writes.length, maxRounds === '1' ? 0 : 1);
  }
  for (const maxRounds of ['0', '-1', 'no', '1.5', '03', ' 3 ', '1e2', '9007199254740992']) {
    const h = harness(); h.options.maxRounds = maxRounds;
    await assert.rejects(recover(h), /positive integer/); assert.equal(h.writes.length, 0);
  }
});

test('claude bot remains eligible and PR resolution works without event pull_requests', async () => {
  const h = harness(); h.state.review.actor.login = 'claude[bot]';
  assert.equal(h.state.event.workflow_run.pull_requests, undefined);
  await recover(h); assert.equal(h.writes.length, 1);
});

test('a newer same-head review run prevents recovery of an older failed run', async () => {
  for (const status of ['in_progress', 'completed']) {
    const h = harness(); h.state.reviewRuns.push({ ...h.state.review, id: 60, status, conclusion: status === 'completed' ? 'success' : null });
    await recover(h); assert.equal(h.writes.length, 0);
  }
});

test('a delayed CI event cannot use an earlier attempt after the latest one has succeeded', async () => {
  const h = harness(); h.state.ci.run_attempt = 3;
  await recover(h); assert.equal(h.writes.length, 0);
});

test('unknown API state fails closed', async () => {
  const h = harness(); h.options.github.paginate = async () => { throw new Error('API unavailable'); };
  await assert.rejects(recover(h), /API unavailable/); assert.equal(h.writes.length, 0);
});

test('review-completion skips identify the resolved CI attempt as well as the reason', async () => {
  const h = harness(); h.options.event = { workflow_run: structuredClone(h.state.review) };
  h.state.reviews = [{ user: { login: 'github-actions[bot]' }, submitted_at: at('13'), commit_id: SHA }];
  await recover(h);
  assert.equal(h.writes.length, 0);
  assert.match(h.logs.join('\n'), /CI 42 attempt 2.*already exists/);
});

test('trusted recovery workflow listens to completions and never executes PR code with write credentials', async () => {
  const { parse } = await import('yaml');
  const workflowPath = path.join(__dirname, '../workflows/recover-automated-review.yml');
  assert.ok(fs.existsSync(workflowPath), 'CI completion must have a recovery listener');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['CI', 'Automated Code Review'], types: ['completed'] });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /github.event.workflow_run.head_sha/);
  const recovery = workflow.jobs.recover;
  assert.deepEqual(recovery.permissions, { actions: 'write', contents: 'read', 'pull-requests': 'read' });
  const checkout = recovery.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.length, 1);
  assert.equal(checkout[0].with.ref, '${{ github.sha }}');
  assert.equal(checkout[0].with['persist-credentials'], false);
  assert.equal(recovery.steps.some(step => step.uses?.includes('download-artifact')), false);
  const script = recovery.steps.find(step => step.uses?.startsWith('actions/github-script@'));
  assert.ok(script);
  const h = harness();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('require', 'github', 'context', 'core', 'process', script.with.script)(
    createRequire(path.join(__dirname, '../../package.json')), h.options.github, { repo: { owner: 'o', repo: 'n' }, payload: h.options.event },
    { info: h.options.log, summary: { addRaw() { return this; }, async write() {} } },
    { env: { AUTOMATED_REVIEW_ROUNDS: '3' } },
  );
  assert.equal(h.writes.length, 1, 'the shipped workflow must actually invoke recovery');
});
