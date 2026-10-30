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

