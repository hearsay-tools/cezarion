'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, HEAD } = require('./merge-queue.testkit.cjs');
const { readQueueCodeRabbitAdmission, FIRST_READY_QUERY } = require('./queue-coderabbit-admission.cjs');
function read(h, now = Date.now) {
  return readQueueCodeRabbitAdmission({ github: h.github, owner: 'o', repo: 'r', pullNumber: 7, head: HEAD, now });
}
for (const [label, response] of [
  ['GraphQL errors', { errors: [{ message: 'unavailable' }] }],
  ['missing pull', { data: { repository: { pullRequest: null } } }],
  ['malformed nodes', { data: { repository: { pullRequest: { timelineItems: { nodes: {} } } } } }],
  ['extra nodes', { data: { repository: { pullRequest: { timelineItems: { nodes: [{}, {}] } } } } }],
]) test(`queue reader rejects incomplete first-ready evidence: ${label}`, async () => {
  const h = fixture(); const original = h.github.request;
  h.github.request = (route, args) => args.query === FIRST_READY_QUERY ? { data: response } : original(route, args);
  await assert.rejects(() => read(h), /First ready timeline unavailable/);
});
test('queue reader keeps current-head threads blocking post-first-ready success', async () => {
  const h = fixture(); h.s.threads = [{ id: 'open', isResolved: false }];
  const result = await read(h);
  assert.equal(result.admitted, false); assert.equal(result.reason, 'unresolved-threads');
});
test('queue reader reports pending review after first ready with no native CI dependency', async () => {
  const h = fixture(); h.s.checks[0].status = 'queued'; h.s.checks[0].conclusion = null;
  assert.equal((await read(h)).reason, 'provider review pending after first ready');
});
test('queue reader selects the first ready event instead of waiting for a later flip', async () => {
  const h = fixture(); let query;
  h.s.onRead = (route, args) => { if (args.query?.includes('timelineItems(')) query = args.query; };
  assert.equal((await read(h)).admitted, true);
  assert.match(query, /timelineItems\(first: 1, itemTypes: \[READY_FOR_REVIEW_EVENT\]\)/);
});

test('trusted no-files admission needs no first-ready timeline API', async () => {
  const h = fixture(); h.s.checks[0].conclusion = 'skipped';
  h.s.checks[0].output = { title: 'No files to review' };
  h.s.onRead = (route, args) => { if (args.query === FIRST_READY_QUERY) throw new Error('timeline unavailable'); };
  assert.equal((await read(h)).admitted, true);
});

for (const elapsed of [0, 179999, 180000, 480000]) test(`no post-ready execution at ${elapsed} ms uses the settle window (3066)`, async () => {
  const h = fixture(); h.s.firstReady = '2026-11-09T06:58:07Z';
  h.s.checks[0].started_at = '2026-11-09T06:42:47Z';
  const result = await read(h, () => Date.parse(h.s.firstReady) + elapsed);
  assert.equal(result.admitted, elapsed >= 180000);
  if (elapsed < 180000) assert.equal(result.reason, 'provider re-review settle window open, until 2026-11-09T07:01:07.000Z');
});
test('a PR opened ready has no settle window, even one second after its review', async () => {
  const h = fixture(); h.s.firstReady = null;
  h.s.checks[0].started_at = '2026-11-09T06:42:47Z';
  const result = await read(h, () => Date.parse('2026-11-09T06:42:48Z'));
  assert.equal(result.admitted, true);
});
test('newest failed post-first-ready execution cannot use an older success after settle', async () => {
  const h = fixture(); h.s.checks.push({ ...h.s.checks[0], id: 101, conclusion: 'failure' });
  const result = await read(h);
  assert.equal(result.admitted, false); assert.equal(result.reason, 'provider-failure');
});
