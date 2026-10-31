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
  assert.equal(result.counts.ignored, 1);
  assert.equal(result.score, 100);
  assert.equal(result.rawCounts.survived, 1);
  assert.equal(result.rawScore, 0);
  assert.deepEqual(result.survivors, []);
  assert.match(summary(result), /Module-level mutants .*: 1; not measured, excluded from counted score and guards/);
});

test('every static status is unmeasured, including static-only and import-called functions', () => {
  const statuses = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'];
  const mutants = statuses.map((status, i) => wire({ id: String(i), status, coveredBy: [] }));
  const ranges = [{ name: 'guard', range: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 } } }];
  const result = run(mutants, ranges, { [file]: { tier: 'logic', guards: ['guard'] } });
  assert.equal(result.moduleLevelCount, statuses.length);
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
  assert.match(summary(result), /Module-level mutants .*: 0;/);
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
