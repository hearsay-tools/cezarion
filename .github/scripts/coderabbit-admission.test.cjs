'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCodeRabbitAdmission } = require('./coderabbit-admission.cjs');
const { listReviewThreads } = require('./review-threads.cjs');
const { fixture, HEAD, BASE } = require('./coderabbit.testkit.cjs');
const admission = h => readCodeRabbitAdmission({ github: h.github, owner: 'o', repo: 'r', pullNumber: 7, head: HEAD, now: h.now,
  releaseAppBotLogin: 'release-app[bot]' });
test('authenticated no-files skip admits without prior successful execution', async () => {
  const h = fixture(); h.s.checks[0].conclusion = 'skipped';
  h.s.checks[0].output = { title: 'No files to review' };
  const result = await admission(h);
  assert.equal(result.admitted, true);
  assert.equal(result.reason, 'admitted');
  assert.equal(result.providerState, 'no-files');
  assert.equal(result.action, '');
  assert.equal(h.s.checks.length, 1, 'no earlier successful execution exists');
});
for (const [state, status, conclusion] of [
  ['pending', 'queued', null], ['pending', 'in_progress', null], ['skipped', 'completed', 'skipped'],
  ['neutral', 'completed', 'neutral'], ['failure', 'completed', 'failure'], ['cancelled', 'completed', 'cancelled'],
  ['timed_out', 'completed', 'timed_out'], ['action_required', 'completed', 'action_required'],
  ['stale', 'completed', 'stale'],
  ['unknown', 'completed', null], ['unknown', 'invented', 'success'],
]) test(`classifies provider ${status}/${conclusion} without admission`, async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { status, conclusion });
  const result = await admission(h);
  assert.equal(result.providerState, state); assert.equal(result.admitted, false);
  assert.match(result.action, state === 'pending' ? /Wait for the current CodeRabbit execution/ : /Inspect the trusted CodeRabbit check and App installation/);
  assert.doesNotMatch(result.action, /Resolve every open review thread/);
});
for (const state of ['success', 'pending', 'no-files', 'failure', 'missing']) test(`open threads and ${state} provider give guidance for every blocker`, async () => {
  const h = fixture(); h.s.threads = [{ id: 'open', isResolved: false }];
  if (state === 'pending') h.s.checks[0].status = 'queued';
  if (state === 'no-files') Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  if (state === 'failure') h.s.checks[0].conclusion = 'failure';
  if (state === 'missing') h.s.checks = [];
  const result = await admission(h);
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'unresolved-threads');
  assert.equal(result.providerState, state);
  assert.match(result.action, /^Resolve every open review thread\./);
  if (['success', 'no-files'].includes(state)) assert.equal(result.action, 'Resolve every open review thread.');
  if (state === 'pending') assert.match(result.action, /Wait for the current CodeRabbit execution/);
  if (['failure', 'missing'].includes(state)) assert.match(result.action, /Inspect the trusted CodeRabbit check and App installation/);
});
for (const [name, mutate] of Object.entries({
  'neutral conclusion': c => { c.conclusion = 'neutral'; },
  'pending status': c => { c.status = 'queued'; },
  'wrong title': c => { c.output.title += '!'; },
  'missing title': c => { c.output = {}; },
  'draft skip': c => { c.output.title = 'Review skipped: draft'; },
  'rate limit': c => { c.output.title = 'Rate limit exceeded'; },
  'wrong App': c => { c.app.id = 42; },
  'wrong slug': c => { c.app.slug = 'other'; },
  'wrong name': c => { c.name = 'Other'; },
})) test(`no-files admission refuses ${name}`, async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  mutate(h.s.checks[0]);
  assert.equal((await admission(h)).admitted, false);
});
for (const conclusion of ['failure', 'skipped', null]) test(`newer blocking ${conclusion} supersedes an accepted no-files decision`, async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  h.s.checks.push({ ...h.s.checks[0], id: 101, status: conclusion ? 'completed' : 'queued', conclusion, output: {} });
  assert.equal((await admission(h)).admitted, false);
});
for (const initial of ['No files to review', 'Other skip']) test(`changed title from ${initial} during reread fails closed`, async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: initial } });
  let reads = 0;
  h.s.onRead = route => {
    if (route.endsWith('/commits/{ref}/check-runs') && ++reads === 2) {
      h.s.checks[0].output.title = initial === 'No files to review' ? 'Other skip' : 'No files to review';
    }
  };
  await assert.rejects(() => admission(h), /changed/);
});
test('exact latest App execution and all resolved threads admit without review objects or check PR associations', async () => {
  const h = fixture(); h.s.threads = [{ id: 'outdated-resolved', isResolved: true, isOutdated: true }];
  const result = await admission(h);
  assert.equal(result.admitted, true);
  assert.equal(result.action, '');
  assert.equal(h.s.calls.filter(([route]) => route.endsWith('/commits/{ref}/check-runs')).length, 2);
  assert.ok(h.s.calls.every(([, args]) => args.request.timeout <= 10000 && args.request.retries === 0));
});
for (const [name, mutate] of Object.entries({
  missing: s => { s.checks = []; }, pending: s => { s.checks[0].status = 'in_progress'; s.checks[0].conclusion = null; },
  skipped: s => { s.checks[0].conclusion = 'skipped'; }, neutral: s => { s.checks[0].conclusion = 'neutral'; },
  failure: s => { s.checks[0].conclusion = 'failure'; }, spoofed: s => { s.checks[0].app.id = 42; },
  'wrong slug': s => { s.checks[0].app.slug = 'evil'; }, 'wrong name': s => { s.checks[0].name = 'Other'; },
  'open outdated human thread': s => { s.threads = [{ id: 't', isResolved: false, isOutdated: true }]; },
  'newer failure': s => { s.checks.push({ ...s.checks[0], id: 101, conclusion: 'failure' }); },
  'newer pending': s => { s.checks.push({ ...s.checks[0], id: 101, status: 'queued', conclusion: null }); },
})) test(`blocks ${name}`, async () => { const h = fixture(); mutate(h.s); assert.equal((await admission(h)).admitted, false); });
for (const [name, mutate] of Object.entries({
  'stale provider head': s => { s.checks[0].head_sha = BASE; }, 'changed live head': s => { s.pr.head.sha = BASE; },
  'API error': s => { s.fail = true; }, 'truncated pages': s => { s.checkTotal = 101; },
  'oversized page': s => { s.checks = Array.from({ length: 101 }, (_, i) => ({ ...s.checks[0], id: i + 1 })); },
  'over limit': s => { s.checkTotal = 201; }, 'malformed thread': s => { s.threads = [{ id: 't' }]; },
  'duplicate check id': s => { s.checks.push(s.checks[0]); },
})) test(`fails closed on ${name}`, async () => { const h = fixture(); mutate(h.s); await assert.rejects(() => admission(h)); });
for (const change of ['head', 'provider', 'base']) test(`final reread rejects changing ${change}`, async () => {
  const h = fixture(); let reads = 0;
  h.s.onRead = route => {
    if (route.endsWith('/commits/{ref}/check-runs') && ++reads === 2) {
      if (change === 'head') h.s.pr.head.sha = BASE;
      if (change === 'base') h.s.pr.base.sha = HEAD;
      if (change === 'provider') h.s.checks[0].status = 'in_progress';
    }
  };
  await assert.rejects(() => admission(h), /changed/);
});
test('complete provider pagination selects newest execution across pages', async () => {
  const h = fixture();
  h.s.checkPages = [Array.from({ length: 100 }, (_, i) => ({ ...h.s.checks[0], id: i + 1 })), [{ ...h.s.checks[0], id: 101, conclusion: 'failure' }]];
  h.s.checkTotal = 101;
  assert.equal((await admission(h)).admitted, false);
});
for (const kind of ['missing pageInfo', 'repeated cursor', 'short continuation', 'duplicate thread', 'page cap']) test(`thread reader rejects ${kind}`, async () => {
  let calls = 0;
  const github = { graphql: async () => {
    calls++;
    const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `${kind === 'duplicate thread' ? 0 : calls}-${i}`, isResolved: true }));
    const page = { nodes, pageInfo: { hasNextPage: true, endCursor: kind === 'repeated cursor' ? 'same' : String(calls) } };
    if (kind === 'missing pageInfo') delete page.pageInfo;
    if (kind === 'short continuation') page.nodes = [];
    return { repository: { pullRequest: { reviewThreads: page } } };
  } };
  await assert.rejects(() => listReviewThreads({ github, owner: 'o', repo: 'r', pullNumber: 7 }));
  assert.ok(calls <= 100);
});
test('later unresolved thread is not lost during pagination', async () => {
  let calls = 0;
  const github = { graphql: async () => ({ repository: { pullRequest: { reviewThreads: ++calls === 1
    ? { nodes: Array.from({ length: 100 }, (_, i) => ({ id: String(i), isResolved: true })), pageInfo: { hasNextPage: true, endCursor: 'next' } }
    : { nodes: [{ id: 'later', isResolved: false }], pageInfo: { hasNextPage: false } } } } }) };
  assert.equal((await listReviewThreads({ github, owner: 'o', repo: 'r', pullNumber: 7 })).filter(t => !t.isResolved).length, 1);
});
function exception(h, kind) {
  h.s.checks = []; h.s.pr.head.ref = kind === 'release' ? 'release/v1.2.3' : 'upstream-scan/weekly';
  h.s.pr.user.login = 'release-app[bot]';
  h.s.files = [{ filename: kind === 'release' ? 'packages/cezar/package.json' : '.ai/upstream/ledger.yaml', status: 'modified' }];
  for (const [ref, version] of [[BASE, '1.2.2'], [HEAD, '1.2.3']]) {
    const text = JSON.stringify({ version });
    h.s.contents[`${ref}:packages/cezar/package.json`] = { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) };
  }
}
for (const kind of ['release', 'upstream']) test(`verified ${kind} exception skips provider, but never open threads`, async () => {
  const h = fixture(); exception(h, kind);
  const admitted = await admission(h);
  assert.equal(admitted.admitted, true);
  h.s.threads = [{ id: 't', isResolved: false }];
  const blocked = await admission(h);
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'unresolved-threads');
  assert.equal(blocked.providerState, 'exception');
  assert.equal(blocked.exception, kind === 'release' ? 'release-stamps' : 'upstream-ledger');
  assert.equal(blocked.action, 'Resolve every open review thread.');
  assert.equal(admitted.action, '');
  assert.ok(h.s.calls.every(([route]) => !route.endsWith('/commits/{ref}/check-runs')));
});
for (const [name, mutate] of Object.entries({
  'code file': h => { h.s.files[0].filename = 'src/evil.ts'; },
  'truncated files': h => { h.s.pr.changed_files = 2; },
  'rename hides source': h => { h.s.files[0].status = 'renamed'; },
  'script mutation': h => { const text = JSON.stringify({ version: '1.2.3', scripts: { postinstall: 'evil' } }); h.s.contents[`${HEAD}:packages/cezar/package.json`] = { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length }; },
  'truncated contents': h => { h.s.contents[`${HEAD}:packages/cezar/package.json`].size++; },
  'spoofed bot': h => { h.s.pr.user.login = 'other[bot]'; },
})) test(`release exception refuses ${name}`, async () => {
  const h = fixture(); exception(h, 'release'); mutate(h);
  try { assert.equal((await admission(h)).admitted, false); } catch (error) { assert.match(error.message, /Incomplete|Truncated/); }
});

test('unrelated CI attempts do not exhaust the provider pagination budget', async () => {
  const h = fixture(), request = h.github.request;
  h.github.request = async (route, args) => {
    if (route.endsWith('/commits/{ref}/check-runs')) {
      assert.equal(args.filter, 'all', 'retain every provider attempt');
      if (args.check_name !== 'CodeRabbit' || args.app_id !== 347564) {
        return { data: { total_count: 301, check_runs: [] } };
      }
    }
    return request(route, args);
  };
  assert.equal((await admission(h)).admitted, true);
  const listings = h.s.calls.filter(([route]) => route.endsWith('/commits/{ref}/check-runs'));
  assert.equal(listings.length, 2, 'initial and final provider reads both use filters');
});
