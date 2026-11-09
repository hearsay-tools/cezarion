'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('./mutants-file.cjs');
const file = 'packages/cezar/src/example.ts';
const ranges = [{ name: 'guard', range: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 } } }];
const report = { files: { [file]: { source: 'true\n', mutants: [{ id: '1', status: 'Survived', mutatorName: 'BooleanLiteral', replacement: 'false', static: true, location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } }] } } };
const saved = () => m.measure(report, file, 'original-head', ranges);
function storedDeps(inputs) {
  const writes = [];
  const logs = [];
  return { writes, logs, readJson: name => { if (!(name in inputs)) throw Error('missing input'); return inputs[name]; }, read: () => '[]', validateOutput: () => {}, write: (...args) => writes.push(args), log: line => logs.push(line) };
}

test('stored modes parse independently and reject measurement flags', () => {
  assert.equal(m.parseArgs(['--rescore', 'a.json']).rescore, 'a.json');
  assert.deepEqual(m.parseArgs(['--compare-results', 'a.json', 'b.json']).compareResults, ['a.json', 'b.json']);
  for (const args of [['--rescore'], ['--compare-results', 'a'], ['--rescore', 'a', '--compare', 'b'], ['--rescore', 'a', '--concurrency', '2'], ['--compare-results', 'a', 'b', 'extra']]) assert.throws(() => m.parseArgs(args));
  assert.throws(() => m.parseArgs([]), /measures the committed HEAD/);
});

test('missing and incompatible comparison inputs fail before allocating scratch', async () => {
  let scratch = 0;
  const deps = { ...storedDeps({}), scratch: () => { scratch++; throw Error('scratch reached'); } };
  await assert.rejects(m.runMeasurement({ file, compare: 'missing' }, deps), /missing input/);
  deps.readJson = () => ({ ...saved(), version: 1 });
  await assert.rejects(m.runMeasurement({ file, compare: 'bad' }, deps), /version/);
  deps.readJson = () => ({ ...saved(), file: 'packages/web/src/other.ts' });
  await assert.rejects(m.runMeasurement({ file, compare: 'bad' }, deps), /same.*file/);
  assert.equal(scratch, 0);
});

test('rescore retains original evidence, restores excluded mutants, and preserves consumer failure', async () => {
  const initial = saved();
  initial.mutants = [];
  initial.equivalentCount = 1;
  initial.consumers = { state: 'failed', reason: 'initial run failed', tests: ['consumer.test.ts'] };
  const deps = storedDeps({ 'before.json': initial });
  const code = await m.cli(['--rescore', 'before.json', '--out', 'after.json'], deps, new EventEmitter());
  assert.equal(code, 2);
  const result = JSON.parse(deps.writes[0][1]);
  assert.equal(result.head, 'original-head');
  assert.equal(result.mutants.length, 1);
  assert.equal(result.staticCounts.survived, 1);
  assert.equal(result.rescored, true);
  assert.equal(result.consumers.reason, 'initial run failed');
  assert.equal(initial.equivalentCount, 1);
  assert.match(deps.logs.join('\n'), /Rescored/);
});

test('legacy results compare but cannot claim an exact rescore', async () => {
  const old = saved();
  delete old.scoringEvidence;
  const deps = storedDeps({ old, new: saved() });
  await assert.rejects(m.cli(['--rescore', 'old'], deps, new EventEmitter()), /scoring evidence/);
  assert.equal(await m.cli(['--compare-results', 'old', 'new', '--out', 'delta'], deps, new EventEmitter()), 0);
  assert.equal(JSON.parse(deps.writes[0][1]).score, 0);
});

test('output validation does not truncate files and refuses aliases to inputs', t => {
  const { validateOutput } = require('./mutants-file-results.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, 'keep');
  validateOutput(input, []);
  assert.equal(fs.readFileSync(input, 'utf8'), 'keep');
  assert.throws(() => validateOutput(input, [input]), /input/);
  const link = path.join(dir, 'link');
  fs.symlinkSync(input, link);
  assert.throws(() => validateOutput(link, [input]), /input/);
  const hard = path.join(dir, 'hard');
  fs.linkSync(input, hard);
  assert.throws(() => validateOutput(hard, [input]), /input/);
  assert.throws(() => validateOutput(dir, []), /file/);
  assert.throws(() => validateOutput(path.join(dir, 'missing', 'out'), []));
  const out = path.join(dir, 'new.json');
  validateOutput(out, []);
  assert.equal(fs.existsSync(out), false);
});

test('invalid output fails before scratch and stored operations reject malformed results', async () => {
  const deps = storedDeps({ bad: { version: 2, file }, good: saved() });
  deps.validateOutput = () => { throw Error('unusable output'); };
  await assert.rejects(m.runMeasurement({ file, out: 'bad-output' }, deps), /unusable output/);
  await assert.rejects(m.cli(['--compare-results', 'bad', 'good'], deps, new EventEmitter()), /result/);
});

test('rescore applies current equivalents and guard targets without losing missing or duplicate names', async () => {
  const guarded = 'packages/cezar/src/task-cli/cli.ts';
  const guardedReport = { files: { [guarded]: report.files[file] } };
  const named = [{ ...ranges[0], name: 'validateFlags' }];
  const before = m.measure(guardedReport, guarded, 'head', named, {});
  const entry = { file: guarded, function: 'validateFlags', mutator: 'BooleanLiteral', original: 'true', replacement: 'false', reason: 'fixture equivalent' };
  const deps = storedDeps({ before });
  deps.read = () => JSON.stringify([entry]);
  await m.cli(['--rescore', 'before', '--out', 'after'], deps, new EventEmitter());
  const result = JSON.parse(deps.writes[0][1]);
  assert.equal(result.equivalentCount, 1);
  assert.equal(result.guards.find(g => g.name === 'validateFlags').pass, true);
  assert.equal(result.guards.find(g => g.name === 'positiveInt').found, false);
  assert.equal(result.rawCounts.survived, 1);
  before.scoringEvidence.ranges = [...named, ...named];
  await m.cli(['--rescore', 'before', '--out', 'after2'], deps, new EventEmitter());
  const duplicate = JSON.parse(deps.writes[1][1]);
  assert.equal(duplicate.equivalentCount, 0);
  assert.equal(duplicate.ambiguousEquivalent.length, 1);
  assert.equal(duplicate.guards.find(g => g.name === 'validateFlags').pass, false);
});

test('comparison reports real changes and rejects incompatible files and malformed scoring evidence', async () => {
  const before = saved();
  const killed = structuredClone(report);
  killed.files[file].mutants[0].status = 'Killed';
  const after = m.measure(killed, file, 'new-head', ranges);
  const deps = storedDeps({ before, after });
  await m.cli(['--compare-results', 'before', 'after', '--out', 'delta'], deps, new EventEmitter());
  const delta = JSON.parse(deps.writes[0][1]);
  assert.equal(delta.score, 100);
  assert.equal(delta.counts.survived, -1);
  assert.equal(delta.removed.length, 1);
  after.file = 'packages/web/src/other.ts';
  await assert.rejects(m.cli(['--compare-results', 'before', 'after'], deps, new EventEmitter()), /same result version and file/);
  before.scoringEvidence.report.files[file].mutants[0].status = 'Unmeasured';
  await assert.rejects(m.cli(['--rescore', 'before'], deps, new EventEmitter()), /scoring evidence/);
});
