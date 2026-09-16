const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { classifyJsonLines, classifyPaths } = require('./change-surface.cjs');

const rootProcessDocuments = [
  'AGENT_PROTOCOL.md',
  'AGENTS.md',
  'BACKWARD_COMPATIBILITY.md',
  'CODE_REVIEW.md',
  'SDLC.md',
];

test('classifies every allowlisted path group as docs-only', () => {
  assert.equal(classifyPaths(['README.md', 'CHANGELOG.md', 'notes.md']), 'docs-only');
  assert.equal(classifyPaths(['docs/guide.md']), 'docs-only');
  assert.equal(classifyPaths(['.ai/specs/2026-09-16.md']), 'docs-only');
  assert.equal(classifyPaths(['.ai/analysis/notes.md']), 'docs-only');
  for (const document of rootProcessDocuments) {
    assert.equal(classifyPaths([document]), 'docs-only');
  }
  for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-THIRD-PARTY', 'LICENSE.custom']) {
    assert.equal(classifyPaths([license]), 'docs-only');
  }
});

test('classifies mixed documentation and code as full-matrix', () => {
  assert.equal(classifyPaths(['README.md', 'packages/cezar/src/index.ts']), 'full-matrix');
  assert.equal(classifyPaths(['docs/guide.md', '.github/workflows/ci.yml']), 'full-matrix');
});

test('fails closed for invalid path collections', () => {
  for (const paths of [
    [],
    undefined,
    null,
    {},
    'README.md',
    ['README.md', 42],
    ['README.md', null],
    ['/README.md'],
    ['C:/README.md'],
    ['docs\\guide.md'],
    ['docs/guide.md\0'],
    ['docs/../README.md'],
    ['docs//guide.md'],
    ['docs/'],
    ['.ai/specs/'],
    ['.github/README.md'],
    ['package.json'],
    ['README.MD'],
  ]) {
    assert.equal(classifyPaths(paths), 'full-matrix', JSON.stringify(paths));
  }
});

test('classifies valid JSON-lines input and tolerates one final newline', () => {
  assert.equal(classifyJsonLines('"README.md"'), 'docs-only');
  assert.equal(classifyJsonLines('"README.md"\n'), 'docs-only');
  assert.equal(classifyJsonLines('"README.md"\n"docs/guide.md"\n'), 'docs-only');
  assert.equal(classifyJsonLines('"README.md"\n"package.json"\n'), 'full-matrix');
});

test('fails closed for malformed, blank, and invalid JSON-lines input', () => {
  for (const input of [
    '',
    '\n',
    '   \n',
    '["README.md"]\n\n',
    '["README.md"] trailing',
    '["README.md"',
    'not json',
    '{}',
    'null',
    '["README.md"]',
    '[]',
    '["README.md", 1]',
    '["README.md"]\n["docs/../guide.md"]',
    '"README.md\\n"',
  ]) {
    assert.equal(classifyJsonLines(input), 'full-matrix', JSON.stringify(input));
  }
});

test('CLI emits exactly one supported classification line', () => {
  const result = spawnSync(process.execPath, ['./change-surface.cjs'], {
    cwd: __dirname,
    input: '"README.md"\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^(docs-only|full-matrix)\n$/);
  assert.equal(result.stderr, '');
});
