const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('./mutants-functions.cjs');
const root = path.resolve(__dirname, '../..');

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


test('duplicate method and nested function names stay stable and nested classes choose the nearest owner', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.ts');
  fs.writeFileSync(file, [
    'const a = { shared() { return true; } };',
    'const b = { shared() { return true; } };',
    'function outer() {',
    '  function shared() { return true; }',
    '}',
    'class Outer {',
    '  method() {',
    '    class Inner { method() { return true; } }',
    '  }',
    '}',
    'function unique() { return true; }',
  ].join('\n'));
  const ranges = m.functionRanges(file, root);
  assert.equal(ranges.filter(r => r.name === 'shared').length, 3);
  assert.deepEqual([...m.duplicateNames(ranges)], ['shared']);
  assert.equal(m.functionOf({ start: { line: 8, column: 35 } }, ranges), 'Inner.method');
  assert.equal(m.functionOf({ start: { line: 11, column: 30 } }, ranges), 'unique');
});
