'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { signalTarget, SIGNAL_PATH } = require('./review-signal.cjs');
const HEAD = 'a'.repeat(40), MERGE = 'b'.repeat(40);
const LIST = 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs';
function signal(conclusion, { id = 40, number = 7, status = 'completed' } = {}) {
  return { id, name: 'CodeRabbit review signal', run_attempt: 1, workflow_id: 4, path: SIGNAL_PATH,
    event: 'pull_request_review_comment', head_sha: MERGE, status, conclusion,
    repository: { id: 1, full_name: 'o/r' }, head_repository: { full_name: 'o/r' },
    pull_requests: [{ number, head: { sha: HEAD, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } } }] };
}
function reader(run, { runs = [run], listError = false } = {}) {
  const calls = [];
  const read = async (route, args) => {
    calls.push([route, args]);
    if (route === LIST) {
      if (listError) throw new Error('API rate limit exceeded');
      return { total_count: runs?.length ?? 0, workflow_runs: structuredClone(runs) };
    }
    if (route.endsWith('/workflows/{workflow_id}')) return { id: 4, path: SIGNAL_PATH, state: 'active' };
    if (route.endsWith('/runs/{run_id}') && args.run_id === run.id) return structuredClone(run);
    throw new Error(`Unexpected route ${route}`);
  };
  return { read, calls, routes: () => calls.map(([route]) => route) };
}
const payload = run => ({ action: 'completed', workflow_run: structuredClone(run) });
const WAKE = { number: 7, head: HEAD };

for (const conclusion of ['success', 'failure']) test(`a ${conclusion} signal run wakes its PR without a run listing`, async () => {
  const run = signal(conclusion), r = reader(run);
  assert.deepEqual(await signalTarget(r.read, payload(run), 'o/r'), WAKE);
  assert.equal(r.calls.length, 2); assert.ok(!r.routes().includes(LIST));
});
for (const conclusion of ['cancelled', 'skipped']) for (const status of ['queued', 'in_progress', 'completed']) {
  test(`a ${conclusion} run superseded by a ${status} newer run for the same PR wakes nothing after one read`, async () => {
    const run = signal(conclusion), newer = signal(status === 'completed' ? 'success' : null, { id: 41, status });
    const r = reader(run, { runs: [newer, run] });
    assert.equal(await signalTarget(r.read, payload(run), 'o/r'), null);
    assert.deepEqual(r.calls, [[LIST, { workflow_id: 4, head_sha: MERGE, per_page: 10 }]]);
  });
}
test('a lone cancelled run wakes its PR', async () => {
  const run = signal('cancelled'), r = reader(run, { runs: [run, signal('success', { id: 39 })] });
  assert.deepEqual(await signalTarget(r.read, payload(run), 'o/r'), WAKE);
  assert.equal(r.calls.length, 3);
});
test('a newer run for another PR does not supersede a cancelled run', async () => {
  const run = signal('cancelled'), r = reader(run, { runs: [signal('success', { id: 41, number: 8 }), run] });
  assert.deepEqual(await signalTarget(r.read, payload(run), 'o/r'), WAKE);
});
test('a failed run listing wakes the cancelled run PR', async () => {
  const run = signal('cancelled'), r = reader(run, { listError: true });
  assert.deepEqual(await signalTarget(r.read, payload(run), 'o/r'), WAKE);
});
test('a malformed run listing wakes the cancelled run PR', async () => {
  const run = signal('cancelled'), r = reader(run, { runs: null });
  assert.deepEqual(await signalTarget(r.read, payload(run), 'o/r'), WAKE);
});
