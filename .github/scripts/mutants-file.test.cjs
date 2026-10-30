'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('./mutants-file.cjs');
const root = path.resolve(__dirname, '../..');
const mutant = (overrides = {}) => ({ status: 'Survived', mutator: 'StringLiteral', original: "'hello'", replacement: "''", function: 'guard', kind: 'Value', ...overrides });

function checkKind(mutator, original, replacement, expected, file = 'x.ts', status = 'Survived') {
  assert.equal(m.kindOf(mutant({ mutator, original, replacement, status }), file), expected);
}

test('kind precedence and every mutator family, including unlisted Value mutators', () => {
  checkKind('StringLiteral', 'flex gap-2', '', 'Not covered', 'x.tsx', 'NoCoverage');
  checkKind('StringLiteral', "'flex gap-2 md:hover:bg-red-500'", '', 'Class name', 'x.tsx');
  checkKind('StringLiteral', 'flex gap-2', '', 'Text');
  checkKind('StringLiteral', "'Delete this branch'", '', 'Text', 'x.tsx');
  checkKind('StringLiteral', 'token', '', 'Value');
  checkKind('EqualityOperator', 'a < b', 'a >= b', 'Boundary');
  checkKind('EqualityOperator', 'a === b', 'a !== b', 'Condition');
  checkKind('OptionalChaining', 'a?.b', 'a.b', 'Fallback');
  checkKind('LogicalOperator', 'a ?? b', 'a && b', 'Fallback');
  for (const name of ['ConditionalExpression', 'LogicalOperator', 'BooleanLiteral']) checkKind(name, 'x', 'y', 'Condition');
  for (const name of ['BlockStatement', 'CallExpression', 'ArrowFunction', 'MethodExpression']) checkKind(name, 'x', '', 'Removed call');
  for (const name of ['ObjectLiteral', 'ArrayDeclaration', 'Regex', 'UnaryOperator', 'UpdateOperator', 'AssignmentOperator', 'ArithmeticOperator']) checkKind(name, 'x', 'y', 'Value');
});

test('ast-grep assigns nested names, methods, anonymous callbacks, and module code', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-functions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.ts');
  const source = [
    'const moduleValue = 1;',
    'function outer() {',
    '  const nested = () => 2;',
    '  [1].map(() => 3);',
    '}',
    'class Example {',
    '  async method() { return 4; }',
    '}',
    'const expression = function () { return 5; };',
    'const arrow = () => 6;',
  ].join('\n');
  fs.writeFileSync(file, source);
  const ranges = m.functionRanges(file, root);
  const at = line => m.functionOf({ start: { line, column: 20 } }, ranges);
  assert.equal(at(1), '(module)');
  assert.equal(at(2), 'outer');
  assert.equal(at(3), 'nested');
  assert.equal(at(4), 'outer');
  assert.equal(at(7), 'Example.method');
  assert.equal(at(9), 'expression');
  assert.equal(at(10), 'arrow');
});

test('targets have the 33 baseline paths, derived tiers, and eight guard groups', () => {
  const targets = require('../mutants/targets.json');
  assert.equal(Object.keys(targets).length, 33);
  for (const [file, target] of Object.entries(targets)) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
    assert.equal(target.tier, file.startsWith('packages/web/') && file.endsWith('.tsx') ? 'component' : 'logic');
  }
  assert.equal(Object.values(targets).filter(t => t.guards.length).length, 8);
  assert.deepEqual(m.tierOf('packages/web/src/new.tsx', {}), { tier: 'component', guards: [] });
  assert.deepEqual(m.tierOf('packages/contract/src/new.ts', {}), { tier: 'logic', guards: [] });
});

test('scores exclude errors and ignored rows; timeout detects; empty counts score 100', () => {
  const counts = m.countsOf(['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'].map(status => mutant({ status })));
  assert.deepEqual(counts, { killed: 1, timeout: 1, survived: 1, noCoverage: 1, error: 2, ignored: 1 });
  assert.equal(m.scoreOf(counts), 50);
  assert.equal(m.scoreOf(m.countsOf([])), 100);
  assert.throws(() => m.countsOf([mutant({ status: 'unknown' })]), /Unknown/);
});

test('target evaluation counts guard text, omits classes, and fails missing guards', () => {
  const rows = [mutant({ status: 'Killed' }), mutant({ kind: 'Text', function: 'other' }), mutant({ kind: 'Class name' }), mutant({ kind: 'Text' })];
  const result = m.evaluate(rows, { tier: 'logic', guards: ['guard', 'missing'] }, [{ name: 'guard' }]);
  assert.equal(result.score, 50);
  assert.equal(result.rawScore, 25);
  assert.equal(result.survivors.length, 1);
  assert.equal(result.guards[0].survivors.length, 1);
  assert.equal(result.guards[1].found, false);
  assert.deepEqual(result.targets.map(t => t.pass), [false, true, false, false]);
});

test('logic needs covered lines and 85 percent; components need 75 percent', () => {
  const rows = Array.from({ length: 3 }, () => mutant({ status: 'Killed' })).concat(mutant({ status: 'NoCoverage', kind: 'Not covered' }));
  assert.deepEqual(m.evaluate(rows, { tier: 'logic', guards: [] }, []).targets.map(t => t.pass), [false, false]);
  assert.equal(m.evaluate(rows, { tier: 'component', guards: [] }, []).targets[0].pass, true);
  const eightyFive = Array.from({ length: 20 }, (_, i) => mutant({ status: i < 17 ? 'Killed' : 'Survived' }));
  assert.equal(m.evaluate(eightyFive, { tier: 'logic', guards: [] }, []).targets[0].pass, true);
});

test('comparison ignores line movement and whitespace, reports changed survivors and counts', () => {
  const before = { version: 1, file: 'x.ts', ...m.evaluate([mutant({ original: 'a  b', line: 1 }), mutant({ original: 'removed' })], { tier: 'logic', guards: [] }, []) };
  const after = { version: 1, file: 'x.ts', ...m.evaluate([mutant({ original: 'a b', line: 20 }), mutant({ original: 'added' }), mutant({ status: 'Killed' })], { tier: 'logic', guards: [] }, []) };
  const delta = m.compareResults(before, after);
  assert.equal(delta.added[0].original, 'added');
  assert.equal(delta.removed[0].original, 'removed');
  assert.equal(delta.counts.killed, 1);
  assert.ok(delta.score > 33);
  assert.throws(() => m.compareResults(before, { ...after, file: 'y.ts' }), /same/);
});
