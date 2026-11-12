const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('./refresh-test-durations.mjs');
const files = [
  { project: 'e2e', reported: 'a.e2e.ts', file: 'a.e2e.ts' },
  { project: 'e2e', reported: 'b.e2e.ts', file: 'b.e2e.ts' },
];
const sample = (id, durationsMs) => ({ id, headSha: 'abc', jobs: [id * 10], durationsMs });

async function measuredApi(endpoint) {
  if (endpoint.endsWith('/logs')) {
    const id = Number(endpoint.match(/jobs\/(\d+)/)[1]);
    if (id >= 900) return 'Reused exact-SHA proof';
    return id % 100 < 8 ? ` ✓  e2e  a${id % 10}.e2e.ts (1 test) 100ms`
      : ` ✓  web  a${id % 10}.test.ts (1 test) 20ms`;
  }
  const id = Number(endpoint.match(/runs\/(\d+)/)[1]);
  return { jobs: ['browser', 'vitest'].flatMap((kind, k) => Array.from({ length: 8 }, (_, i) => ({
    id: id * 100 + k * 10 + i, conclusion: 'success',
    name: `${kind === 'browser' ? 'Cockpit browser E2E' : 'Vitest'} shard ${i + 1}/8`,
  }))) };
}

function measuredInventory() {
  return Object.fromEntries([['browser', 'e2e', 'e2e'], ['vitest', 'web', 'test']].map(([kind, project, suffix]) =>
    [kind, Array.from({ length: 8 }, (_, i) => ({ project, reported: `a${i}.${suffix}.ts`, file: `a${i}.${suffix}.ts` }))]));
}

test('suite summaries use project-qualified paths, skip annotations and first successful result only', async () => {
  const { parseDurations } = await load();
  const inventory = [...files, { project: 'web', reported: 'src/a.test.ts', file: 'packages/web/src/a.test.ts' }];
  const log = '\u001b[32m ✓  e2e  a.e2e.ts (4 tests | 1 skipped) 1234ms\u001b[0m\n'
    + ' ✓  e2e  a.e2e.ts (4 tests) 99ms\n ✓  e2e  b.e2e.ts (1 test) 500ms\n'
    + ' ✓  web  src/a.test.ts (1 test) 300ms\n ✓  server  src/a.test.ts (1 test) 900ms\n'
    + ' ×  e2e  b.e2e.ts (4 tests) 5000ms\n  ✓ individual test 999ms';
  assert.deepEqual(parseDurations(log, inventory), { 'a.e2e.ts': 1234, 'b.e2e.ts': 500, 'packages/web/src/a.test.ts': 300 });
});

test('refresh uses per-file medians, drops deleted paths and records estimates for new files', async () => {
  const { makeManifest } = await load();
  const samples = [sample(1, { 'a.e2e.ts': 100, removed: 10000 }), sample(2, { 'a.e2e.ts': 400 }), sample(3, { 'a.e2e.ts': 200 })];
  const result = makeManifest(files, samples, 'browser');
  assert.deepEqual(result.durationsMs, { 'a.e2e.ts': 200, 'b.e2e.ts': 200 });
  assert.deepEqual(result._provenance.estimatedFiles, ['b.e2e.ts']);
  assert.deepEqual(result._provenance.runs.map(run => run.id), [1, 2, 3]);
  assert.throws(() => makeManifest(files, samples.slice(0, 2), 'browser'), /three/);
  assert.throws(() => makeManifest(files, [samples[0], samples[0], samples[0]], 'browser'), /distinct/);
});

test('refresh opens a change only for inventory changes or both the relative and absolute drift threshold', async () => {
  const { needsRefresh } = await load();
  const old = { durationsMs: { a: 20000, b: 1000 } };
  assert.equal(needsRefresh(old, { durationsMs: { a: 24999, b: 1300 } }), false);
  assert.equal(needsRefresh(old, { durationsMs: { a: 25000, b: 1000 } }), true);
  assert.equal(needsRefresh(old, { durationsMs: { a: 20000 } }), true);
  assert.equal(needsRefresh(old, { durationsMs: { a: 20000, b: 1000, c: 500 } }), true);
  assert.equal(needsRefresh(old, { durationsMs: { b: 1000, a: 20000 }, _provenance: { runs: [99] } }), false);
});

test('only complete successful eight-shard attempts are eligible; proof reuse and partial jobs are rejected', async () => {
  const { shardJobs, trustedRun } = await load();
  const jobs = Array.from({ length: 8 }, (_, i) => ({ id: i, name: `Cockpit browser E2E shard ${i + 1}/8`, conclusion: 'success' }));
  assert.equal(shardJobs(jobs, 'browser').length, 8);
  assert.deepEqual(shardJobs(jobs.slice(1), 'browser'), []);
  assert.deepEqual(shardJobs([...jobs, jobs[0]], 'browser'), []);
  assert.deepEqual(shardJobs(jobs.map(job => ({ ...job, conclusion: 'skipped' })), 'browser'), []);
  assert.equal(trustedRun({ event: 'push', head_branch: 'main' }), true);
  assert.equal(trustedRun({ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-sha' }), true);
  assert.equal(trustedRun({ event: 'pull_request_target', head_branch: 'main' }), false);
  assert.equal(trustedRun({ event: 'workflow_dispatch', head_branch: 'feature' }), false);
  assert.equal(trustedRun({ event: 'merge_group', head_branch: 'gh-readonly-queue/release/pr-1' }), false);
});

test('collection skips reused runs and refreshes both suites from three real runs', async () => {
  const { collectSamples } = await load();
  const runs = [9, 8, 7, 6].map(id => ({ id, head_sha: 'abc', run_attempt: 1 }));
  const result = await collectSamples(runs, measuredInventory(), measuredApi);
  assert.deepEqual(result.browser.map(run => run.id), [8, 7, 6]);
  assert.deepEqual(result.vitest.map(run => run.id), [8, 7, 6]);
});

test('sufficient evidence writes changed manifests and an identical next refresh writes nothing', async () => {
  const { refresh } = await load();
  const stored = new Map();
  const options = {
    api: measuredApi, inventories: measuredInventory(),
    runs: [8, 7, 6].map(id => ({ id, run_attempt: 1, head_sha: 'abc' })),
    read: file => stored.get(file) ?? '{"durationsMs":{"deleted":100}}',
    write: (file, content) => stored.set(file, content),
  };
  const result = await refresh(options);
  assert.deepEqual(result.changes, ['.github/cockpit-test-durations.json', '.github/test-durations.json']);
  const browser = JSON.parse(stored.get(result.changes[0]));
  assert.equal(browser.durationsMs['a0.e2e.ts'], 100);
  assert.deepEqual(browser._provenance.estimatedFiles, []);
  assert.deepEqual((await refresh(options)).changes, []);
});

test('insufficient evidence keeps both manifests unchanged', async () => {
  const { refresh } = await load();
  const result = await refresh({
    api: async () => { throw new Error('No runs should need an API request'); },
    inventories: { browser: files, vitest: [] }, runs: [],
    read: () => { throw new Error('Must not read a replacement baseline'); },
    write: () => { throw new Error('Must not replace a manifest'); },
  });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.skipped, ['browser: only 0 complete runs; need three', 'vitest: only 0 complete runs; need three']);
});

test('live Vitest discovery can generate complete positive browser and unit manifests', async () => {
  const { discoverInventory, makeManifest } = await load();
  const inventory = await discoverInventory();
  const { readFileSync } = require('node:fs');
  for (const [kind, file] of [['browser', 'cockpit-test-durations.json'], ['vitest', 'test-durations.json']]) {
    const manifest = JSON.parse(readFileSync(require('node:path').join(__dirname, '..', file), 'utf8'));
    const samples = manifest._provenance.runs.map(run => ({ ...run, durationsMs: manifest.durationsMs }));
    const generated = makeManifest(inventory[kind], samples, kind);
    assert.deepEqual(Object.keys(generated.durationsMs).sort(), inventory[kind].map(entry => entry.file).sort());
    assert.equal(new Set(manifest._provenance.runs.map(run => run.id)).size >= 3, true);
    assert.equal(Object.values(manifest.durationsMs).every(value => value > 0 && Number.isFinite(value)), true);
  }
});
