'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { discover, reconcile, eventTarget } = require('./coderabbit-reconcile.cjs');
const { readNativeReview } = require('./native-review-proof.cjs');
const { fixture, providerRead, HEAD, BASE } = require('./coderabbit.testkit.cjs');
async function run(h, eventName = 'workflow_dispatch', extra = {}) {
  const args = { ...h, owner: 'o', repo: 'r' };
  const { numbers } = await discover({ ...args, eventName,
    payload: { repository: { full_name: 'o/r' }, inputs: { pr_number: '7' }, ...extra } });
  return Promise.all(numbers.map(pullNumber => reconcile({ ...args, pullNumber })));
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
  h.s.onRead = (route, args) => {
    if (providerRead(route, args) && ++checks === 4) h.s.run.id = 21;
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

function twoPulls() {
  const a = fixture(), b = fixture();
  b.s.pr.number = 8; b.s.pr.head.sha = 'c'.repeat(40); b.s.pr.head.ref = 'second';
  b.s.run.id = 21; b.s.run.head_sha = b.s.pr.head.sha; b.s.run.head_branch = 'second';
  b.s.run.pull_requests = [{ number: 8, head: { sha: b.s.pr.head.sha }, base: { ref: 'main' } }];
  b.s.checks[0].id = 101; b.s.checks[0].head_sha = b.s.pr.head.sha;
  b.s.jobs[0].id = 40;
  const github = { request: async (route, args) => {
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: structuredClone(a.s.pulls ?? [a.s.pr, b.s.pr]) };
    const second = args.pull_number === 8 || args.ref === b.s.pr.head.sha || args.head_sha === b.s.pr.head.sha
      || args.run_id === 21 || args.job_id === 40 || args.check_run_id === 101 || args.variables?.number === 8;
    return (second ? b : a).github.request(route, args);
  } };
  return { ...a, github, a, b };
}
for (const event of ['check_run', 'workflow_run', 'signal']) test(`independent ${event} events target A and B without unrelated proof`, async () => {
  const h = twoPulls();
  const payload = event === 'check_run' ? checkEvent(h.a) : event === 'signal' ? signal(h.a) : ciEvent(h.a);
  assert.deepEqual(await run(h, event === 'check_run' ? event : 'workflow_run', payload), ['rerun-requested']);
  assert.deepEqual(h.a.s.writes, [30]); assert.deepEqual(h.b.s.writes, []);
  assert.deepEqual(await run(h, 'workflow_run', ciEvent(h.b)), ['rerun-requested']);
  assert.deepEqual(h.b.s.writes, [40]);
});
test('manual dispatch scopes one PR without a repository-wide queue', async () => {
  const h = twoPulls();
  assert.deepEqual(await run(h), ['rerun-requested']); assert.deepEqual(h.b.s.writes, []);
});
for (const change of ['newer run', 'newer attempt']) test(`valid old source with ${change} reconciles newest native proof for its associated PR`, async () => {
  const h = twoPulls(), payload = ciEvent(h.a), request = h.github.request;
  const source = structuredClone(h.a.s.run);
  if (change === 'newer run') h.a.s.run.id = 22;
  else h.a.s.run.run_attempt = 2;
  let sourceRead = true;
  h.github.request = async (route, args) => {
    if (sourceRead && route.endsWith('/runs/{run_id}') && args.run_id === source.id) {
      sourceRead = false;
      return { data: source };
    }
    return request(route, args);
  };
  assert.deepEqual(await run(h, 'workflow_run', payload), ['rerun-requested']);
  assert.deepEqual(h.a.s.writes, [30]); assert.deepEqual(h.b.s.writes, []);
});
for (const change of ['head', 'run', 'attempt']) test(`late old signal replaces newer pending event: read latest ${change} at PR lock head`, async () => {
  const h = twoPulls(), args = { ...h, owner: 'o', repo: 'r' };
  const payload = { repository: { full_name: 'o/r' }, ...signal(h.a) };
  const { numbers } = await discover({ ...args, eventName: 'workflow_run', payload });
  assert.deepEqual(numbers, [7]);
  if (change === 'head') {
    h.a.s.pr.head.sha = 'd'.repeat(40); h.a.s.checks[0].head_sha = h.a.s.pr.head.sha;
    h.a.s.run.head_sha = h.a.s.pr.head.sha; h.a.s.run.pull_requests[0].head.sha = h.a.s.pr.head.sha;
  } else if (change === 'run') h.a.s.run.id = 22;
  else h.a.s.run.run_attempt = 2;
  const latest = { id: h.a.s.run.id, attempt: h.a.s.run.run_attempt, head: h.a.s.pr.head.sha };
  assert.deepEqual(await Promise.all(numbers.map(pullNumber => reconcile({ ...args, pullNumber }))),
    ['rerun-requested']);
  assert.ok(h.a.s.calls.some(([route, params]) => route.endsWith('/runs/{run_id}') && params.run_id === latest.id));
  assert.ok(h.a.s.calls.some(([route, params]) => route.endsWith('/workflows/{workflow_id}/runs') && params.head_sha === latest.head));
  assert.equal(h.a.s.run.run_attempt, latest.attempt + 1);
  assert.deepEqual(h.a.s.writes, [30]); assert.deepEqual(h.b.s.writes, []);
});
for (const malformed of [null, { number: 9 }, { number: 9, head: null }]) test('malformed PR listing row does not block valid PRs', async () => {
  const h = twoPulls(); h.a.s.pulls = [malformed, h.b.s.pr];
  assert.deepEqual(await run(h, 'check_run', checkEvent(h.b)), ['rerun-requested']);
  assert.deepEqual(h.b.s.writes, [40]);
});
test('missing native CI for A does not block B', async () => {
  const h = twoPulls(); h.a.s.runs = [];
  assert.deepEqual(await run(h, 'check_run', checkEvent(h.a)), ['native-evidence-unavailable']);
  assert.deepEqual(await run(h, 'check_run', checkEvent(h.b)), ['rerun-requested']);
  assert.deepEqual(h.a.s.writes, []); assert.deepEqual(h.b.s.writes, [40]);
});
test('invalid event cannot start discovery or writes for any PR', async () => {
  const h = twoPulls(), payload = checkEvent(h.a); payload.check_run.app.id = 1;
  assert.deepEqual(await run(h, 'check_run', payload), []);
  assert.deepEqual(h.a.s.calls, []); assert.deepEqual(h.b.s.calls, []);
});
test('each matrix job has a new deadline even after another PR exhausts its budget', async () => {
  const h = twoPulls(), args = { ...h, owner: 'o', repo: 'r' };
  const discovery = await discover({ ...args, eventName: 'check_run', payload: { repository: { full_name: 'o/r' }, ...checkEvent(h.a) } });
  assert.deepEqual(discovery.numbers, [7]);
  const second = await discover({ ...args, eventName: 'workflow_run', payload: { repository: { full_name: 'o/r' }, ...ciEvent(h.b) } });
  assert.deepEqual(second.numbers, [8]);
  h.a.s.onRead = route => { if (route.endsWith('/pulls/{pull_number}')) h.a.s.clock += 120001; };
  await assert.rejects(() => reconcile({ ...args, pullNumber: 7 }), /deadline/);
  assert.equal(await reconcile({ ...args, pullNumber: 8 }), 'rerun-requested');
  assert.deepEqual(h.b.s.writes, [40]);
});
test('one PR ambiguous write fails independently while another PR completes', async () => {
  const h = twoPulls(), args = { ...h, owner: 'o', repo: 'r' };
  h.a.s.writeError = true;
  h.a.s.checks[0].pull_requests = [...h.a.s.run.pull_requests, ...h.b.s.run.pull_requests];
  const { numbers } = await discover({ ...args, eventName: 'check_run', payload: { repository: { full_name: 'o/r' }, ...checkEvent(h.a) } });
  const results = await Promise.allSettled(numbers.map(pullNumber => reconcile({ ...args, pullNumber })));
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /acceptance not yet visible/);
  assert.equal(results[1].value, 'rerun-requested');
  assert.deepEqual(h.a.s.writes, [30]); assert.deepEqual(h.b.s.writes, [40]);
});

test('valid old signal association wakes the current head without authorizing historical proof', async () => {
  const h = fixture(), payload = signal(h);
  h.s.signal.pull_requests[0].head.sha = BASE;
  assert.deepEqual(await run(h, 'workflow_run', payload), ['rerun-requested']);
  assert.deepEqual(h.s.writes, [30]);
});

const discoverEvent = (h, eventName, payload) => discover({ ...h, owner: 'o', repo: 'r', eventName,
  payload: { repository: { full_name: 'o/r' }, ...payload } });
const association = number => ({ number, head: { sha: HEAD }, base: { ref: 'main' } });
function crowdedInventory(h) {
  h.s.pulls = [h.s.pr, ...Array.from({ length: 63 }, (_, i) => ({ ...structuredClone(h.s.pr), number: 100 + i,
    head: { ...h.s.pr.head, sha: BASE } }))];
}
for (const event of ['CI', 'signal', 'associated check']) test(`${event} discovery targets only its associated PR among 63 unrelated PRs`, async () => {
  const h = fixture(); crowdedInventory(h);
  h.s.checks[0].pull_requests = [association(7)];
  const payload = event === 'CI' ? ciEvent(h) : event === 'signal' ? signal(h) : checkEvent(h);
  assert.deepEqual(await discoverEvent(h, event === 'associated check' ? 'check_run' : 'workflow_run', payload), { numbers: [7] });
  assert.equal(h.s.calls.some(([route]) => route === 'GET /repos/{owner}/{repo}/pulls'), false, 'associated event must not scan inventory');
  assert.equal(h.s.calls.some(([route]) => route.endsWith('/commits/{ref}/check-runs') || route.endsWith('/workflows/{workflow_id}/runs')), false);
});

test('unassociated provider fallback selects only live matching heads and dedupes them', async () => {
  const h = fixture(); crowdedInventory(h);
  const second = { ...structuredClone(h.s.pr), number: 8 };
  h.s.pulls.push(second, second);
  const request = h.github.request;
  h.github.request = async (route, args) => args.pull_number === 8 ? { data: structuredClone(second) } : request(route, args);
  assert.deepEqual(await discoverEvent(h, 'check_run', checkEvent(h)), { numbers: [7, 8] });
  assert.equal(h.s.calls.filter(([route]) => route === 'GET /repos/{owner}/{repo}/pulls').length, 1);
});

test('unassociated stale provider head with no current match is a no-op', async () => {
  const h = fixture(); h.s.pr.head.sha = BASE;
  assert.deepEqual(await discoverEvent(h, 'check_run', checkEvent(h)), { numbers: [] });
  assert.deepEqual(h.s.writes, []);
});

test('unassociated provider fallback rechecks its head match after inventory selection', async () => {
  const h = fixture();
  h.s.onRead = route => { if (route.endsWith('/pulls/{pull_number}')) h.s.pr.head.sha = BASE; };
  assert.deepEqual(await discoverEvent(h, 'check_run', checkEvent(h)), { numbers: [] });
});

for (const event of ['CI', 'check']) {
  for (const associations of [undefined, null, {}, [null], [{ number: 7 }], [association(-1)],
    Array.from({ length: 5 }, (_, i) => association(i + 7))]) {
    test(`${event} malformed or oversized official association fails closed: ${JSON.stringify(associations)}`, async () => {
      const h = fixture();
      (event === 'CI' ? h.s.run : h.s.checks[0]).pull_requests = associations;
      await assert.rejects(() => discoverEvent(h, event === 'CI' ? 'workflow_run' : 'check_run', event === 'CI' ? ciEvent(h) : checkEvent(h)), /association.*pr_number/);
      assert.equal(h.s.calls.some(([route]) => route === 'GET /repos/{owner}/{repo}/pulls'), false, 'malformed data cannot widen discovery');
      assert.deepEqual(h.s.writes, []);
    });
  }
}

test('missing CI association fails closed with manual recovery instead of inventory fanout', async () => {
  const h = fixture(); h.s.run.pull_requests = [];
  await assert.rejects(() => discoverEvent(h, 'workflow_run', ciEvent(h)), /association.*pr_number/);
  assert.equal(h.s.calls.some(([route]) => route === 'GET /repos/{owner}/{repo}/pulls'), false);
});

for (const event of ['CI', 'check']) test(`${event} multiple official associations are deduped and live eligibility filters forks`, async () => {
  const h = fixture();
  (event === 'CI' ? h.s.run : h.s.checks[0]).pull_requests = [association(7), association(8), association(7), association(9)];
  const request = h.github.request;
  h.github.request = async (route, args) => args.pull_number === 8 ? { data: { ...structuredClone(h.s.pr), number: 8 } }
    : args.pull_number === 9 ? { data: { ...structuredClone(h.s.pr), number: 9, head: { ...h.s.pr.head, repo: { full_name: 'fork/r' } } } }
      : request(route, args);
  assert.deepEqual(await discoverEvent(h, event === 'CI' ? 'workflow_run' : 'check_run', event === 'CI' ? ciEvent(h) : checkEvent(h)), { numbers: [7, 8] });
});

test('too many eligible head matches fail closed with manual recovery', async () => {
  const h = fixture(); h.s.pulls = Array.from({ length: 5 }, (_, i) => ({ ...structuredClone(h.s.pr), number: i + 7 }));
  await assert.rejects(() => discoverEvent(h, 'check_run', checkEvent(h)), /matching PR targets.*pr_number/);
});

test('full provider fallback inventory fails closed after two pages instead of silent truncation', async () => {
  const h = fixture(); h.s.pulls = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(h.s.pr), number: i + 7 }));
  await assert.rejects(() => discoverEvent(h, 'check_run', checkEvent(h)), /pagination limit.*pr_number/);
  assert.equal(h.s.calls.filter(([route]) => route === 'GET /repos/{owner}/{repo}/pulls').length, 2);
});

test('old associated CI with a different source SHA wakes its PR and proves the newest head', async () => {
  const h = fixture(), source = structuredClone(h.s.run);
  source.id = 19; source.head_sha = BASE; source.pull_requests[0].head.sha = BASE;
  const request = h.github.request;
  h.github.request = async (route, args) => args.run_id === 19 && route.endsWith('/runs/{run_id}')
    ? { data: structuredClone(source) } : request(route, args);
  assert.deepEqual(await run(h, 'workflow_run', { action: 'completed', workflow_run: source }), ['rerun-requested']);
  assert.ok(h.s.calls.some(([route, args]) => route.endsWith('/workflows/{workflow_id}/runs') && args.head_sha === HEAD));
});

test('old associated provider check wakes its current PR without an event-head filter', async () => {
  const h = fixture(), source = structuredClone(h.s.checks[0]);
  source.id = 99; source.head_sha = BASE; source.pull_requests = [association(7)];
  const request = h.github.request;
  h.github.request = async (route, args) => args.check_run_id === 99 ? { data: structuredClone(source) } : request(route, args);
  assert.deepEqual(await run(h, 'check_run', { action: 'completed', check_run: source }), ['rerun-requested']);
});

test('trusted no-files decision refreshes only the failed native gate without requesting a model', async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  assert.deepEqual(await run(h, 'check_run', checkEvent(h)), ['rerun-requested']);
  assert.deepEqual(h.s.writes, [30]);
  assert.ok(h.s.calls.filter(([route]) => route.startsWith('POST')).every(([route]) =>
    route === 'POST /graphql' || route.endsWith('/actions/jobs/{job_id}/rerun')));
});

test('failed old execution-only native gate never reruns for a trusted no-files decision', async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  h.s.jobs[0].steps = [{ name: 'Require fresh CodeRabbit execution and resolved threads' }];
  const logs = []; h.log = message => logs.push(message);
  assert.deepEqual(await run(h), ['legacy-workflow']);
  assert.deepEqual(h.s.writes, []);
  assert.match(logs.join(' '), /Push a new head or start a new native run after rollout/);
});
test('trusted no-files decision with native green is unchanged', async () => {
  const h = fixture(); Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  h.s.jobs[0].conclusion = 'success'; h.s.run.conclusion = 'success';
  assert.deepEqual(await run(h), ['unchanged']);
  assert.deepEqual(h.s.writes, []);
});

function historicalGreen() {
  const h = fixture();
  h.s.jobs[0].steps = [{ name: 'Require fresh CodeRabbit execution and resolved threads' }];
  h.s.jobs[0].conclusion = 'success'; h.s.run.conclusion = 'success';
  return h;
}
for (const [name, mutate] of Object.entries({
  'reopened thread': s => { s.threads = [{ id: 'open', isResolved: false }]; },
  'outdated reopened thread': s => { s.threads = [{ id: 'outdated', isResolved: false, isOutdated: true }]; },
  'pending provider': s => { s.checks[0].status = 'in_progress'; s.checks[0].conclusion = null; },
  'latest provider failure': s => { s.checks.push({ ...s.checks[0], id: 101, conclusion: 'failure' }); },
  'generic skipped provider': s => { s.checks[0].conclusion = 'skipped'; },
  'missing provider': s => { s.checks = []; },
  'untrusted provider': s => { s.checks[0].app.id = 42; },
})) test(`historical green is revoked for ${name}`, async () => {
  const h = historicalGreen(); mutate(h.s);
  const result = await run(h);
  assert.deepEqual(h.s.writes, [30]);
  assert.deepEqual(result, ['rerun-requested']);
  assert.equal(h.s.calls.filter(([route, args]) => providerRead(route, args)).length, 4,
    'read validated live admission twice before the native rerun');
});
for (const conclusion of ['success', 'skipped']) test(`historical green stays unchanged for admitted ${conclusion}`, async () => {
  const h = historicalGreen();
  Object.assign(h.s.checks[0], { conclusion, output: { title: 'No files to review' } });
  assert.deepEqual(await run(h), ['unchanged']);
  assert.deepEqual(h.s.writes, []);
});
test('historical revocation followed by no-files cannot promote or repeat the old job', async () => {
  const h = historicalGreen(); h.s.threads = [{ id: 'open', isResolved: false }];
  assert.deepEqual(await run(h), ['rerun-requested']);
  h.s.run.status = 'completed'; h.s.run.conclusion = 'failure'; h.s.jobs[0].conclusion = 'failure';
  h.s.threads[0].isResolved = true;
  Object.assign(h.s.checks[0], { conclusion: 'skipped', output: { title: 'No files to review' } });
  const logs = []; h.log = message => logs.push(message);
  assert.deepEqual(await run(h), ['legacy-workflow']);
  assert.deepEqual(h.s.writes, [30], 'the failed historical job never loops on the no-files decision');
  assert.match(logs.join(' '), /Push a new head or start a new native run after rollout/);
});
for (const marker of ['Require fresh CodeRabbit execution and resolved threads', 'Require fresh CodeRabbit admission and resolved threads']) {
  test(`model workflow stays refused despite green ${marker}`, async () => {
    const h = historicalGreen(); h.s.jobs[0].steps[0].name = marker;
    h.s.threads = [{ id: 'open', isResolved: false }];
    h.s.run.referenced_workflows = [{ path: 'o/r/.github/workflows/automated-code-review.yml@refs/heads/main' }];
    assert.deepEqual(await run(h), ['legacy-workflow']);
    assert.deepEqual(h.s.writes, []);
    assert.ok(h.s.calls.every(([route, args]) => !providerRead(route, args)));
  });
}
for (const change of ['provider', 'head', 'run', 'attempt', 'policy', 'job']) test(`historical revocation refuses changed ${change} before POST`, async () => {
  const h = historicalGreen(); h.s.checks[0].status = 'queued'; h.s.checks[0].conclusion = null;
  let checks = 0;
  h.s.onRead = (route, args) => {
    if (!providerRead(route, args)) return;
    checks++;
    if (checks === 3 && change === 'provider') Object.assign(h.s.checks[0], { status: 'completed', conclusion: 'success' });
    if (checks === 3 && change === 'head') h.s.pr.head.sha = BASE;
    if (checks !== 4) return;
    if (change === 'run') h.s.run.id = 21;
    if (change === 'attempt') h.s.run.run_attempt++;
    if (change === 'policy') h.s.jobs[0].steps = [{ name: 'Require fresh CodeRabbit admission and resolved threads' }];
    if (change === 'job') h.s.jobs[0].conclusion = 'failure';
  };
  assert.deepEqual(await run(h), ['changed']);
  assert.deepEqual(h.s.writes, []);
});
for (const historical of [false, true]) test(`admission read error revocation preserves policy direction (historical=${historical})`, async () => {
  const h = historical ? historicalGreen() : fixture();
  h.s.jobs[0].conclusion = 'success'; h.s.run.conclusion = 'success';
  h.s.onRead = (route, args) => { if (providerRead(route, args)) throw new Error('Provider read failed'); };
  assert.deepEqual(await run(h), [historical ? 'review-evidence-unavailable' : 'rerun-requested']);
  assert.deepEqual(h.s.writes, historical ? [] : [30]);
});

for (const policy of ['current', 'execution-only']) test(`manual dispatch preserves ${policy} native policy after provider recovery`, async () => {
  const h = fixture(); h.s.checks = [];
  if (policy === 'execution-only') h.s.jobs[0].steps = [{ name: 'Require fresh CodeRabbit execution and resolved threads' }];
  assert.deepEqual(await run(h), [policy === 'current' ? 'unchanged' : 'legacy-workflow']);
  h.s.checks = fixture().s.checks;
  assert.deepEqual(await run(h), [policy === 'current' ? 'rerun-requested' : 'legacy-workflow']);
  assert.deepEqual(h.s.writes, policy === 'current' ? [30] : []);
  if (policy === 'current') {
    h.s.run.status = 'completed'; h.s.jobs[0].conclusion = 'success';
    assert.deepEqual(await run(h), ['unchanged']);
    assert.deepEqual(h.s.writes, [30]);
  }
});

// Per-PR read budget (hearsay-tools/squawk CI API quota plan): the merged job
// reads each piece of evidence once and skips reads that cannot change a decision.
const perPrReads = h => h.s.calls.filter(([route]) => !route.startsWith('POST')).length;
async function reconcileOnly(h, extra = {}) {
  return reconcile({ ...h, owner: 'o', repo: 'r', pullNumber: 7, ...extra });
}
test('a running native review skips native proof and admission reads', async () => {
  const h = fixture(); h.s.jobs[0].status = 'in_progress'; h.s.jobs[0].conclusion = null;
  assert.equal(await reconcileOnly(h), 'job-not-completed-or-preflight-failed');
  assert.equal(perPrReads(h), 4, 'PR, branch rules, head check runs, commit statuses');
  assert.ok(h.s.calls.every(([route, args]) => !providerRead(route, args) && !route.includes('/actions/')));
});
test('a completed native review reads proof and admission once for an unchanged decision', async () => {
  const h = fixture(); h.s.jobs[0].conclusion = 'success'; h.s.run.conclusion = 'success';
  assert.equal(await reconcileOnly(h), 'unchanged');
  // 4 head reads + 6 native proof + 5 admission (PR, provider, threads, provider, PR).
  assert.equal(perPrReads(h) + h.s.calls.filter(([route]) => route === 'POST /graphql').length, 15);
});
test('unreadable head checks still reconcile, and only the board sync is skipped', async () => {
  const h = fixture(); const logs = [];
  h.s.onRead = route => { if (route.endsWith('/rules/branches/{branch}')) throw new Error('rules unavailable'); };
  assert.equal(await reconcileOnly(h, { log: message => logs.push(message) }), 'rerun-requested');
  assert.match(logs.join('\n'), /required checks unavailable; board sync skipped/);
});
test('reads use the read client and only the rerun POST uses the Actions token', async () => {
  const h = fixture(), writes = [];
  const github = { request: async (route, args) => {
    writes.push(route);
    return h.github.request(route, args);
  } };
  assert.equal(await reconcileOnly(h, { github, readGithub: h.github }), 'rerun-requested');
  assert.deepEqual(writes, ['POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun']);
  assert.ok(h.s.calls.filter(([route]) => !route.startsWith('POST')).length > 10);
});
