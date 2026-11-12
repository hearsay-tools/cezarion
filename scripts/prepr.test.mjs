import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daemonAlive, fallbackLines, focusedTests, judgeSqueal, prepr, SQUEAL_WAIT_MS, squealChecks, squealLines } from './prepr.mjs';

const file = (path, state, verdict) => ({ path, state, ...(verdict ? { verdict } : {}) });
const status = (testFiles, extra = {}) => ({ selection: { testFiles, verdict: { failures: { tests: 0, testFiles: 0 } } }, lint: { failing: 0, linting: { done: 1, total: 1 } }, ...extra });

test('the Squeal wait bound is 2 minutes', () => assert.equal(SQUEAL_WAIT_MS, 120_000));

test('current passing files and clean lint pass', () => {
  assert.equal(judgeSqueal(0, status([file('a.test.ts', 'current', 'pass')])).state, 'pass');
});

test('a failing current file fails and is named', () => {
  const r = judgeSqueal(1, status([file('a.test.ts', 'current', 'fail')]));
  assert.deepEqual([r.state, r.failed], ['fail', ['a.test.ts']]);
});

test('exit 1 fails even without a named file', () => {
  assert.equal(judgeSqueal(1, status([])).state, 'fail');
});

test('a lint finding fails', () => {
  assert.equal(judgeSqueal(0, status([], { lint: { failing: 2 } })).state, 'fail');
});

test('missing results name the files and pass as incomplete', () => {
  const r = judgeSqueal(3, status([file('a.test.ts', 'current', 'pass'), file('b.test.ts', 'pending')]));
  assert.deepEqual([r.state, r.missing], ['incomplete', ['b.test.ts']]);
});

test('unfinished lint is incomplete, not a failure', () => {
  assert.equal(judgeSqueal(0, status([], { lint: { failing: 0, pending: 3 } })).state, 'incomplete');
});

test('only a live daemon counts', () => {
  assert.equal(daemonAlive({ available: true, daemon: { state: 'alive' } }), true);
  assert.equal(daemonAlive({ available: false }), false);
  assert.equal(daemonAlive(undefined), false);
});

test('browser specs without a result do not count as missing', () => {
  const r = judgeSqueal(3, status([file('packages/web/e2e/a.e2e.ts', 'pending'), file('a.test.ts', 'current', 'pass')]));
  assert.equal(r.state, 'pass');
});

test('a skipped current file is not a failure', () => {
  assert.equal(judgeSqueal(0, status([file('a.test.ts', 'current', 'skip')])).state, 'pass');
});

test('an input that selects no test is named as missing', () => {
  const r = judgeSqueal(3, { ...status([]), selection: { testFiles: [], unmatched: ['src/x.ts'] } });
  assert.deepEqual([r.state, r.missing], ['incomplete', ['src/x.ts (selects no test file)']]);
});

test('a setup failure fails the gate', () => {
  const r = judgeSqueal(3, { ...status([]), selection: { testFiles: [], verdict: { failures: { setups: 1 } } } });
  assert.equal(r.state, 'fail');
});

test('absent lint evidence is incomplete', () => {
  assert.equal(judgeSqueal(0, { selection: { testFiles: [] } }).state, 'incomplete');
});

test('lint that is off or failed is incomplete, not clean', () => {
  for (const reason of [{ off: 'no oxlint installed' }, { failed: 'could not key lint inputs' }, { unreadable: 'x' }]) {
    const lint = { files: 0, failing: 0, pending: 0, stale: 0, unknown: 0, linting: { done: 0, total: 0 }, ...reason };
    assert.equal(judgeSqueal(0, { selection: { testFiles: [] }, lint }).state, 'incomplete');
  }
});

test('lint that has not started is incomplete when a linted file changed', () => {
  const notStarted = { selection: { testFiles: [] }, lint: { failing: 0, linting: { done: 0, total: 0 } } };
  assert.equal(judgeSqueal(0, notStarted, () => false, true).state, 'incomplete');
  assert.equal(judgeSqueal(0, notStarted).state, 'pass');
});

test('finished lint omits the progress field and is clean', () => {
  const done = { selection: { testFiles: [] }, lint: { files: 2000, failing: 0, pending: 0, stale: 0, unknown: 0 } };
  assert.equal(judgeSqueal(0, done, () => false, true).state, 'pass');
});

const ok = out => ({ code: 0, out, err: '' });
const live = (testFiles, lint) => JSON.stringify({ available: true, daemon: { state: 'alive' }, selection: { testFiles }, lint });
const doneLint = { failing: 0, pending: 0, stale: 0, unknown: 0 };

function fakeIo({ responses = {}, files = 'scripts/x.mjs\0', clock = { t: 0 }, noBase = false } = {}) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = [cmd, args[0], args[1]].join(' ');
      const r = responses[key] ?? responses[cmd];
      return typeof r === 'function' ? r(args) : r ?? ok('');
    },
    sleep: async ms => { clock.t += ms; },
    now: () => clock.t,
    git: (...a) => (a[0] === 'merge-base' ? (noBase ? '' : 'base123\n') : a[0] === 'diff' ? files : a[0] === 'status' ? '' : a[0] === 'rev-parse' ? 'abc1234\n' : ''),
  };
}

test('squealChecks reports no daemon when squeal is missing or not alive', async () => {
  assert.deepEqual(await squealChecks(['a.ts'], 1000, fakeIo({ responses: { squeal: { code: 127, out: '', err: '' } } })), { daemon: false });
  assert.deepEqual(await squealChecks(['a.ts'], 1000, fakeIo({ responses: { squeal: ok('not json') } })), { daemon: false });
});

test('squealChecks returns a passing verdict from one wait', async () => {
  const io = fakeIo({ responses: { squeal: ok(live([file('a.test.ts', 'current', 'pass')], doneLint)) } });
  const r = await squealChecks(['a.ts'], 1000, io);
  assert.equal(r.state, 'pass');
  assert.deepEqual(io.calls[0].slice(0, 4), ['squeal', 'status', '--wait', '1000']);
});

test('squealChecks polls lint until it finishes within the bound', async () => {
  let polls = 0;
  const io = fakeIo({ responses: { squeal: args => ok(args.includes('--wait') ? live([], { failing: 0, linting: { done: 0, total: 0 } })
    : JSON.stringify({ lint: ++polls < 2 ? { failing: 0, linting: { done: 0, total: 0 } } : doneLint })) } });
  const r = await squealChecks(['packages/a/src/x.ts'], 10_000, io);
  assert.equal(r.state, 'pass');
  assert.equal(polls, 2);
});

test('squealChecks stops polling at the deadline and stays incomplete', async () => {
  const stuck = { failing: 0, linting: { done: 0, total: 0 } };
  const io = fakeIo({ responses: { squeal: args => ok(args.includes('--wait') ? live([], stuck) : JSON.stringify({ lint: stuck })) } });
  assert.equal((await squealChecks(['packages/a/src/x.ts'], 5000, io)).state, 'incomplete');
});

test('squealChecks stops polling when a poll is unreadable', async () => {
  const stuck = { failing: 0, linting: { done: 0, total: 0 } };
  const io = fakeIo({ responses: { squeal: args => ok(args.includes('--wait') ? live([], stuck) : 'garbage') } });
  assert.equal((await squealChecks(['packages/a/src/x.ts'], 5000, io)).state, 'incomplete');
});

test('focusedTests skips a full or unreadable selection and runs a narrow one', async () => {
  const plan = out => fakeIo({ responses: { node: ok(out) } });
  assert.match((await focusedTests('b', plan('{"mode":"full"}'))).skipped, /full suite/);
  assert.equal((await focusedTests('b', plan('oops'))).code, 0);
  assert.match((await focusedTests('b', plan('{"mode":"skip"}'))).skipped, /no tests/);
  const io = plan('{"mode":"changed"}');
  assert.equal((await focusedTests('b', io)).code, 0);
  assert.deepEqual(io.calls.at(-1), ['node', 'scripts/test-changed.mjs', '--base=b']);
});

test('squealLines words each state', () => {
  const lint = { failing: 0, unfinished: 0 };
  assert.match(squealLines({ state: 'fail', failed: ['a.test.ts'], lint }, 1000)[0].text, /failing test files: a.test.ts/);
  assert.match(squealLines({ state: 'fail', failed: [], lint: { failing: 2 } }, 1000)[0].text, /2 lint finding/);
  assert.match(squealLines({ state: 'fail', failed: [], lint }, 1000)[0].text, /known test failures/);
  const missing = Array.from({ length: 12 }, (_, i) => `f${i}.test.ts`);
  const inc = squealLines({ state: 'incomplete', missing, lint: { unfinished: 3 } }, 120_000)[0];
  assert.equal(inc.ok, true);
  assert.match(inc.text, /120 s.*f9\.test\.ts, and 2 more, lint \(3 file/);
  assert.match(squealLines({ state: 'pass', count: 4, failed: [], missing: [], lint }, 1000)[0].text, /4 affected/);
});

test('fallbackLines runs focused tests and lint, and reports their failures', async () => {
  const io = fakeIo({ responses: { node: ok('{"mode":"changed"}'), npm: { code: 1, out: 'bad', err: '' } } });
  const lines = await fallbackLines('b', io);
  assert.match(lines[0].text, /No Squeal daemon/);
  assert.equal(lines[2].ok, false);
  assert.match(lines[2].text, /bad/);
});

test('prepr passes on a clean change and skips typecheck for docs only', async () => {
  const clean = fakeIo({ responses: { squeal: ok(live([file('a.test.mjs', 'current', 'pass')], doneLint)) } });
  const r = await prepr({ io: clean, waitMs: 1000 });
  assert.equal(r.failed, false);
  assert.match(r.report, /^prepr: PASS/);
  assert.ok(clean.calls.some(c => c.includes('typecheck')));
  const docs = await prepr({ io: fakeIo({ files: 'docs/x.md\0', responses: { squeal: ok(live([], doneLint)) } }), waitMs: 1000 });
  assert.match(docs.report, /skipped: typecheck/);
});

test('prepr fails when a direct check fails, and with no daemon runs the fallback', async () => {
  const bad = fakeIo({ responses: { squeal: ok(live([], doneLint)), node: args => ({ code: args[0].includes('clones') ? 1 : 0, out: 'dup', err: '' }) } });
  const r = await prepr({ io: bad, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.match(r.report, /FAIL: clones\ndup/);
  const none = await prepr({ io: fakeIo({ responses: { squeal: { code: 127, out: '', err: '' }, node: ok('{"mode":"full"}') } }), waitMs: 1000 });
  assert.match(none.report, /No Squeal daemon/);
  const empty = await prepr({ io: fakeIo({ files: '' }), waitMs: 1000 });
  assert.match(empty.report, /0 changed file/);
});

test('prepr keeps unusual path names whole and fails on a missing base', async () => {
  const io = fakeIo({ files: 'docs/caf\u00e9\tx.md\0docs/y.md\0', responses: { squeal: ok(live([], doneLint)) } });
  await prepr({ io, waitMs: 1000 });
  assert.ok(io.calls[0].includes('docs/caf\u00e9\tx.md') || io.calls.some(c => c.includes('docs/caf\u00e9\tx.md')));
  await assert.rejects(prepr({ io: fakeIo({ noBase: true }), waitMs: 1000 }), /No merge base/);
});

test('squealChecks passes a process timeout to the wait', async () => {
  const io = fakeIo({ responses: { squeal: ok(live([], doneLint)) } });
  let options;
  const run = io.run;
  io.run = async (cmd, args, o) => { options ??= o; return run(cmd, args, o); };
  await squealChecks(['a.ts'], 1000, io);
  assert.equal(options.timeout, 11_000);
});
