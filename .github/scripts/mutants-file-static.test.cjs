'use strict';
// hearsay-tools/cezarion#2363: the own-package pass runs with ignoreStatic off, so a static row
// (code that runs at import) is measured and counts like any other row of its kind.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measure, summary, compareResults } = require('./mutants-file.cjs');

const file = 'packages/cezar/src/task-cli/cli.ts';
const source = 'const COMMON = { help: true };';
const location = { start: { line: 1, column: 16 }, end: { line: 1, column: 30 } };
const inGuard = { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } };
// Ranges use 0-based lines; mutant locations use 1-based lines and columns.
const guardRanges = [{ name: 'guard', range: { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } } }];
const guardTarget = { [file]: { tier: 'logic', guards: ['guard'] } };
const wire = (overrides = {}) => ({ id: '0', mutatorName: 'ObjectLiteral', replacement: '{}', location, status: 'Survived', static: true, coveredBy: ['333'], ...overrides });
const report = (mutants, text = source) => ({ files: { [file]: { source: text, mutants } } });
const run = (mutants, ranges = [], targets = {}) => measure(report(mutants, `${source}\ntrue`), file, 'head', ranges, targets);

test('a static survivor at module scope counts against the score and is listed', () => {
  const result = run([wire()]);
  assert.equal(result.version, 2);
  assert.equal(result.mutants[0].original, '{ help: true }');
  assert.equal(result.mutants[0].status, 'Survived');
  assert.equal(result.mutants[0].static, true);
  assert.equal(result.mutants[0].reportedStatus, undefined);
  assert.equal(result.moduleLevelCount, 1);
  assert.deepEqual(result.counts, { killed: 0, timeout: 0, survived: 1, noCoverage: 0, error: 0, ignored: 0 });
  assert.equal(result.score, 0);
  assert.equal(result.survivors.length, 1);
  assert.equal(result.rawScore, 0);
  assert.match(summary(result), /Static mutants at module scope: 1; measured with import-time activation and counted\./);
  assert.match(summary(result), /Survivors in \(module\):\n {2}L1 Value \/ ObjectLiteral: \{ help: true \} -> \{\}/);
});

test('a static kill raises the counted score like a runtime kill', () => {
  const result = run([wire({ status: 'Killed' }), wire({ id: '1', static: false })]);
  assert.equal(result.score, 50);
  assert.equal(result.counts.killed, 1);
  assert.equal(result.counts.ignored, 0);
  assert.deepEqual(result.survivors.map(m => m.static), [undefined]);
});

test('every static status counts by its own status, and guard survivors fail the guard', () => {
  const statuses = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'];
  const result = run(statuses.map((status, i) => wire({ id: String(i), status, location: inGuard })), guardRanges, guardTarget);
  assert.deepEqual(result.counts, { killed: 1, timeout: 1, survived: 1, noCoverage: 1, error: 2, ignored: 1 });
  assert.equal(result.score, 50);
  assert.deepEqual(result.staticFunctions, [{ name: 'guard', count: statuses.length }]);
  assert.deepEqual(result.guards[0].survivors.map(m => m.status), ['Survived', 'NoCoverage']);
  assert.equal(result.guards[0].staticCount, statuses.length);
  assert.equal(result.guards[0].pass, false);
  assert.ok(result.targets.some(t => t.name === 'covered lines' && !t.pass));
  const text = summary(result);
  assert.match(text, /Guard guard: 2 undetected, 7 static/);
  assert.match(text, /Guards with static mutants: guard/);
  assert.match(text, /Static mutants inside functions: 7; counted: guard \(7\)\./);
  assert.match(text, /FAIL: guard/);
});

test('static prose follows the Text rule: excluded outside guards, counted inside them', () => {
  const text = `${source}\n'Show help; needs no cockpit.'`;
  const prose = wire({ mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 31 } } });
  const outside = measure(report([prose], text), file, 'head', [], {});
  assert.equal(outside.mutants[0].original, "'Show help; needs no cockpit.'");
  assert.equal(outside.mutants[0].kind, 'Text');
  assert.equal(outside.counts.survived, 0);
  const inside = measure(report([prose], text), file, 'head', guardRanges, guardTarget);
  assert.equal(inside.mutants[0].kind, 'Text');
  assert.equal(inside.counts.survived, 1);
  assert.equal(inside.guards[0].pass, false);
});

test('an equivalent entry still removes a static row, and function counts keep it', () => {
  const ranges = [...guardRanges, { name: 'helper', range: { start: { line: 3, column: 0 }, end: { line: 4, column: 0 } } }];
  const mutants = [wire({ location: inGuard }), wire({ id: '1', location: { start: { line: 4, column: 1 }, end: { line: 4, column: 5 } } })];
  const entry = { file, function: 'guard', mutator: 'ObjectLiteral', original: 'true', replacement: '{}' };
  const result = measure(report(mutants, `${source}\ntrue\n\ntrue`), file, 'head', ranges, guardTarget, [entry]);
  assert.equal(result.equivalentCount, 1);
  assert.deepEqual(result.staticFunctions, [{ name: 'guard', count: 1 }, { name: 'helper', count: 1 }]);
  assert.equal(result.guards[0].staticCount, 1);
  assert.equal(result.guards[0].pass, true);
  assert.equal(result.counts.survived, 1);
  assert.match(summary(result), /Static mutants inside functions: 2; counted: guard \(1\), helper \(1\)/);
});

test('static outcomes are grouped per file and per function beside the counted score', () => {
  const statuses = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'Ignored', 'CompileError', 'RuntimeError'];
  const moduleRows = statuses.map((status, id) => wire({ id: String(id), status }));
  const functionRows = statuses.map((status, id) => wire({ id: String(id + 7), status, location: inGuard }));
  const ranges = [{ name: 'freshImport', range: guardRanges[0].range }];
  const result = run([...moduleRows, ...functionRows, wire({ static: false, status: 'Killed' })], ranges);
  const counts = { killed: 1, timeout: 1, survived: 1, noCoverage: 1, error: 2, ignored: 1 };
  assert.deepEqual(result.staticByFunction, [{ name: '(module)', counts }, { name: 'freshImport', counts }]);
  assert.deepEqual(result.staticCounts, { killed: 2, timeout: 2, survived: 2, noCoverage: 2, error: 4, ignored: 2 });
  assert.deepEqual(result.counts, { killed: 3, timeout: 2, survived: 2, noCoverage: 2, error: 4, ignored: 2 });
  const text = summary(result);
  assert.match(text, /Counted score: 55.6%\nStatic outcomes \(counted\): .*"killed":2.*"survived":2.*"noCoverage":2/);
  assert.match(text, /Static outcomes in \(module\) \(counted\): .*"killed":1.*"survived":1.*"noCoverage":1/);
  assert.match(text, /Static outcomes in freshImport \(counted\): .*"killed":1.*"survived":1.*"noCoverage":1/);
});

test('module location alone never marks a row static', () => {
  const result = run([wire({ static: false }), wire({ static: undefined })]);
  assert.equal(result.moduleLevelCount, 0);
  assert.deepEqual(result.staticByFunction, []);
  assert.deepEqual(result.staticCounts, { killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0, ignored: 0 });
  assert.match(summary(result), /Static mutants at module scope: 0;/);
  assert.match(summary(result), /Static outcomes \(counted\): .*"killed":0.*"survived":0/);
  assert.throws(() => run([wire({ status: 'NewUnknownStatus' })]), /Unknown mutant status/);
});

test('a version 1 result, which left static rows out, cannot be compared with a version 2 result', () => {
  const result = run([wire()]);
  assert.throws(() => compareResults({ ...result, version: 1 }, result), /same result version/);
  assert.equal(compareResults(result, result).score, 0);
});
