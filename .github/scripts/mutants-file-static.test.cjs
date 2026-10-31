'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measure, summary } = require('./mutants-file.cjs');

const file = 'packages/cezar/src/task-cli/cli.ts';
const source = 'const COMMON = { help: true };';
const location = { start: { line: 1, column: 16 }, end: { line: 1, column: 30 } };
const wire = (overrides = {}) => ({ id: '0', mutatorName: 'ObjectLiteral', replacement: '{}', location, status: 'Survived', static: true, coveredBy: ['333'], ...overrides });
const report = mutants => ({ files: { [file]: { source, mutants } } });
const run = (mutants, ranges = [], targets = {}) => measure(report(mutants), file, 'proof-head', ranges, targets);

test('hybrid COMMON survivor is not measured; raw Stryker result remains visible', () => {
  // hearsay-tools/cezarion#2357: static import plus a dynamic subcommand import.
  const result = run([wire()]);
  assert.equal(result.mutants[0].original, '{ help: true }');
  assert.equal(result.mutants[0].status, 'Ignored');
  assert.equal(result.mutants[0].reportedStatus, 'Survived');
  assert.equal(result.moduleLevelCount, 1);
  assert.deepEqual(result.staticFunctions, []);
  assert.match(summary(result), /Guards with static mutants not measured: none/);
  assert.equal(result.counts.ignored, 1);
  assert.equal(result.score, 100);
  assert.equal(result.rawCounts.survived, 1);
  assert.equal(result.rawScore, 0);
  assert.deepEqual(result.survivors, []);
  assert.match(summary(result), /Static mutants at module scope: 1; not measured, excluded from counted score/);
});

test('every static status is unmeasured, including static-only and import-called functions', () => {
  const statuses = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'];
  const mutants = statuses.map((status, i) => wire({ id: String(i), status, coveredBy: [] }));
  const ranges = [{ name: 'guard', range: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 } } }];
  const result = run(mutants, ranges, { [file]: { tier: 'logic', guards: ['guard'] } });
  assert.equal(result.moduleLevelCount, 0);
  assert.deepEqual(result.staticFunctions, [{ name: 'guard', count: statuses.length }]);
  assert.equal(result.guards[0].staticCount, statuses.length);
  assert.match(summary(result), /Guard guard: 0 undetected, 7 static not measured/);
  assert.match(summary(result), /Guards with static mutants not measured: guard/);
  assert.match(summary(result), /Static mutants inside functions: 7; not measured: guard \(7\)/);
  assert.equal(result.counts.ignored, statuses.length);
  assert.deepEqual(result.mutants.map(m => m.reportedStatus), statuses);
  assert.equal(result.guards[0].pass, true);
  assert.deepEqual(result.guards[0].survivors, []);
  assert.equal(result.rawCounts.error, 2);
  assert.equal(result.rawScore, 50);
});

test('module location alone never excludes runtime or legacy mutants without static coverage', () => {
  const result = run([wire({ static: false }), wire({ static: undefined }), wire({ static: false, status: 'NoCoverage' })]);
  assert.equal(result.moduleLevelCount, 0);
  assert.equal(result.score, 0);
  assert.equal(result.counts.survived, 2);
  assert.equal(result.counts.noCoverage, 1);
  assert.equal(result.survivors.length, 3);
  assert.ok(result.targets.some(t => t.name === 'covered lines' && !t.pass));
  assert.match(summary(result), /Static mutants at module scope: 0;/);
});

test('mixed results count runtime kills and survivors without counting static survivors', () => {
  const result = run([wire(), wire({ static: false, status: 'Killed' }), wire({ static: false })]);
  assert.equal(result.score, 50);
  assert.equal(result.rawScore, 100 / 3);
  assert.equal(result.survivors.length, 1);
  assert.equal(result.survivors[0].static, undefined);
  assert.equal(result.counts.ignored, 1);
  assert.throws(() => run([wire({ status: 'NewUnknownStatus' })]), /Unknown mutant status/);
});


test('static function counts distinguish named functions and survive equivalent exclusion', () => {
  const ranges = [
    { name: 'guard', range: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 } } },
    { name: 'helper', range: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 } } },
  ];
  const mutants = [wire(), wire({ id: '1', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } } })];
  const data = { files: { [file]: { source: `${source}\ntrue`, mutants } } };
  const entry = { file, function: 'guard', mutator: 'ObjectLiteral', original: '{ help: true }', replacement: '{}' };
  const result = measure(data, file, 'head', ranges, { [file]: { tier: 'logic', guards: ['guard'] } }, [entry]);
  assert.equal(result.equivalentCount, 1);
  assert.equal(result.moduleLevelCount, 0);
  assert.deepEqual(result.staticFunctions, [{ name: 'guard', count: 1 }, { name: 'helper', count: 1 }]);
  assert.equal(result.guards[0].staticCount, 1);
  assert.match(summary(result), /Static mutants inside functions: 2; not measured: guard \(1\), helper \(1\)/);
  assert.match(summary(result), /Guard guard: 0 undetected, 1 static not measured/);
});


test('static outcomes retain import-time kills, survivors and coverage gaps per file and function', () => {
  const statuses = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'Ignored', 'CompileError', 'RuntimeError'];
  const moduleRows = statuses.map((status, id) => wire({ id: String(id), status }));
  const functionRows = statuses.map((status, id) => wire({ id: String(id + 7), status, location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } } }));
  const ranges = [{ name: 'freshImport', range: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 } } }];
  const result = run([...moduleRows, ...functionRows, wire({ static: false, status: 'Killed' })], ranges);
  const counts = { killed: 1, timeout: 1, survived: 1, noCoverage: 1, error: 2, ignored: 1 };
  assert.deepEqual(result.staticByFunction, [{ name: '(module)', counts }, { name: 'freshImport', counts }]);
  assert.deepEqual(result.staticCounts, { killed: 2, timeout: 2, survived: 2, noCoverage: 2, error: 4, ignored: 2 });
  assert.equal(result.counts.killed, 1);
  assert.equal(result.counts.ignored, 14);
  const text = summary(result);
  assert.match(text, /Counted score: 100.0%\nStatic outcomes \(not measured\): .*"killed":2.*"survived":2.*"noCoverage":2/);
  assert.match(text, /Static outcomes in \(module\) \(not measured\): .*"killed":1.*"survived":1.*"noCoverage":1/);
  assert.match(text, /Static outcomes in freshImport \(not measured\): .*"killed":1.*"survived":1.*"noCoverage":1/);
});

test('no static coverage reports zero static outcomes with no function groups', () => {
  const result = run([wire({ static: false })]);
  assert.deepEqual(result.staticCounts, { killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0, ignored: 0 });
  assert.deepEqual(result.staticByFunction, []);
  assert.match(summary(result), /Static outcomes \(not measured\): .*"killed":0.*"survived":0.*"noCoverage":0/);
});
