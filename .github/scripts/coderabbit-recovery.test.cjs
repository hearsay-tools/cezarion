'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryFixture } = require('./coderabbit-recovery.testkit.cjs');
const { HEAD, BASE } = require('./coderabbit.testkit.cjs');
const { command } = require('./coderabbit-recovery.cjs');
const { recoveryNeeded } = require('./coderabbit-reconcile.cjs');
test('no-files skip reserves one trusted PR/head claim before one App comment; duplicate events never resend', async () => {
  const h = recoveryFixture();
  assert.equal(await h.run(), 'recovery-requested');
  assert.equal(await h.run(), 'recovery-already-claimed');
  assert.equal(h.s.claimPosts.length, 1); assert.equal(h.s.commentPosts.length, 1);
  assert.equal(h.s.claims[0].output.title, 'requested');
  assert.equal(h.s.claims[0].conclusion, 'neutral');
  assert.match(h.s.claimPosts[0].output.summary, /Inspection due: 2026-11-02T12:10:00.000Z/);
  assert.equal(h.s.claimPosts[0].status, 'completed'); assert.equal(h.s.claimPosts[0].conclusion, 'neutral');
  assert.equal(h.s.commentPosts[0].body, command(7, HEAD, 200));
  assert.deepEqual(h.s.writes, [], 'skipped provider never admits or refreshes red to green');
  assert.ok(h.s.logs.some(l => /command comment 300 is visible/.test(l)));
  assert.ok(h.s.commentPosts.every(c => c.request.retries === 0 && c.request.timeout <= 10000));
});
test('historical native green is revoked before any recovery work can exhaust its budget', async () => {
  const h = recoveryFixture(); h.s.jobs[0].conclusion = 'success';
  h.s.recoveryHook = route => { if (route === 'POST /repos/{owner}/{repo}/check-runs') h.s.clock += 120001; };
  assert.equal(await h.run(), 'rerun-requested'); assert.equal(h.s.commentPosts.length, 0);
  assert.equal(h.s.claimPosts.length, 0);
  assert.deepEqual(h.s.writes, [30]);
  h.s.jobs[0].conclusion = 'failure'; h.s.run.status = 'completed'; h.s.recoveryHook = undefined;
  assert.equal(await h.run(), 'recovery-requested'); assert.equal(h.s.commentPosts.length, 1);
});
test('unresolved threads still permit recovery but never admission', async () => {
  const h = recoveryFixture(); h.s.threads = [{ id: 't', isResolved: false }];
  assert.equal(await h.run(), 'recovery-requested'); assert.deepEqual(h.s.writes, []);
});
for (const [name, mutate] of Object.entries({
  pending: h => { h.s.checks[0].status = 'in_progress'; },
  neutral: h => { h.s.checks[0].conclusion = 'neutral'; },
  failed: h => { h.s.checks[0].conclusion = 'failure'; },
  'other skipped title': h => { h.s.checks[0].output.title = 'Review disabled'; },
  spoofed: h => { h.s.checks[0].app.id = 1; },
  stale: h => { h.s.checks[0].head_sha = BASE; },
  fork: h => { h.s.pr.head.repo.full_name = 'fork/r'; },
  closed: h => { h.s.pr.state = 'closed'; },
  'other base': h => { h.s.pr.base.ref = 'develop'; },
  'failed preflight': h => { h.s.jobs[1].conclusion = 'failure'; },
  'legacy gate': h => { h.s.jobs[0].steps = []; },
  'missing sender': h => { h.recoverySender = undefined; },
  'wrong sender': h => { h.recoverySender.slug = 'github-actions'; },
})) test(`no recovery writes for ${name}`, async () => {
  const h = recoveryFixture(); mutate(h); await h.run();
  assert.equal(h.s.claimPosts.length, 0); assert.equal(h.s.commentPosts.length, 0);
});
for (const state of ['claimed', 'requested', 'ambiguous', 'aborted', 'deadline', 'invented']) {
  test(`any prior ${state} claim blocks repeat even behind a later accidental success`, async () => {
    const h = recoveryFixture();
    h.s.claims = [h.claim({ output: { title: state } }), h.claim({ id: 201, conclusion: 'success' })];
    assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.commentPosts.length, 0);
  });
}
for (const [name, mutate] of Object.entries({
  'wrong App': h => { h.s.claims[0].app.id = 12; },
  'wrong slug': h => { h.s.claims[0].app.slug = 'other'; },
  'malformed external ID': h => { h.s.claims[0].external_id = 'unknown'; },
  'wrong head claim': h => { h.s.claims[0].head_sha = BASE; },
  'incomplete inventory': h => { h.s.claimTotal = 101; },
  'duplicate IDs': h => { h.s.claims.push(h.s.claims[0]); },
})) test(`fails closed on ${name} claim evidence`, async () => {
  const h = recoveryFixture(); h.s.claims = [h.claim()]; mutate(h);
  assert.equal(await h.run(), 'recovery-inspection-required'); assert.equal(h.s.commentPosts.length, 0);
  assert.equal(h.s.claimPosts.length, 0);
});
test('caller-controlled origin URL cannot authorize sends; matching claim only suppresses them', async () => {
  const h = recoveryFixture(); h.s.claims = [h.claim({ details_url: 'https://attacker.invalid/forged' })];
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.commentPosts.length, 0);
});
test('complete claim inventory finds an older matching reservation on the second page', async () => {
  const h = recoveryFixture();
  h.s.claimPages = [Array.from({ length: 100 }, (_, i) => h.claim({ id: i + 201,
    external_id: `coderabbit-full-review:v1:${i + 20}:${HEAD}` })), [h.claim()]];
  h.s.claimTotal = 101;
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.claimPosts.length, 0);
  assert.equal(h.s.commentPosts.length, 0);
});
for (const [name, mutate] of Object.entries({
  'foreign workflow': s => { s.origin.path = '.github/workflows/ci.yml'; },
  'PR branch': s => { s.origin.head_branch = 'feature'; },
  'PR event': s => { s.origin.event = 'pull_request_target'; },
  'foreign repo': s => { s.origin.repository.full_name = 'other/r'; },
})) test(`current ${name} run cannot create a reservation`, async () => {
  const h = recoveryFixture(); mutate(h.s);
  assert.equal(await h.run(), 'recovery-inspection-required'); assert.equal(h.s.claimPosts.length, 0);
});
for (const property of ['claimError', 'invalidClaimResponse', 'hideClaims']) test(`${property} cannot authorize a comment and later events inspect the claim`, async () => {
  const h = recoveryFixture(); h.s[property] = true;
  assert.equal(await h.run(), 'recovery-inspection-required'); assert.equal(h.s.commentPosts.length, 0);
  h.s[property] = false;
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.claimPosts.length, 1);
});
test('ambiguous comment acceptance is inspected and recognized without resending', async () => {
  const h = recoveryFixture(); h.s.commentError = true;
  assert.equal(await h.run(), 'recovery-requested'); assert.equal(h.s.commentPosts.length, 1);
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.commentPosts.length, 1);
});
for (const property of ['rejectComment', 'commentReadError']) test(`uncertain ${property} stays reserved through later events`, async () => {
  const h = recoveryFixture(); h.s[property] = true; h.s.commentError = true;
  assert.equal(await h.run(), 'recovery-ambiguous');
  assert.equal(h.s.claims[0].output.title, 'ambiguous');
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.commentPosts.length, 1);
});
test('failed diagnostic update after accepted command cannot authorize a second send', async () => {
  const h = recoveryFixture(); h.s.updateError = true;
  assert.equal(await h.run(), 'recovery-requested'); assert.equal(h.s.claims[0].output.title, 'claimed');
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.commentPosts.length, 1);
});
test('changed provider after reservation aborts without a send and retains reservation', async () => {
  const h = recoveryFixture();
  h.s.recoveryHook = route => {
    if (h.s.claims.length && route.endsWith('/pulls/{pull_number}')) h.s.checks[0].conclusion = 'success';
  };
  await h.run(); assert.equal(h.s.claims[0].output.title, 'aborted'); assert.equal(h.s.commentPosts.length, 0);
});
test('changed live head after reservation aborts without sending on the stale head', async () => {
  const h = recoveryFixture();
  h.s.recoveryHook = route => {
    if (h.s.claims.length && route.endsWith('/pulls/{pull_number}')) h.s.pr.head.sha = BASE;
  };
  await h.run(); assert.equal(h.s.claims[0].output.title, 'aborted'); assert.equal(h.s.commentPosts.length, 0);
});
test('claim on another PR with the same head does not consume this PR recovery', async () => {
  const h = recoveryFixture(); h.s.claims = [h.claim({ external_id: `coderabbit-full-review:v1:8:${HEAD}` })];
  assert.equal(await h.run(), 'recovery-requested'); assert.equal(h.s.commentPosts.length, 1);
});
test('a new live head gets its own recovery key', async () => {
  const h = recoveryFixture(); assert.equal(await h.run(), 'recovery-requested');
  h.s.claims = []; h.s.pr.head.sha = BASE; h.s.checks[0].head_sha = BASE;
  h.s.run.head_sha = BASE; h.s.run.pull_requests[0].head.sha = BASE;
  assert.equal(await h.run(), 'recovery-requested');
  assert.equal(h.s.claimPosts.length, 2); assert.notEqual(h.s.claimPosts[0].external_id, h.s.claimPosts[1].external_id);
});
test('untrusted lookalike comment is not an accepted recovery receipt', async () => {
  const h = recoveryFixture(); h.s.rejectComment = true;
  h.s.comments = [{ id: 999, body: command(7, HEAD, 200), user: { login: 'attacker', type: 'User' } }];
  assert.equal(await h.run(), 'recovery-ambiguous');
});
test('malformed comment response is resolved by exact authenticated receipt inspection', async () => {
  const h = recoveryFixture(); h.s.invalidComment = true;
  assert.equal(await h.run(), 'recovery-requested'); assert.equal(h.s.commentPosts.length, 1);
});
test('truncated comment inspection remains ambiguous and never resends', async () => {
  const h = recoveryFixture(); h.s.rejectComment = true;
  h.s.commentPages = [Array(100).fill({}), Array(100).fill({})];
  assert.equal(await h.run(), 'recovery-ambiguous');
  assert.equal(await h.run(), 'recovery-already-claimed'); assert.equal(h.s.commentPosts.length, 1);
});
test('sender preflight only selects fresh native/preflight-verified no-files skips', async () => {
  const h = recoveryFixture(); assert.equal(await recoveryNeeded(h.args()), true);
  h.s.checks[0].conclusion = 'success'; assert.equal(await recoveryNeeded(h.args()), false);
  h.s.checks[0].conclusion = 'skipped'; h.s.jobs[1].conclusion = 'failure';
  assert.equal(await recoveryNeeded(h.args()), false);
});
