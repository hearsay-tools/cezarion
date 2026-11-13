'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const read = name => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows', name), 'utf8'));
test('native protected review is read-only trusted-base admission after preflight', () => {
  const ci = read('ci.yml'), gate = ci.jobs['review-result'];
  assert.equal(gate.needs, 'preflight');
  assert.deepEqual(gate.permissions, { checks: 'read', contents: 'read', 'pull-requests': 'read' });
  const checkout = gate.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}'); assert.equal(checkout.with['persist-credentials'], false);
  const script = gate.steps.find(s => s.name === 'Require fresh CodeRabbit admission and resolved threads');
  assert.match(script.with.script, /waitForCodeRabbitAdmission/);
  assert.match(script.with.script, /core.notice/); assert.match(script.with.script, /process.exitCode = 1/);
  assert.doesNotMatch(script.with.script, /setFailed|createReview|createWorkflowDispatch/);
  assert.doesNotMatch(JSON.stringify(gate), /secrets\.|OPENAI|ANTHROPIC/);
});
test('reconciler has only trusted default-branch triggers and targeted Actions write', () => {
  const w = read('coderabbit-reconcile.yml'), job = w.jobs.reconcile, discovery = w.jobs.discover;
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.on.check_run.types, ['created', 'completed']);
  assert.deepEqual(w.on.workflow_run, { workflows: ['CI', 'CodeRabbit review signal'], types: ['completed'] });
  // PR Readiness merged here: human draft/ready flips and new heads resync the board.
  assert.deepEqual(w.on.pull_request_target, { types: ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft'],
    branches: ['main'] });
  assert.equal(w.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.equal(w.concurrency, undefined, 'discovery cannot be coalesced across PRs');
  assert.deepEqual(job.concurrency, { group: 'coderabbit-admission-pr-${{ matrix.pr }}', 'cancel-in-progress': false });
  assert.equal(job.needs, 'discover');
  assert.equal(job.if, "needs.discover.outputs.numbers != '[]'");
  assert.deepEqual(job.strategy, { 'fail-fast': false, 'max-parallel': 4,
    matrix: { pr: '${{ fromJSON(needs.discover.outputs.numbers) }}' } });
  assert.equal(discovery.concurrency, undefined, 'each event discovers independently');
  // Another app's check run starts no job; every other event reaches the script.
  assert.match(discovery.if, /^github\.event_name != 'check_run'\s+\|\| \(github\.event\.check_run\.app\.id == 347564 && github\.event\.check_run\.app\.slug == 'coderabbitai'\s+&& github\.event\.check_run\.name == 'CodeRabbit'\)$/);
  assert.deepEqual(discovery.permissions, { contents: 'read', 'pull-requests': 'read', checks: 'read', actions: 'read' });
  assert.deepEqual(discovery.outputs, { numbers: '${{ steps.discover.outputs.numbers }}' });
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read', checks: 'read', statuses: 'read', actions: 'write' });
  const appToken = (step, permissions) => {
    assert.equal(step['continue-on-error'], true, 'a missing App or permission degrades, never fails the job');
    assert.equal(step.if, "vars.RELEASE_APP_CLIENT_ID != ''");
    assert.equal(step.with['client-id'], '${{ vars.RELEASE_APP_CLIENT_ID }}');
    assert.equal(step.with['private-key'], '${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
    assert.deepEqual(Object.keys(step.with).filter(key => key.startsWith('permission-')).map(key => [key, step.with[key]]), permissions);
  };
  const reads = names => names.map(name => [`permission-${name}`, 'read']);
  const [discoverCheckout, discoverToken, discoverScript] = discovery.steps;
  appToken(discoverToken, reads(['actions', 'checks', 'pull-requests']));
  assert.equal(discoverScript.env.READ_TOKEN, '${{ steps.read_app.outputs.token }}');
  assert.match(discoverScript.with.script, /process\.env\.READ_TOKEN \? getOctokit\(process\.env\.READ_TOKEN\) : github/);
  assert.match(discoverScript.with.script, /await discover\(\{ github: reads/);
  assert.match(discoverScript.with.script, /core.setOutput\('numbers'/);
  const [checkout, readToken, boardToken, script] = job.steps;
  appToken(readToken, reads(['actions', 'checks', 'contents', 'pull-requests', 'statuses']));
  appToken(boardToken, [['permission-organization-projects', 'write']]);
  assert.equal(script.env.READ_TOKEN, '${{ steps.read_app.outputs.token }}');
  assert.equal(script.env.BOARD_TOKEN, '${{ steps.board_app.outputs.token }}');
  assert.equal(script.env.RECONCILE_PR, '${{ matrix.pr }}');
  assert.equal(script.env.RECONCILE_TARGET, undefined, 'queue only PR identity');
  assert.match(script.with.script, /const readGithub = process\.env\.READ_TOKEN \? getOctokit\(process\.env\.READ_TOKEN\) : github;/);
  assert.match(script.with.script, /reconcile\(\{ github, readGithub, projectGithub,/, 'the rerun write stays on GITHUB_TOKEN');
  assert.doesNotMatch(script.with.script, /payload:|head_sha|head\.sha/);
  for (const [stepCheckout, steps] of [[discoverCheckout, discovery.steps], [checkout, job.steps]]) {
    assert.equal(stepCheckout.with.ref, '${{ github.event.repository.default_branch }}', 'the script always comes from main');
    assert.equal(stepCheckout.with['persist-credentials'], false);
    assert.equal(steps.filter(step => String(step.uses).startsWith('actions/checkout')).length, 1, 'no PR code is checked out');
    for (const step of steps) assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.name ?? step.id} must be pinned to a commit`);
    assert.equal(steps.at(-1).with.retries, 0);
  }
  assert.doesNotMatch(JSON.stringify(w), /refs\/pull\//);
  assert.deepEqual([...JSON.stringify(w).matchAll(/secrets\.(\w+)/g)].map(m => m[1]), ['RELEASE_APP_PRIVATE_KEY', 'RELEASE_APP_PRIVATE_KEY', 'RELEASE_APP_PRIVATE_KEY']);
});
test('PR-context review signals have no permissions, secrets, checkout or trusted outputs and debounce per PR', () => {
  const w = read('coderabbit-review-signal.yml');
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.jobs.signal.permissions, {});
  assert.deepEqual(w.jobs.signal.steps, [{ run: 'sleep 30' }]);
  assert.ok(w.jobs.signal['timeout-minutes'] >= 1, 'the settle step fits the job timeout');
  assert.deepEqual(w.jobs.signal.concurrency, {
    group: 'coderabbit-review-signal-pr-${{ github.event.pull_request.number }}', 'cancel-in-progress': true });
  assert.equal(w.concurrency, undefined, 'only the per-PR job debounces');
  assert.deepEqual(w.on.pull_request_review.types, ['submitted', 'edited', 'dismissed']);
  assert.deepEqual(w.on.pull_request_review_comment.types, ['created', 'edited', 'deleted']);
  assert.doesNotMatch(JSON.stringify(w), /secrets\.|checkout|outputs/);
});
test('automatic CodeRabbit reviews include drafts, incremental pushes and all labels with no auto-pause', () => {
  const config = yaml.parse(fs.readFileSync(path.join(__dirname, '../../.coderabbit.yaml'), 'utf8'));
  assert.deepEqual(config.reviews.auto_review, { enabled: true, drafts: true, auto_incremental_review: true,
    auto_pause_after_reviewed_commits: 0, labels: [] });
  assert.equal(config.reviews.review_progress, true); assert.equal(config.reviews.fail_commit_status, true);
});

// bound: PR B's completed native rerun is the progress signal while A is held;
// this timeout only detects accidental cross-PR discovery/queue serialization.
test('independent A and B events survive discovery and the production reconciler PR queues', { timeout: 10000 }, async () => {
  const { discover, reconcile } = require('./coderabbit-reconcile.cjs');
  const { fixture } = require('./coderabbit.testkit.cjs');
  const w = read('coderabbit-reconcile.yml');
  assert.equal(w.concurrency, undefined);
  assert.equal(w.jobs.discover.concurrency, undefined);
  const a = fixture(), b = fixture();
  b.s.pr.number = 8; b.s.run.pull_requests[0].number = 8;
  let releaseA, heldA;
  const release = new Promise(resolve => { releaseA = resolve; });
  const held = new Promise(resolve => { heldA = resolve; });
  const request = a.github.request;
  let reads = 0;
  a.github.request = async (route, args) => {
    if (route.endsWith('/pulls/{pull_number}') && ++reads === 2) { heldA(); await release; }
    return request(route, args);
  };
  const queues = new Map();
  async function event(h) {
    const args = { ...h, owner: 'o', repo: 'r' };
    const { numbers } = await discover({ ...args, eventName: 'workflow_run', payload: {
      repository: { full_name: 'o/r' }, action: 'completed', workflow_run: structuredClone(h.s.run) } });
    return Promise.all(numbers.map(pullNumber => {
      const key = w.jobs.reconcile.concurrency.group.replace('${{ matrix.pr }}', String(pullNumber));
      const job = (queues.get(key) ?? Promise.resolve()).then(() => reconcile({ ...args, pullNumber }));
      queues.set(key, job);
      return job;
    }));
  }
  const first = event(a);
  await held;
  assert.deepEqual(await event(b), ['rerun-requested']);
  assert.deepEqual(b.s.writes, [30]);
  assert.deepEqual(a.s.writes, []);
  releaseA();
  assert.deepEqual(await first, ['rerun-requested']);
  assert.deepEqual(a.s.writes, [30]);
});
