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

const infraWorkflows = [
  '.github/workflows/report-workflow-failure.yml',
  '.github/workflows/sweep-ci-failures.yml',
  '.github/workflows/upstream-scan.yml',
  '.github/workflows/npm-preview-cleanup.yml',
  '.github/workflows/publish-pr-snapshot.yml',
  '.github/workflows/issue-intake.yml',
];

const infraScripts = [
  '.github/scripts/ci-sweep-api.cjs',
  '.github/scripts/ci-sweep-collect.cjs',
  '.github/scripts/ci-sweep-patterns.cjs',
  '.github/scripts/ci-sweep-report.cjs',
  '.github/scripts/apply-issue-intake.cjs',
];

test('classifies every allowlisted path group as docs-only', () => {
  assert.equal(classifyPaths(['README.md', 'CHANGELOG.md', 'notes.md']), 'docs-only');
  assert.equal(classifyPaths(['docs/guide.md', 'docs/assets/diagram.svg']), 'docs-only');
  assert.equal(classifyPaths(['.ai/specs/2026-09-16.md', '.ai/specs/schema.yaml']), 'docs-only');
  assert.equal(classifyPaths(['.ai/analysis/notes.md', '.ai/analysis/data.json']), 'docs-only');
  for (const document of rootProcessDocuments) {
    assert.equal(classifyPaths([document]), 'docs-only');
  }
  for (const license of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-THIRD-PARTY', 'LICENSE.custom']) {
    assert.equal(classifyPaths([license]), 'docs-only');
  }
});

test('generated upstream ledger files skip the matrix without allowing arbitrary upstream code', () => {
  const files = ['.ai/upstream/ledger.yaml', '.ai/upstream/LEDGER.md', '.ai/upstream/scans/2026-09-25.md'];
  assert.equal(classifyPaths(files), 'docs-only');
  for (const file of files) assert.equal(classifyPaths([file]), 'docs-only', file);
  // reportPath preserves prior same-day reports with suffixes starting at 2.
  for (const suffix of ['2', '3', '10', '20']) {
    assert.equal(classifyPaths([...files, `.ai/upstream/scans/2026-09-25-${suffix}.md`]), 'docs-only');
  }
  for (const unsafe of [
    '.ai/upstream/run.cjs', '.ai/upstream/ledger.yml', '.ai/upstream/scans/run.js',
    '.ai/upstream/scans/nested/2026-09-25.md', '.ai/upstream/scans/notes.md',
    '.ai/upstream/scans/2026-09-25-1.md', '.ai/upstream/scans/2026-09-25-02.md',
    '.ai/upstream/scans/2026-09-25-0.md', '.ai/upstream/scans/2026-09-25-extra.md',
    '.ai/upstream/scans/../ledger.yaml', '.ai/upstream/scans/2026-09-25.md/extra',
    '.github/scripts/upstream-scan.cjs', '.github/scripts/upstream-ledger.cjs',
    'packages/cezar/src/index.ts', '.github/workflows/ci.yml',
  ]) assert.equal(classifyPaths([...files, unsafe]), 'full-matrix', unsafe);
});

test('classifies every infra allowlisted path as infra-only', () => {
  for (const workflow of infraWorkflows) {
    assert.equal(classifyPaths([workflow]), 'infra-only', workflow);
  }
  for (const script of infraScripts) {
    assert.equal(classifyPaths([script]), 'infra-only', script);
    assert.equal(classifyPaths([`${script.replace(/\.cjs$/, '')}.test.cjs`]), 'infra-only', script);
  }
  // Release verification (#467's runner-label edit) and the nightly build run
  // `npm test` themselves, so they stay full-matrix — issue #468 constraint #5.
  assert.equal(classifyPaths(['.github/workflows/release.yml']), 'full-matrix');
  assert.equal(classifyPaths(['.github/workflows/nightly.yml']), 'full-matrix');
});

test('classifies infra harness and unnamed github paths as full-matrix', () => {
  for (const harness of [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/nightly.yml',
    '.github/workflows/automated-code-review.yml',
    '.github/workflows/recover-automated-review.yml',
    '.github/workflows/ci-benchmark.yml',
    '.github/scripts/change-surface.cjs',
    '.github/scripts/change-surface.test.cjs',
    '.github/scripts/require-e2e-passed.cjs',
    '.github/scripts/ci-test-sequencer.mjs',
    '.github/scripts/automated-review.cjs',
    '.github/scripts/release-bump-pr.cjs',
    '.github/scripts/ci.workflow.test.cjs',
    '.github/workflows/some-new-ops-workflow.yml',
    '.github/scripts/ci-sweep-collect.mjs',
    '.github/scripts/ci-sweep-extra.cjs',
    '.github/dependabot.yml',
    '.github/CODEOWNERS',
  ]) {
    assert.equal(classifyPaths([harness]), 'full-matrix', harness);
  }
});

test('classifies mixed surfaces as full-matrix', () => {
  assert.equal(classifyPaths(['.github/workflows/release.yml', 'packages/cezar/src/index.ts']), 'full-matrix');
  assert.equal(classifyPaths(['.github/workflows/release.yml', 'README.md']), 'full-matrix');
  assert.equal(classifyPaths(['README.md', '.github/workflows/release.yml']), 'full-matrix');
  assert.equal(classifyPaths(['.github/workflows/release.yml', '.github/workflows/ci.yml']), 'full-matrix');
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
  assert.equal(classifyJsonLines('".github/workflows/sweep-ci-failures.yml"\n'), 'infra-only');
  assert.equal(classifyJsonLines('".github/workflows/sweep-ci-failures.yml"\n".github/scripts/ci-sweep-api.cjs"\n'), 'infra-only');
  assert.equal(classifyJsonLines('".github/workflows/release.yml"\n'), 'full-matrix');
  assert.equal(classifyJsonLines('".github/workflows/release.yml"\n"README.md"\n'), 'full-matrix');
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
  assert.match(result.stdout, /^(docs-only|infra-only|full-matrix)\n$/);
  assert.equal(result.stderr, '');
});

test('CLI fails closed and exits cleanly for malformed or blank stdin', () => {
  for (const input of ['not json\n', '']) {
    const result = spawnSync(process.execPath, ['./change-surface.cjs'], {
      cwd: __dirname,
      input,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, 'full-matrix\n', JSON.stringify(input));
    assert.equal(result.stderr, '', JSON.stringify(input));
  }
});
