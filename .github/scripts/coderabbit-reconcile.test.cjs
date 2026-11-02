'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile, eventTarget } = require('./coderabbit-reconcile.cjs');
const { readNativeReview } = require('./native-review-proof.cjs');
const { fixture, HEAD, BASE } = require('./coderabbit.testkit.cjs');
function run(h, eventName = 'workflow_dispatch', extra = {}) {
  return reconcile({ ...h, owner: 'o', repo: 'r', eventName, payload: { repository: { full_name: 'o/r' }, inputs: { pr_number: '7' }, ...extra } });
}
const checkEvent = h => ({ action: 'completed', check_run: structuredClone(h.s.checks[0]) });
const ciEvent = h => ({ action: 'completed', workflow_run: structuredClone(h.s.run) });
test('provider completes first: CI completion refreshes only the failed native review job', async () => {
  const h = fixture();
  assert.deepEqual(await run(h, 'workflow_run', ciEvent(h)), ['rerun-requested']);
  assert.deepEqual(h.s.writes, [30]);
  assert.ok(h.s.calls.filter(([r]) => r.startsWith('POST')).every(([r]) => r === 'POST /graphql' || r.endsWith('/actions/jobs/{job_id}/rerun')));
});
test('CI completes first: provider completion finds an open main PR by exact head despite empty provider PR array', async () => {
  const h = fixture(); h.s.checks[0].status = 'in_progress'; h.s.checks[0].conclusion = null;
  assert.deepEqual(await run(h, 'workflow_run', ciEvent(h)), ['unchanged']);
  h.s.checks[0].status = 'completed'; h.s.checks[0].conclusion = 'success';
  assert.deepEqual(await run(h, 'check_run', checkEvent(h)), ['rerun-requested']);
});
test('same-head pending provider revokes a successful native review; repeated events are no-op', async () => {
  const h = fixture(); h.s.jobs[0].conclusion = 'success'; h.s.run.conclusion = 'success';
  h.s.checks[0].status = 'queued'; h.s.checks[0].conclusion = null;
  assert.deepEqual(await run(h, 'check_run', { ...checkEvent(h), action: 'created' }), ['rerun-requested']);
  h.s.run.status = 'completed'; h.s.jobs[0].conclusion = 'failure';
  assert.deepEqual(await run(h), ['unchanged']); assert.deepEqual(h.s.writes, [30]);
});
test('manual eventless resolution refreshes failed admission, reopened outdated threads revoke green', async () => {
  const h = fixture(); h.s.threads = [{ id: 'human', isResolved: false, isOutdated: true }];
  assert.deepEqual(await run(h), ['unchanged']);
  h.s.threads[0].isResolved = true; assert.deepEqual(await run(h), ['rerun-requested']);
  h.s.run.status = 'completed'; h.s.jobs[0].conclusion = 'success'; h.s.threads[0].isResolved = false;
  assert.deepEqual(await run(h), ['rerun-requested']);
});
for (const [name, mutate] of Object.entries({
  'already green': s => { s.jobs[0].conclusion = 'success'; },
  'preflight failed': s => { s.jobs[1].conclusion = 'failure'; },
  'review running': s => { s.jobs[0].status = 'in_progress'; },
  'review skipped': s => { s.jobs[0].conclusion = 'skipped'; },
  'duplicate job': s => { s.jobs.push(s.jobs[0]); },
  'fork head': s => { s.pr.head.repo.full_name = 'fork/r'; },
  'moved target': s => { s.pr.base.ref = 'develop'; },
  'closed': s => { s.pr.state = 'closed'; },
  'legacy gate': s => { s.jobs[0].steps = []; },
  'legacy reusable workflow': s => { s.run.referenced_workflows = [{ path: 'o/r/.github/workflows/automated-code-review.yml@refs/heads/main' }]; },
  'attempt cap': s => { s.run.run_attempt = 50; },
  'old run': s => { s.run.created_at = '2026-09-01T00:00:00Z'; },
  'active run': s => { s.run.status = 'in_progress'; },
})) test(`no mutation for ${name}`, async () => {
  const h = fixture(); mutate(h.s); await run(h); assert.deepEqual(h.s.writes, []);
});
for (const [name, mutate] of Object.entries({
  'wrong app': p => { p.check_run.app.id = 1; },
  'wrong slug': p => { p.check_run.app.slug = 'fake'; },
  'unhandled action': p => { p.action = 'rerequested'; },
  'wrong head': p => { p.check_run.head_sha = BASE; },
})) test(`provider event cannot spoof ${name}`, async () => {
  const h = fixture(), payload = checkEvent(h); mutate(payload);
  assert.deepEqual(await run(h, 'check_run', payload), []); assert.deepEqual(h.s.writes, []);
});
for (const [name, mutate] of Object.entries({
  'dispatch': p => { p.workflow_run.event = 'workflow_dispatch'; },
  'foreign name': p => { p.workflow_run.name = 'Fake'; },
  'stale attempt': p => { p.workflow_run.run_attempt = 2; },
})) test(`CI event rejects ${name}`, async () => {
  const h = fixture(), payload = ciEvent(h); mutate(payload);
  assert.deepEqual(await run(h, 'workflow_run', payload), []); assert.deepEqual(h.s.writes, []);
});
for (const [name, mutate] of Object.entries({
  'foreign workflow': s => { s.run.workflow_id = 4; },
  'missing association': s => { s.run.pull_requests = []; },
  'wrong association': s => { s.run.pull_requests = [{ number: 8, head: { sha: HEAD }, base: { ref: 'main' } }]; },
  'newer failing run': s => { s.runs = [s.run, { ...s.run, id: 21, event: 'workflow_dispatch' }]; },
  'disabled workflow': s => { s.fail = true; },
})) test(`native proof rejects ${name}`, async () => {
  const h = fixture(); mutate(h.s);
  await assert.rejects(() => readNativeReview({ ...h, owner: 'o', repo: 'r', pr: h.s.pr }));
  assert.deepEqual(h.s.writes, []);
});
test('final native run revalidation prevents rerun when CI changes during admission read', async () => {
  const h = fixture(); let checks = 0;
  h.s.onRead = route => {
    if (route.endsWith('/commits/{ref}/check-runs') && ++checks === 4) h.s.run.id = 21;
  };
  assert.deepEqual(await run(h), ['changed']); assert.deepEqual(h.s.writes, []);
});
test('ambiguous POST is never retried', async () => {
  const h = fixture(); h.s.writeError = true;
  await assert.rejects(() => run(h), /acceptance not yet visible/); assert.deepEqual(h.s.writes, [30]);
});
test('read-after-write waits under serialization until the rerun is visible', async () => {
  const h = fixture(); h.s.delayAttempt = true; let polls = 0;
  h.s.onRead = route => { if (h.s.writes.length && route.endsWith('/runs/{run_id}') && ++polls === 3) h.s.run.run_attempt++; };
  assert.deepEqual(await run(h), ['rerun-requested']); assert.equal(polls, 3); assert.deepEqual(h.s.writes, [30]);
});
test('invisible rerun has a bounded observation window and no blind retry', async () => {
  const h = fixture(); h.s.delayAttempt = true;
  await assert.rejects(() => run(h), /acceptance not yet visible/); assert.deepEqual(h.s.writes, [30]);
  assert.equal(h.s.clock - Date.parse('2026-11-02T12:00:00Z'), 30000);
});
function signal(h) {
  h.s.signal = { id: 40, name: 'CodeRabbit review signal', run_attempt: 1, workflow_id: 4,
    path: '.github/workflows/coderabbit-review-signal.yml', event: 'pull_request_review_comment',
    head_sha: BASE, status: 'completed', conclusion: 'failure', repository: { id: 1, full_name: 'o/r' },
    head_repository: { full_name: 'o/r' }, pull_requests: [{ number: 7, head: { sha: HEAD, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } } }] };
  return { action: 'completed', workflow_run: structuredClone(h.s.signal) };
}
test('trusted signal completion locates PR from official association, never merge SHA or signal success', async () => {
  const h = fixture(); assert.deepEqual(await run(h, 'workflow_run', signal(h)), ['rerun-requested']);
});
for (const [name, mutate] of Object.entries({
  'empty association': s => { s.signal.pull_requests = []; },
  'foreign source': s => { s.signal.head_repository.full_name = 'fork/r'; },
  'wrong workflow': s => { s.signal.workflow_id = 9; },
  'wrong event': s => { s.signal.event = 'push'; },
  'stale PR head': s => { s.signal.pull_requests[0].head.sha = BASE; },
})) test(`signal rejects ${name}`, async () => {
  const h = fixture(), payload = signal(h); mutate(h.s);
  await run(h, 'workflow_run', payload); assert.deepEqual(h.s.writes, []);
});
test('foreign events and invalid manual input cannot write', async () => {
  const h = fixture();
  await assert.rejects(() => run(h, 'workflow_dispatch', { repository: { full_name: 'evil/r' } }), /Foreign/);
  await assert.rejects(() => run(h, 'workflow_dispatch', { inputs: { pr_number: 0 } }), /positive/);
  assert.equal(await eventTarget(async () => {}, 'pull_request_review_comment', { repository: { full_name: 'o/r' } }, 'o/r'), null);
});

test('an ambiguous response that accepted the rerun is observed without another POST', async () => {
  const h = fixture(); h.s.writeError = true;
  h.s.onRead = route => { if (h.s.writes.length && route.endsWith('/runs/{run_id}')) h.s.run.run_attempt++; };
  assert.deepEqual(await run(h), ['rerun-requested']); assert.deepEqual(h.s.writes, [30]);
});
