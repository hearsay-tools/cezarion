const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EQUIVALENT_FILE, readEquivalent, matchesEntry, findEquivalent } = require('./mutants-equivalent.cjs');

const entry = { file: 'packages/contract/src/attention.ts', function: 'attention', mutator: 'BooleanLiteral', original: 'true', replacement: 'false', reason: 'same behavior' };

function fixture(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equivalent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'equivalent.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

test('the default path is relative to the checked-out repository', () => {
  assert.equal(EQUIVALENT_FILE, '.github/mutants/equivalent.json');
});

test('readEquivalent accepts entries, an empty list and a missing file', t => {
  assert.deepEqual(readEquivalent(fixture(t, JSON.stringify([entry]))), { entries: [entry], warning: '' });
  for (const contents of ['[]', undefined]) {
    assert.deepEqual(readEquivalent(fixture(t, contents)), { entries: [], warning: '' });
  }
});

test('readEquivalent warns without throwing on unreadable or malformed input', t => {
  for (const contents of ['{', '{}', '[null]', ...Object.keys(entry).map(key => JSON.stringify([{ ...entry, [key]: ' ' }])), JSON.stringify([{ ...entry, reason: 1 }])]) {
    const result = readEquivalent(fixture(t, contents));
    assert.deepEqual(result.entries, []);
    assert.ok(result.warning.length > 0);
    assert.doesNotMatch(result.warning, /[\r\n]/);
  }
  const result = readEquivalent('denied', { readFileSync() { throw Object.assign(new Error('permission\ndenied'), { code: 'EACCES' }); } });
  assert.deepEqual(result.entries, []);
  assert.match(result.warning, /permission denied/);
});

test('matching requires function identity and exact full source text', () => {
  const long = 'x'.repeat(250);
  const row = { ...entry, original: long };
  assert.equal(matchesEntry(row, { ...row }), true);
  const { function: ignored, ...withoutFunction } = row;
  assert.equal(matchesEntry(row, withoutFunction), false);
  for (const changed of [{ file: 'other' }, { mutator: 'StringLiteral' }, { function: 'other' }, { original: long + 'x' }, { replacement: 'true' }]) {
    assert.equal(matchesEntry(row, { ...row, ...changed }), false);
  }
  assert.equal(findEquivalent([row], row), row);
  assert.equal(findEquivalent([], row), undefined);
});

test('string, template, regex whitespace and source formatting remain exact', () => {
  for (const [original, different] of [["'a b'", "'a  b'"], ['"a b"', '"a  b"'], ['`a b`', '`a  b`'], ['/a b/', '/a  b/'], ['return\nvalue', 'return value'], ['{\n  return true;\n}', '{\n    return true;\n}']]) {
    assert.equal(matchesEntry({ ...entry, original }, { ...entry, original: different }), false);
    assert.equal(matchesEntry({ ...entry, replacement: original }, { ...entry, replacement: different }), false);
  }
});
