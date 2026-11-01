const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const yaml = require('yaml');
const root = join(__dirname, '../..');
const load = () => import('../benchmarks/vitest-changed/policy.mjs');
const scanner = 'packages/cezar/src/contract-import-boundaries.test.ts';
const unit = 'packages/web/src/lib/utils.test.ts';
const inventory = [scanner, unit];

test('pilot retains filesystem scanners that the import graph omits', async () => {
  const { mandatoryFiles, chooseFiles } = await load();
  const mandatory = mandatoryFiles(inventory, { [scanner]: ['packages/web/src/**'] });
  const selected = chooseFiles({ inventory, related: [unit], mandatory, localMode: 'changed' });
  assert.equal(selected.mode, 'selective');
  assert.deepEqual(selected.files, [...inventory].sort());
});

test('mandatory guards cannot turn an empty graph into an accepted partial selection', async () => {
  const { chooseFiles } = await load();
  const selected = chooseFiles({ inventory, related: [], mandatory: [scanner], localMode: 'changed' });
  assert.equal(selected.mode, 'full');
  assert.deepEqual(selected.files, [...inventory].sort());
});

test('unknown inputs, missing base, removed files and graph errors retain full inventory', async () => {
  const { chooseFiles } = await load();
  const cases = [
    { localMode: 'full', localReason: 'Shared, configuration, or unclassified input' },
    { localMode: 'full', localReason: 'Cannot establish complete Git changes or merge-base' },
    { localMode: 'full', localReason: 'Deleted or renamed input' },
    { localMode: 'changed', graphError: 'transform failed' },
    { localMode: 'skip', localReason: 'No changes' },
  ];
  for (const entry of cases) {
    const selected = chooseFiles({ inventory, related: [unit], mandatory: [scanner], ...entry });
    assert.equal(selected.mode, 'full', JSON.stringify(entry));
    assert.deepEqual(selected.files, [...inventory].sort());
  }
});

test('a path outside the discovered inventory cannot narrow verification', async () => {
  const { chooseFiles } = await load();
  const selected = chooseFiles({ inventory, related: ['not-a-discovered-test.ts'], mandatory: [], localMode: 'changed' });
  assert.equal(selected.mode, 'full');
});

test('campaign pairs all four shards at five immutable heads and counterbalances order', async () => {
  const { matrix } = await import('../benchmarks/vitest-changed/campaign.mjs');
  const { include } = matrix();
  assert.equal(include.length, 20);
  for (const id of new Set(include.map(entry => entry.id))) {
    const rows = include.filter(entry => entry.id === id);
    assert.deepEqual(rows.map(entry => entry.shard), [1, 2, 3, 4]);
    assert.equal(rows.filter(entry => entry.first === 'full').length, 2);
  }
});

test('pilot cannot run in the main verification flow or publish canonical coverage', () => {
  const workflow = yaml.parse(readFileSync(join(root, '.github/workflows/vitest-changed-pilot.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  assert.deepEqual(workflow.on.push.branches, ['bench/vitest-changed-ae1a5042']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.environment, undefined);
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
      if (step.uses?.startsWith('actions/upload-artifact@')) assert.ok(step.with.name.startsWith('changed-pilot-'));
    }
  }
  assert.equal(workflow.jobs.paired.strategy['fail-fast'], false);
});

test('summary charges all selector work and exposes full-run failures outside selected files', async () => {
  const { summarize } = await import('../benchmarks/vitest-changed/summarize.mjs');
  const entry = { id: 'example', head: 'a'.repeat(40), base: 'b'.repeat(40) };
  const rows = [1, 2, 3, 4].map(shard => ({ metadata: { entry, shard },
    selectionMs: 10, selectionMode: 'selective', results: [
      { mode: 'full', wallMs: 100, actual: [unit, scanner], validInventory: true,
        exitCode: 1, success: false, failedFiles: [scanner] },
      { mode: 'selective', wallMs: 25, actual: [unit], validInventory: true,
        exitCode: 0, success: true, failedFiles: [] },
    ] }));
  const [result] = summarize(rows, [entry]);
  assert.equal(result.netSavedMs, 260);
  assert.equal(result.longestSelectiveWithSelectionMs, 35);
  assert.equal(result.allCommandsPassed, false);
  assert.deepEqual(result.fullFailureFilesOutsideExecutedSelection, [scanner]);
  assert.equal(summarize(rows.slice(1), [entry])[0].complete, false);
});
