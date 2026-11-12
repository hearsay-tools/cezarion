import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daemonAlive, judgeSqueal, SQUEAL_WAIT_MS } from './prepr.mjs';

const file = (path, state, verdict) => ({ path, state, ...(verdict ? { verdict } : {}) });
const status = (testFiles, extra = {}) => ({ selection: { testFiles, verdict: { failures: { tests: 0, testFiles: 0 } } }, lint: { failing: 0 }, ...extra });

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
