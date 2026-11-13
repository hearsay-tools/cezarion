'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, secondEntry, SHA, BASE, HEAD, MAIN } = require('./merge-queue.testkit.cjs');
const { admissionFailure } = require('./merge-queue-admission.cjs');
test('request failures name the API route, error and HTTP status without credentials', async () => {
  const h = fixture();
  const diagnostics = {};
  const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
  const github = { request: async () => {
    throw Object.assign(new Error('Resource not accessible by integration\nAuthorization: Bearer private-value'), {
      name: 'HttpError', status: 403, request: { headers: { authorization: 'private-header' } },
    });
  } };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, diagnostics }), error => {
    const diagnostic = admissionFailure(error, diagnostics);
    assert.match(diagnostic, /GET \/repos\/\{owner\}\/\{repo\}\/rules\/branches\/\{branch\}/);
    assert.match(diagnostic, /HttpError/);
    assert.match(diagnostic, /403/);
    assert.match(diagnostic, /Resource not accessible by integration/);
    assert.doesNotMatch(diagnostic, /private-value|private-header/);
    assert.deepEqual(diagnostics.api, { route: 'GET /repos/{owner}/{repo}/rules/branches/{branch}', status: 403 });
    assert.equal(diagnostics.check, 'queue rules');
    return true;
  });
});
test('GraphQL failures report the API error instead of only incomplete evidence', async () => {
  const h = fixture();
  const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
  const github = { request: async (route, args) => route === 'POST /graphql'
    ? { data: { errors: [{ message: 'Resource not accessible by integration' }] } }
    : h.github.request(route, args) };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group }),
    /POST \/graphql.*Resource not accessible by integration/);
});
test('admission diagnostics redact signed URLs and prevent workflow command injection', () => {
  const diagnostic = admissionFailure(new Error('Request failed https://user:private@example.test/path?signature=private\n::error::injected'));
  assert.match(diagnostic, /example.test\/path/);
  assert.doesNotMatch(diagnostic, /private|::error::/);
});
for (const fork of [false, true]) test(`valid reviewed native head admitted (fork=${fork})`, async () => {
  const h = fixture(fork); assert.equal((await h.run()).pullNumber, 7);
});
for (const [label, mutate] of Object.entries({
  'build concurrency 2': s => { s.rules[0].parameters.max_entries_to_build = 2; },
  'entry 1 with an entry behind': s => { s.entries = [s.entry, { ...s.entry, id: 'next', position: 2, headCommit: { oid: MAIN }, baseCommit: { oid: SHA } }]; },
  'entry 2 built on entry 1': secondEntry,
  'entry 2 at build concurrency 2': s => { secondEntry(s); s.rules[0].parameters.max_entries_to_build = 2; },
})) test(`admission accepts: ${label}`, async () => {
  const h = fixture(); mutate(h.s); assert.equal((await h.run()).pullNumber, 7);
});
test('entry 2 that moves to position 1 before the final reread is admitted', async () => {
  const h = fixture(); secondEntry(h.s); let reads = 0;
  h.s.onRead = (route, args) => {
    if (route === 'POST /graphql' && args.query.includes('mergeQueue(') && ++reads === 2) {
      h.s.entries = [h.s.entry]; h.s.entry.position = 1;
    }
  };
  // Entry 1 merged between the reads: entry 2 is now first, and its base is main.
  assert.equal((await h.run()).pullNumber, 7); assert.equal(reads, 2);
});
for (const [label, mutate] of Object.entries({
  'missing entry': s => { s.entries = []; },
  'duplicate entry': s => { s.entries = [s.entry, s.entry]; },
  'wrong combined SHA': s => { s.entry.headCommit.oid = HEAD; },
  'wrong base': s => { s.entry.baseCommit.oid = HEAD; },
  'second entry without a first': s => { s.entry.position = 2; },
  'third position': s => { secondEntry(s); s.entry.position = 3; },
  'second entry not built on the first': s => { secondEntry(s); s.first.headCommit.oid = MAIN; },
  'second entry beside two firsts': s => { secondEntry(s); s.entries = [s.first, { ...s.first, id: 'other' }, s.entry]; },
  'stale group': s => { secondEntry(s); s.entry.headCommit.oid = HEAD; },
  'changed PR head': s => { s.pr.head.sha = SHA; },
  'draft': s => { s.pr.draft = true; },
  'closed': s => { s.pr.state = 'closed'; },
  'wrong target': s => { s.pr.base.ref = 'release'; },
  'build concurrency 3': s => { s.rules[0].parameters.max_entries_to_build = 3; },
  'build concurrency 0': s => { s.rules[0].parameters.max_entries_to_build = 0; },
  'multi merge': s => { s.rules[0].parameters.max_entries_to_merge = 2; },
  'missing rule': s => { s.rules = []; },
  'foreign Actions integration': s => { s.rules[1].parameters.required_status_checks[0].integration_id = 2; },
  'thread protection disabled': s => { s.rules[2].parameters.required_review_thread_resolution = false; },
  'unresolved thread': s => { s.threads = [{ id: 't', isResolved: false }]; },
  'dispatch review': s => { s.run.event = 'workflow_dispatch'; },
  'foreign workflow': s => { s.run.workflow_id = 4; },
  'foreign repository': s => { s.run.repository.full_name = 'evil/r'; },
  'foreign head': s => { s.run.head_repository.full_name = 'evil/r'; },
  'wrong attribution': s => { s.run.pull_requests[0].number = 8; },
  'newer failed run': s => { s.runs = [s.run, { ...s.run, id: 21, conclusion: 'failure' }]; },
  'pending native review': s => { s.run.status = 'in_progress'; },
  'skipped review job': s => { s.jobs[1].conclusion = 'skipped'; },
  'missing review job': s => { s.jobs.pop(); },
  'duplicate review': s => { s.jobs.push({ ...s.jobs[1], id: 3 }); },
  'API failure': s => { s.fail = true; },
})) test(`admission fails closed: ${label}`, async () => {
  const h = fixture(); mutate(h.s); await assert.rejects(h.run);
});
test('a later paginated unresolved thread blocks admission', async () => {
  const h = fixture(); h.s.nextThreads = true;
  h.s.onRead = (route, args) => { if (args.variables?.cursor) h.s.threads = [{ id: 'later', isResolved: false }]; };
  await assert.rejects(h.run, /Unresolved/);
});
for (const target of ['queue', 'head', 'attempt']) test(`final reread rejects moving ${target}`, async () => {
  const h = fixture(); let reads = 0;
  h.s.onRead = route => {
    const match = target === 'queue' ? route === 'POST /graphql' : target === 'head' ? route.endsWith('/pulls/{pull_number}') : route.endsWith('/runs/{run_id}');
    if (match && ++reads === 2) {
      if (target === 'queue') h.s.entry.id = 'new';
      if (target === 'head') h.s.pr.head.sha = SHA;
      if (target === 'attempt') h.s.run.run_attempt++;
    }
  };
  await assert.rejects(h.run);
});

test('final admission keeps rejecting an in-progress workflow even when required gates passed', async () => {
  const h = fixture(); h.s.run.status = 'in_progress'; h.s.run.conclusion = null;
  await assert.rejects(h.run, /has not passed/);
});

for (const kind of ['pending', 'newer failure', 'wrong app', 'skipped', 'missing']) test(`queue ignores historical native green when CodeRabbit is ${kind}`, async () => {
  const h = fixture();
  if (kind === 'pending') h.s.checks[0].status = 'in_progress';
  if (kind === 'newer failure') h.s.checks.push({ ...h.s.checks[0], id: 101, conclusion: 'failure' });
  if (kind === 'wrong app') h.s.checks[0].app.id = 1;
  if (kind === 'skipped') h.s.checks[0].conclusion = 'skipped';
  if (kind === 'missing') h.s.checks = [];
  await assert.rejects(h.run, /CodeRabbit admission/);
});
for (const kind of ['release', 'upstream']) test(`queue preserves fully verified ${kind} exception without provider execution`, async () => {
  const h = fixture(); h.s.checks = []; h.s.pr.changed_files = 1;
  h.s.pr.user = { login: 'release-app[bot]' };
  h.s.pr.head.ref = kind === 'release' ? 'release/v1.2.3' : 'upstream-scan/weekly'; h.s.run.head_branch = h.s.pr.head.ref;
  const github = { request: async (route, args) => {
    if (route.endsWith('/pulls/{pull_number}/files')) return { data: [{ status: 'modified', filename: kind === 'release' ? 'packages/cezar/package.json' : '.ai/upstream/ledger.yaml' }] };
    if (route.endsWith('/contents/{path}')) {
      const text = JSON.stringify({ version: args.ref === BASE ? '1.2.2' : '1.2.3' });
      return { data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length } };
    }
    return h.github.request(route, args);
  } };
  const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
  assert.equal((await mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, releaseAppBotLogin: 'release-app[bot]' })).pullNumber, 7);
});

for (const fork of [false, true]) test(`queue accepts trusted no-files with native green and blocks unresolved threads (fork=${fork})`, async () => {
  const h = fixture(fork); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  assert.equal((await h.run()).pullNumber, 7);
  h.s.threads = [{ id: 'open', isResolved: false, isOutdated: true }];
  await assert.rejects(h.run, /Unresolved/);
});

test('trusted no-files cannot replace a skipped native review job', async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  h.s.jobs[1].conclusion = 'skipped';
  await assert.rejects(h.run, /Native CI\/review gates missing/);
});

// hearsay-tools/cezarion#3050: green first review, then first ready at 22:51:04.
// Before the second execution appeared, historical green could admit the queue.
test('queue refuses the successful review from before first ready (3050)', async () => {
  const h = fixture(); h.s.checks[0].started_at = '2026-11-08T22:34:53Z';
  h.s.now = () => Date.parse('2026-11-08T22:52:07Z');
  await assert.rejects(h.run, /provider re-review settle window open/);
});
test('queue refuses the pending post-first-ready review (3050)', async () => {
  const h = fixture(); h.s.checks[0].status = 'in_progress'; h.s.checks[0].conclusion = null;
  await assert.rejects(h.run, /provider review pending after first ready/);
});
test('queue admits completed post-first-ready review (3050)', async () => {
  const h = fixture(); assert.equal((await h.run()).head, HEAD);
});
test('queue uses first ready across a later ready flip with no new review (3031)', async () => {
  const h = fixture(); h.s.firstReady = '2026-11-08T14:34:34Z';
  h.s.checks[0].started_at = '2026-11-08T14:35:14Z';
  // At the second ready, 14:57:46, this same successful execution is enough.
  assert.equal((await h.run()).head, HEAD);
  assert.equal(h.s.calls.filter(route => route === 'POST /graphql').length, 4);
});
test('queue admits a new head reviewed at push after first ready (3050)', async () => {
  const h = fixture(); h.s.checks[0].started_at = '2026-11-08T23:26:32Z';
  // First ready remains 22:51:04, rather than the second ready at 23:43:51.
  assert.equal((await h.run()).head, HEAD);
});
test('queue refuses a draft never marked ready', async () => {
  const h = fixture(); h.s.firstReady = null; h.s.pr.draft = true;
  await assert.rejects(h.run, /PR head is no longer eligible/);
});
for (const [label, ready, started, reason] of [
  ['bad event timestamp', 'invalid', '2026-11-08T22:51:37Z', /timestamp unavailable/],
  ['missing start', '2026-11-08T22:51:04Z', undefined, /review start unavailable/],
  ['bad start', '2026-11-08T22:51:04Z', 'invalid', /review start unavailable/],
  ['equal start', '2026-11-08T22:51:04Z', '2026-11-08T22:51:04Z', /settle window open/],
]) test(`queue first-ready evidence fails closed: ${label}`, async () => {
  const h = fixture(); h.s.firstReady = ready; h.s.checks[0].started_at = started;
  h.s.now = () => Date.parse('2026-11-08T22:52:07Z');
  await assert.rejects(h.run, reason);
});
test('queue preserves trusted no-files skip without post-ready execution', async () => {
  const h = fixture(); h.s.checks[0].conclusion = 'skipped';
  h.s.checks[0].output = { title: 'No files to review' };
  h.s.checks[0].started_at = '2026-11-08T22:34:53Z';
  assert.equal((await h.run()).head, HEAD);
});

for (const fork of [false, true]) test(`queue admits opened-ready PR without a ready event (fork=${fork})`, async () => {
  const h = fixture(fork); h.s.firstReady = null;
  assert.equal((await h.run()).head, HEAD);
});

// hearsay-tools/squawk#3359: one transient GitHub answer dropped a green PR from the queue.
const httpError = (status, message, headers = {}) => Object.assign(new Error(message), { name: 'HttpError', status, response: { headers } });
function failFirst(h, matches, error) {
  const original = h.github.request; let failed = 0;
  const github = { request: async (route, args) => {
    if (matches(route, args) && failed++ === 0) { h.s.calls.push(route); throw error; }
    return original(route, args);
  } };
  const sleeps = [];
  const run = () => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, sleep: async ms => { sleeps.push(ms); } });
  return { run, sleeps };
}
const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
for (const [label, matches] of Object.entries({
  rules: route => route.endsWith('/rules/branches/{branch}'),
  'queue GraphQL': (route, args) => args.query?.includes('mergeQueue('),
  'run jobs': route => route.endsWith('/runs/{run_id}/jobs'),
  'CodeRabbit check runs': route => route.endsWith('/check-runs'),
  'review threads': (route, args) => args.query?.includes('reviewThreads'),
})) test(`one transient 500 on the ${label} read is retried and admits`, async () => {
  const h = fixture();
  const { run, sleeps } = failFirst(h, matches, httpError(500, 'The operation was aborted due to timeout'));
  assert.equal((await run()).pullNumber, 7);
  assert.deepEqual(sleeps, [1000]);
});
test('a secondary rate limit waits for its retry-after, then admits', async () => {
  const h = fixture();
  const { run, sleeps } = failFirst(h, route => route.endsWith('/pulls/{pull_number}'),
    httpError(403, 'You have exceeded a secondary rate limit', { 'retry-after': '2' }));
  assert.equal((await run()).pullNumber, 7);
  assert.deepEqual(sleeps, [2000]);
});
test('a real refusal fails at once, and a lasting 5xx fails after three attempts', async () => {
  for (const [error, attempts] of [[httpError(403, 'Resource not accessible by integration'), 1], [httpError(404, 'Not Found'), 1], [httpError(502, 'Bad Gateway'), 3]]) {
    const calls = []; const sleeps = [];
    const github = { request: async route => { calls.push(route); throw error; } };
    await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: fixture().s.group, sleep: async ms => { sleeps.push(ms); } }),
      new RegExp(error.message));
    assert.equal(calls.length, attempts, error.message);
    assert.deepEqual(sleeps, [1000, 2000].slice(0, attempts - 1));
  }
});
test('a retry wait that would pass the deadline fails instead', async () => {
  const h = fixture(); let clock = 0;
  const github = { request: async () => { clock = 119500; throw httpError(500, 'Server Error'); } };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, now: () => clock,
    sleep: async () => assert.fail('no wait past the deadline') }), /Server Error/);
});
test('a PR turned draft during admission is refused by the final PR read', async () => {
  const h = fixture(); let reads = 0;
  h.s.onRead = route => { if (route.endsWith('/pulls/{pull_number}') && ++reads === 3) h.s.pr.draft = true; };
  await assert.rejects(h.run, /Queue or PR changed/);
});
test('one admission reads each record once, apart from the race re-reads', async () => {
  const h = fixture(); await h.run();
  // rules, queue, PR, workflow, runs, run, jobs; CodeRabbit: PR, checks, threads, checks, PR;
  // first ready; final run, runs, queue, PR.
  assert.equal(h.s.calls.length, 17);
  assert.equal(h.s.calls.filter(route => route.endsWith('/rules/branches/{branch}')).length, 1);
});
