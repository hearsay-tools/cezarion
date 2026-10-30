'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, 'merge-vitest-coverage.mjs');
const ROOT = '/home/runner/work/cezarion/cezarion';
const at = (line) => ({ start: { line, column: 0 }, end: { line, column: 10 } });

function entry(file, statements) {
  return {
    path: file,
    statementMap: Object.fromEntries(statements.map((_, i) => [i, at(i + 1)])),
    fnMap: { 0: { name: 'run', decl: at(1), loc: at(1) } },
    branchMap: {},
    s: Object.fromEntries(statements.map((n, i) => [i, n])),
    f: { 0: statements[0] },
    b: {},
  };
}

function workspace(t, shards) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [number, report] of Object.entries(shards)) {
    const folder = path.join(dir, 'in', `vitest-coverage-shard-${number}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'coverage-final.json'), typeof report === 'string' ? report : JSON.stringify(report));
  }
  return { dir, input: path.join(dir, 'in'), output: path.join(dir, 'out') };
}

const keyed = (file, statements) => ({ [file]: entry(file, statements) });
const src = `${ROOT}/packages/cezar/src/run.ts`;
const spec = `${ROOT}/packages/cezar/src/run.test.ts`;

function load() {
  return import(script);
}

test('three shard reports merge into one report keyed by repo-relative paths, test files included', async (t) => {
  const { mergeShardReports } = await load();
  const w = workspace(t, {
    1: { ...keyed(src, [1, 0]), ...keyed(spec, [2]) },
    2: keyed(src, [3, 4]),
    3: keyed(`${ROOT}/packages/contract/src/waits.ts`, [5]),
  });
  const { report } = mergeShardReports({ input: w.input, shards: 3, root: ROOT });
  assert.deepEqual(Object.keys(report).sort(), ['packages/cezar/src/run.test.ts', 'packages/cezar/src/run.ts', 'packages/contract/src/waits.ts']);
  assert.equal(report['packages/cezar/src/run.ts'].path, 'packages/cezar/src/run.ts');
  assert.deepEqual(report['packages/cezar/src/run.ts'].s, { 0: 4, 1: 4 });
  assert.equal(report['packages/cezar/src/run.test.ts'].path, 'packages/cezar/src/run.test.ts');
});

test('a missing shard names every missing number and produces no report', async (t) => {
  const { mergeShardReports } = await load();
  const w = workspace(t, { 1: keyed(src, [1]) });
  assert.throws(() => mergeShardReports({ input: w.input, shards: 3, root: ROOT }),
    (error) => error.message === 'Missing coverage for shard 2, shard 3.');
});

test('a shard report that is not JSON is named, not skipped', async (t) => {
  const { mergeShardReports } = await load();
  const w = workspace(t, { 1: keyed(src, [1]), 2: '{not json' });
  assert.throws(() => mergeShardReports({ input: w.input, shards: 2, root: ROOT }),
    (error) => /^Shard 2 report is not valid JSON/.test(error.message));
});

test('a file outside the workspace root stops the merge', async (t) => {
  const { mergeShardReports } = await load();
  const w = workspace(t, { 1: keyed('/tmp/elsewhere/run.ts', [1]) });
  assert.throws(() => mergeShardReports({ input: w.input, shards: 1, root: ROOT }),
    (error) => error.message === 'Coverage path is outside the workspace: /tmp/elsewhere/run.ts');
});

test('the command writes the merged report and provenance, and leaves the output directory empty on failure', (t) => {
  const ok = workspace(t, { 1: keyed(src, [1]), 2: keyed(src, [1]) });
  const run = (w, extra = []) => spawnSync(process.execPath, [script, '--input', w.input, '--output', w.output, '--shards', '2', '--root', ROOT,
    '--meta', 'headSha=abc', '--meta', 'runId=7', ...extra], { encoding: 'utf8' });
  const done = run(ok);
  assert.equal(done.status, 0, done.stderr);
  const merged = JSON.parse(fs.readFileSync(path.join(ok.output, 'coverage-final.json'), 'utf8'));
  assert.deepEqual(Object.keys(merged), ['packages/cezar/src/run.ts']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ok.output, 'provenance.json'), 'utf8')),
    { headSha: 'abc', runId: '7', shards: 2, files: 1, paths: 'relative to the repository root' });

  const bad = workspace(t, { 1: keyed(src, [1]) });
  const failed = run(bad);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr.trim(), 'Missing coverage for shard 2.');
  assert.equal(fs.existsSync(bad.output), false);
});

test('the command runs, and does not quietly succeed, when it is started through a symlinked path', (t) => {
  const w = workspace(t, { 1: keyed(src, [1]) });
  const link = path.join(w.dir, 'scripts-link');
  fs.symlinkSync(__dirname, link);
  const run = (shards) => spawnSync(process.execPath, [path.join(link, 'merge-vitest-coverage.mjs'), '--input', w.input,
    '--output', w.output, '--shards', String(shards), '--root', ROOT], { encoding: 'utf8' });
  const done = run(1);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(fs.existsSync(path.join(w.output, 'coverage-final.json')), 'a successful run must write the report');
  assert.equal(run(2).status, 1, 'a missing shard must fail through a symlink too');
});

test('four shard merge retains fourth-only coverage and sums all contributions', async (t) => {
  const { mergeShardReports } = await load();
  const fourth = `${ROOT}/packages/cezar/src/fourth.test.ts`;
  const w = workspace(t, {
    1: keyed(src, [1, 0]), 2: keyed(src, [2, 0]), 3: keyed(src, [4, 0]),
    4: { ...keyed(src, [8, 16]), ...keyed(fourth, [32]) },
  });
  const { report } = mergeShardReports({ input: w.input, shards: 4, root: ROOT });
  assert.deepEqual(report['packages/cezar/src/run.ts'].s, { 0: 15, 1: 16 });
  assert.deepEqual(report['packages/cezar/src/run.ts'].f, { 0: 15 });
  assert.deepEqual(report['packages/cezar/src/fourth.test.ts'].s, { 0: 32 });
});

test('four shard merge rejects absent or malformed fourth input', async (t) => {
  const { mergeShardReports } = await load();
  const reports = { 1: keyed(src, [1]), 2: keyed(src, [2]), 3: keyed(src, [4]) };
  const missing = workspace(t, reports);
  assert.throws(() => mergeShardReports({ input: missing.input, shards: 4, root: ROOT }), /Missing coverage for shard 4\./);
  const malformed = workspace(t, { ...reports, 4: '{truncated' });
  assert.throws(() => mergeShardReports({ input: malformed.input, shards: 4, root: ROOT }), /Shard 4 report is not valid JSON/);
});
