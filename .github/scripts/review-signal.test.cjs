'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signalTarget, SIGNAL_PATH } = require('./review-signal.cjs');
const HEAD = 'a'.repeat(40), MERGE = 'b'.repeat(40);
function signal(conclusion) {
  return { id: 40, name: 'CodeRabbit review signal', run_attempt: 1, workflow_id: 4, path: SIGNAL_PATH,
    event: 'pull_request_review_comment', head_sha: MERGE, status: 'completed', conclusion,
    repository: { id: 1, full_name: 'o/r' }, head_repository: { full_name: 'o/r' },
    pull_requests: [{ number: 7, head: { sha: HEAD, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } } }] };
}
function reader(run) {
  const calls = [];
  const read = async (route, args) => {
    calls.push(route);
    if (route.endsWith('/workflows/{workflow_id}')) return { id: 4, path: SIGNAL_PATH, state: 'active' };
    if (route.endsWith('/runs/{run_id}') && args.run_id === run.id) return structuredClone(run);
    throw new Error(`Unexpected route ${route}`);
  };
  return { read, calls };
}
const payload = run => ({ action: 'completed', workflow_run: structuredClone(run) });

for (const conclusion of ['cancelled', 'skipped']) test(`a ${conclusion} signal run wakes nothing and reads nothing`, async () => {
  const run = signal(conclusion), { read, calls } = reader(run);
  assert.equal(await signalTarget(read, payload(run), 'o/r'), null);
  assert.deepEqual(calls, []);
});
for (const conclusion of ['success', 'failure']) test(`a ${conclusion} signal run wakes its associated PR`, async () => {
  const run = signal(conclusion), { read, calls } = reader(run);
  assert.deepEqual(await signalTarget(read, payload(run), 'o/r'), { number: 7, head: HEAD });
  assert.equal(calls.length, 2);
});
test('a live run read as cancelled wakes nothing even when the payload did not say so', async () => {
  const run = signal('cancelled'), { read } = reader(run);
  assert.equal(await signalTarget(read, payload({ ...run, conclusion: 'success' }), 'o/r'), null);
});
