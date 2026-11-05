'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { waitForCodeRabbitAdmission } = require('./coderabbit-wait.cjs');
const { fixture, HEAD, BASE } = require('./coderabbit.testkit.cjs');
const wait = (h, options = {}) => waitForCodeRabbitAdmission({ github: h.github, owner: 'o', repo: 'r',
  pullNumber: 7, head: HEAD, now: h.now, sleep: h.sleep, ...options });

test('native workflow waits for a missing, queued and running review and passes in the same job', async () => {
  const h = fixture(), check = structuredClone(h.s.checks[0]);
  h.s.checks = [];
  let polls = 0;
  const sleep = async ms => {
    await h.sleep(ms);
    polls++;
    h.s.checks = [{ ...check, status: polls === 1 ? 'queued' : polls === 2 ? 'in_progress' : 'completed',
      conclusion: polls < 3 ? null : 'success' }];
  };
  const ci = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
  const gate = ci.jobs['review-result'];
  const script = gate.steps.find(s => s.name === 'Require fresh CodeRabbit admission and resolved threads').with.script;
  const load = relative => relative.endsWith('/coderabbit-wait.cjs')
    ? { waitForCodeRabbitAdmission: args => wait(h, { ...args, sleep }) }
    : require(path.resolve(__dirname, '../..', relative));
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  const core = { summary, info() {}, notice() {} }, proc = { exitCode: 0, env: {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('require', 'github', 'context', 'core', 'process', script);
  await execute(load, h.github, { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: h.s.pr } }, core, proc);
  assert.equal(proc.exitCode, 0, 'unfinished review must stay in this job until it can pass');
  assert.equal(polls, 3);
  assert.ok(gate['timeout-minutes'] >= 25, 'job allows checkout plus the bounded provider wait');
});

test('newer pending execution takes precedence over an older success and already-open findings', async () => {
  const h = fixture();
  h.s.checks.push({ ...h.s.checks[0], id: 101, status: 'in_progress', conclusion: null });
  h.s.threads = [{ id: 'finding', isResolved: false }];
  let polls = 0;
  const result = await wait(h, { sleep: async ms => {
    await h.sleep(ms); polls++;
    h.s.checks[1].status = 'completed'; h.s.checks[1].conclusion = 'success';
  } });
  assert.equal(polls, 1);
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'unresolved-threads');
  assert.equal(result.checkId, 101);
});

for (const conclusion of ['success', 'failure', 'skipped', 'neutral', 'cancelled', 'timed_out', 'action_required']) {
  test(`completed ${conclusion} returns immediately without waiting`, async () => {
    const h = fixture(); h.s.checks[0].conclusion = conclusion;
    const result = await wait(h, { sleep: async () => assert.fail('terminal check cannot wait') });
    assert.equal(result.admitted, conclusion === 'success');
  });
}

test('trusted no-files admission returns immediately and still requires resolved threads', async () => {
  const h = fixture(); h.s.checks[0].conclusion = 'skipped';
  h.s.checks[0].output = { title: 'No files to review' };
  const sleep = async () => assert.fail('accepted no-files decision cannot wait');
  assert.equal((await wait(h, { sleep })).admitted, true);
  h.s.threads = [{ id: 'outdated', isResolved: false, isOutdated: true }];
  const blocked = await wait(h, { sleep });
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.reason, 'unresolved-threads');
});

for (const state of ['queued', 'in_progress']) {
  test(`persistent ${state} review reaches the fixed deadline and blocks admission`, async () => {
    const h = fixture(), start = h.now(); let polls = 0;
    h.s.checks[0].status = state; h.s.checks[0].conclusion = null;
    const result = await wait(h, { sleep: async ms => { polls++; await h.sleep(ms); } });
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'provider-wait-timeout');
    assert.match(result.action, /20-minute/);
    assert.equal(h.now() - start, 20 * 60 * 1000);
    assert.equal(polls, 40);
    assert.equal(h.s.calls.filter(([route]) => route.endsWith('/commits/{ref}/check-runs')).length, 80);
  });
}

test('missing check fails after its three-minute grace with manual recovery', async () => {
  const h = fixture(), start = h.now(); h.s.checks = [];
  const result = await wait(h);
  assert.equal(h.now() - start, 3 * 60 * 1000);
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'provider-missing-timeout');
  assert.match(result.action, /@coderabbitai full review/);
  assert.match(result.action, /Reconcile CodeRabbit admission.*pr_number/);
});

test('missing-check grace counts API time and clips the next sleep', async () => {
  const h = fixture(), start = h.now(); h.s.checks = [];
  h.s.onRead = () => { h.s.clock += 4000; };
  const sleeps = [];
  const result = await wait(h, { sleep: async ms => { sleeps.push(ms); await h.sleep(ms); } });
  assert.equal(result.reason, 'provider-missing-timeout');
  assert.equal(h.now() - start, 200000);
  assert.deepEqual(sleeps, [30000, 30000, 30000, 10000]);
});

test('check appearing just before grace expiry retains the overall pending budget', async () => {
  const h = fixture(), start = h.now(), check = structuredClone(h.s.checks[0]); h.s.checks = [];
  const result = await wait(h, { sleep: async ms => {
    await h.sleep(ms);
    if (h.now() - start === 150000) h.s.checks = [{ ...check, status: 'in_progress', conclusion: null }];
    if (h.now() - start === 1170000) Object.assign(h.s.checks[0], { status: 'completed', conclusion: 'success' });
  } });
  assert.equal(result.admitted, true);
  assert.equal(h.now() - start, 1170000);
});

test('poll count bounds the wait even if the clock does not advance', async () => {
  const h = fixture(); h.s.checks = []; let polls = 0;
  const result = await wait(h, { sleep: async () => { polls++; } });
  assert.equal(result.admitted, false);
  assert.equal(polls, 40);
});

test('each snapshot keeps short request limits and clips them to the overall deadline', async () => {
  const h = fixture(), start = h.now(); h.s.checks[0].status = 'in_progress';
  const result = await wait(h, { sleep: async () => {
    h.s.clock = start + 20 * 60 * 1000 - 25;
    h.s.checks[0].status = 'completed';
  } });
  assert.equal(result.admitted, true);
  assert.ok(h.s.calls.every(([, args]) => args.request.timeout <= 10000 && args.request.retries === 0));
  assert.ok(h.s.calls.slice(-5).every(([, args]) => args.request.timeout === 25));
});

test('snapshot API time counts toward the overall wait', async () => {
  const h = fixture(), start = h.now(); h.s.checks[0].status = 'in_progress';
  h.s.onRead = () => { h.s.clock += 5000; };
  const result = await wait(h);
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'provider-wait-timeout');
  assert.equal(h.now() - start, 20 * 60 * 1000);
});

test('overall deadline reached during a request returns a normal blocked result', async () => {
  const h = fixture(), start = h.now(); h.s.checks[0].status = 'in_progress';
  const result = await wait(h, { sleep: async () => {
    h.s.clock = start + 20 * 60 * 1000 - 25;
    h.s.onRead = () => { h.s.clock += 26; };
  } });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'provider-wait-timeout');
});

test('snapshot deadline before the overall deadline remains an error', async () => {
  const h = fixture(); h.s.checks = [];
  h.s.onRead = () => { h.s.clock += 60001; };
  await assert.rejects(() => wait(h), /deadline/);
});

test('request abort at the overall deadline returns a normal blocked result', async () => {
  const h = fixture(), start = h.now(); h.s.checks[0].status = 'in_progress';
  const request = h.github.request;
  h.github.request = async (...args) => {
    if (h.now() > start) {
      h.s.clock = start + 20 * 60 * 1000;
      throw new DOMException('request deadline', 'TimeoutError');
    }
    return request(...args);
  };
  const result = await wait(h);
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'provider-wait-timeout');
});

test('provider completion during a snapshot discards mixed evidence and reads again', async () => {
  const h = fixture(); h.s.checks[0].status = 'in_progress'; h.s.checks[0].conclusion = null;
  let reads = 0, polls = 0;
  h.s.onRead = route => {
    if (route.endsWith('/commits/{ref}/check-runs') && ++reads === 2) {
      h.s.checks[0].status = 'completed'; h.s.checks[0].conclusion = 'success';
    }
  };
  const result = await wait(h, { sleep: async ms => { polls++; await h.sleep(ms); } });
  assert.equal(result.admitted, true);
  assert.equal(polls, 1);
  assert.equal(reads, 4);
});

for (const change of ['head', 'api', 'pages']) {
  test(`${change} failure during the wait cannot admit or retry broken evidence`, async () => {
    const h = fixture(); h.s.checks = []; let polls = 0;
    await assert.rejects(() => wait(h, { sleep: async ms => {
      polls++; await h.sleep(ms);
      if (change === 'head') h.s.pr.head.sha = BASE;
      if (change === 'api') h.s.fail = true;
      if (change === 'pages') h.s.checkTotal = 201;
    } }));
    assert.equal(polls, 1);
  });
}
