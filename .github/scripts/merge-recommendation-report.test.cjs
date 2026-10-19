const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshot, assessment } = require('./fixtures/merge-recommendation.cjs');
const { publishBatch, renderComment, readComment, renderSummary, parseSummary, withLock } = require('./merge-recommendation-report.cjs');

function fixture() {
  const s = snapshot(), writes = [], actor = { id: 42, login: 'writer' };
  const issue = { number: 9, body: renderSummary({ records: [], coverage: 'Not started.' }), user: actor, state: 'open' };
  const comments = [];
  return { s, writes, comments, issue, actor, gh: {
    api: async (method, route, data) => {
      if (method === 'GET' && route.endsWith('/issues/9')) return issue;
      writes.push({ method, route, data });
      if (method === 'POST') { const c = { id: 11, body: data.body, user: actor }; comments.push(c); return c; }
      if (route.endsWith('/issues/9')) { issue.body = data.body; return issue; }
      comments[0].body = data.body; return comments[0];
    },
    pages: async () => comments,
  } };
}

test('publishes one maintained recommendation with exact SHAs and idempotent retained-cohort counts', async () => {
  const f = fixture(), s = f.s;
  const args = { ...f, repository: s.repository, summaryNumber: 9, snapshots: [s], primary: [assessment(s)], challenge: [assessment(s)], refresh: async () => s };
  await publishBatch(args);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Recommend/); assert.match(f.comments[0].body, new RegExp(s.headSha));
  assert.match(f.comments[0].body, /issues\/9/);
  assert.equal(parseSummary(f.issue.body).records.length, 1);
  await publishBatch(args);
  assert.equal(f.comments.length, 1);
  assert.equal(parseSummary(f.issue.body).records.length, 1);
  assert.equal(f.writes.filter(w => w.method === 'POST').length, 1);
});

test('rechecks head and base immediately before publication and cannot reuse stale recommendations', async () => {
  for (const field of ['headSha', 'baseSha']) {
    const f = fixture(), s = f.s;
    const fresh = { ...s, [field]: 'd'.repeat(40) };
    await publishBatch({ ...f, repository: s.repository, summaryNumber: 9, snapshots: [s], primary: [assessment(s)], challenge: [assessment(s)], refresh: async () => fresh });
    assert.equal(readComment(f.comments[0].body).decision, 'pending');
    assert.match(f.comments[0].body, /revision changed/i);
  }
});

test('reads comment history before the final freshness check so a push during pagination revokes the verdict', async () => {
  const f = fixture(), s = f.s; let current = s;
  f.gh.pages = async () => { current = { ...s, headSha: 'd'.repeat(40) }; return f.comments; };
  await publishBatch({ ...f, repository: s.repository, summaryNumber: 9, snapshots: [s], primary: [assessment(s)], challenge: [assessment(s)], refresh: async () => current });
  assert.equal(readComment(f.comments[0].body).decision, 'pending');
  assert.match(f.comments[0].body, /revision changed/i);
});

test('ignores forged PR markers and refuses a summary owned by a different writer', async () => {
  const f = fixture();
  f.comments.push({ id: 99, user: { id: 666 }, body: renderComment(f.s, { decision: 'recommend', rules: [] }, 9) });
  await publishBatch({ ...f, repository: f.s.repository, summaryNumber: 9, snapshots: [f.s], primary: [], challenge: [], refresh: async () => f.s });
  assert.equal(f.writes.find(w => w.route.endsWith('/comments')).method, 'POST');
  const g = fixture(); g.issue.user = { id: 666 };
  await assert.rejects(publishBatch({ ...g, repository: g.s.repository, summaryNumber: 9, snapshots: [g.s], primary: [], challenge: [], refresh: async () => g.s }), /summary/i);
  assert.equal(g.writes.length, 0);
});

test('invalidates a prior recommendation when checks regress or a ready PR becomes draft', async () => {
  const f = fixture(), s = f.s;
  const args = { ...f, repository: s.repository, summaryNumber: 9, snapshots: [s], primary: [assessment(s)], challenge: [assessment(s)], refresh: async () => s };
  await publishBatch(args);
  s.draft = true;
  await publishBatch(args);
  assert.equal(readComment(f.comments[0].body).decision, 'pending');
  assert.equal(parseSummary(f.issue.body).records[0].decision, 'pending');
});

test('keeps comment publication durable after a summary failure so the next scan reconciles', async () => {
  const f = fixture(), api = f.gh.api;
  let fail = true;
  f.gh.api = async (method, route, data) => {
    if (fail && f.comments.length && method === 'PATCH' && route.endsWith('/issues/9')) throw new Error('write failed');
    return api(method, route, data);
  };
  const args = { ...f, repository: f.s.repository, summaryNumber: 9, snapshots: [f.s], primary: [assessment(f.s)], challenge: [assessment(f.s)], refresh: async () => f.s };
  await assert.rejects(publishBatch(args), /write failed/);
  assert.equal(f.comments.length, 1);
  fail = false; await publishBatch(args);
  assert.equal(f.comments.length, 1);
  assert.equal(parseSummary(f.issue.body).records.length, 1);
});

test('serializes publishers and releases the local lock even when publication throws', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-merge-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await withLock(dir, async () => {
    await assert.rejects(withLock(dir, async () => assert.fail('second publisher entered')), /publisher/i);
  });
  await assert.rejects(withLock(dir, async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await withLock(dir, async () => 'released'), 'released');
});

test('bounds the digest and reports a retained cohort without claiming accuracy or promoting to merge', () => {
  const records = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, head: 'a'.repeat(40), base: 'b'.repeat(40), decision: i % 2 ? 'recommend' : 'human-review', reason: 'x'.repeat(160), state: 'merged', warnings: [] }));
  const body = renderSummary({ records, coverage: '25 open PRs; more may exist.' });
  const result = parseSummary(body);
  assert.ok(result.records.length <= 100); assert.ok(Buffer.byteLength(body) < 60000);
  assert.match(body, /retained/i); assert.match(body, /not.*accuracy/i); assert.match(body, /more may exist/);
});

test('reserves new cohort identities before any PR comment so a close after partial publication is recoverable', async () => {
  const f = fixture(), api = f.gh.api;
  f.gh.api = async (method, route, data) => {
    if (method === 'POST') assert.ok(parseSummary(f.issue.body).records.some(r => r.number === f.s.number), 'cohort identity must be durable before commenting');
    if (method === 'PATCH' && route.endsWith('/issues/9') && f.comments.length) throw new Error('final summary write failed');
    return api(method, route, data);
  };
  const args = { ...f, repository: f.s.repository, summaryNumber: 9, snapshots: [f.s], primary: [assessment(f.s)], challenge: [assessment(f.s)], refresh: async () => f.s };
  await assert.rejects(publishBatch(args), /final summary write failed/);
  const retained = parseSummary(f.issue.body).records;
  assert.deepEqual(retained.map(r => r.number), [f.s.number]);
  f.gh.api = api;
  const closed = { ...f.s, state: 'merged' };
  await publishBatch({ ...args, snapshots: retained.map(() => closed), primary: [], challenge: [], refresh: async () => closed });
  assert.equal(parseSummary(f.issue.body).records[0].decision, 'recommend');
  assert.equal(parseSummary(f.issue.body).records[0].state, 'merged');
  assert.equal(f.comments.length, 1);
});
