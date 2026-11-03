'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const read = name => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows', name), 'utf8'));
test('native protected review is read-only trusted-base admission after preflight', () => {
  const ci = read('ci.yml'), gate = ci.jobs['review-result'];
  assert.equal(ci.jobs.review, undefined);
  assert.equal(fs.existsSync(path.join(__dirname, '../workflows/automated-code-review.yml')), false);
  assert.equal(gate.needs, 'preflight');
  assert.deepEqual(gate.permissions, { checks: 'read', contents: 'read', 'pull-requests': 'read' });
  const checkout = gate.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}'); assert.equal(checkout.with['persist-credentials'], false);
  const script = gate.steps.find(s => s.name === 'Require fresh CodeRabbit execution and resolved threads');
  assert.match(script.with.script, /readCodeRabbitAdmission/);
  assert.match(script.with.script, /core.notice/); assert.match(script.with.script, /process.exitCode = 1/);
  assert.doesNotMatch(script.with.script, /setFailed|createReview|createWorkflowDispatch/);
  assert.doesNotMatch(JSON.stringify(gate), /secrets\.|OPENAI|ANTHROPIC/);
});
test('reconciler has trusted default-branch triggers and narrow claim/rerun permissions', () => {
  const w = read('coderabbit-reconcile.yml'), job = w.jobs.reconcile, discovery = w.jobs.discover;
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.on.check_run.types, ['created', 'completed']);
  assert.deepEqual(w.on.workflow_run, { workflows: ['CI', 'CodeRabbit review signal'], types: ['completed'] });
  assert.equal(w.on.pull_request_review, undefined); assert.equal(w.on.pull_request_review_comment, undefined);
  assert.equal(w.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.equal(w.concurrency, undefined, 'discovery cannot be coalesced across PRs');
  assert.deepEqual(job.concurrency, { group: 'coderabbit-admission-pr-${{ matrix.pr }}', 'cancel-in-progress': false });
  assert.equal(job.needs, 'discover');
  assert.equal(job.if, "needs.discover.outputs.numbers != '[]'");
  assert.deepEqual(job.strategy, { 'fail-fast': false, 'max-parallel': 4,
    matrix: { pr: '${{ fromJSON(needs.discover.outputs.numbers) }}' } });
  assert.equal(discovery.concurrency, undefined, 'each event discovers independently');
  assert.deepEqual(discovery.permissions, { contents: 'read', 'pull-requests': 'read', checks: 'read', actions: 'read' });
  assert.equal(discovery.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(discovery.steps[0].with['persist-credentials'], false);
  assert.equal(discovery.steps[1].with.retries, 0);
  assert.match(discovery.steps[1].with.script, /await discover/);
  assert.match(discovery.steps[1].with.script, /core.setOutput\('numbers'/);
  assert.equal(job.steps[1].env.RECONCILE_TARGET, undefined, 'queue only PR identity');
  assert.deepEqual(discovery.outputs, { numbers: '${{ steps.discover.outputs.numbers }}' });
  assert.equal(job.steps[1].env.RECONCILE_PR, '${{ matrix.pr }}');
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read', checks: 'write', actions: 'write' });
  assert.equal(job.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.equal(job.steps[1].with.retries, 0);
  assert.doesNotMatch(JSON.stringify(w), /refs\/pull\//);
  assert.doesNotMatch(JSON.stringify(discovery), /secrets\.|create-github-app-token/);
});
test('only optional existing release App mints a repository-scoped PR-write sender after trusted preflight', () => {
  const job = read('coderabbit-reconcile.yml').jobs.reconcile;
  const preflight = job.steps.find(s => s.id === 'recovery');
  const mint = job.steps.find(s => s.id === 'recovery_app');
  const execute = job.steps.find(s => s.name === 'Reconcile admission and bounded recovery');
  assert.match(preflight.with.script, /recoveryNeeded/);
  assert.equal(preflight.env.HAS_PRIVATE_KEY, "${{ secrets.RELEASE_APP_PRIVATE_KEY != '' }}");
  assert.equal(mint.if, "steps.recovery.outputs.needed == 'true'");
  assert.equal(mint['continue-on-error'], true, 'mint failure must not skip native revocation');
  assert.deepEqual(mint.with, { 'client-id': '${{ vars.RELEASE_APP_CLIENT_ID }}',
    'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}', repositories: '${{ github.event.repository.name }}',
    'permission-pull-requests': 'write' });
  assert.equal(execute.env.RECOVERY_APP_TOKEN, '${{ steps.recovery_app.outputs.token }}');
  assert.equal(execute.with.retries, 0);
  assert.match(execute.with.script, /getOctokit\(process.env.RECOVERY_APP_TOKEN\)/);
  assert.match(execute.with.script, /runId: Number\(context.runId\)/);
  assert.doesNotMatch(JSON.stringify(job), /permission-contents|npm |pnpm |refs\/pull\//);
});
test('PR-context review signals have no permissions, secrets, checkout or trusted outputs', () => {
  const w = read('coderabbit-review-signal.yml');
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.jobs.signal.permissions, {});
  assert.deepEqual(w.jobs.signal.steps, [{ run: 'true' }]);
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
