const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { classifyJsonLines, classifyPaths, isDocsPath, testReadDocuments, usage } = require('./change-surface.cjs');
const docsPathCases = require('./fixtures/docs-path-cases.cjs');

const rootProcessDocuments = [
  'AGENTS.md',
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
  '.github/scripts/issue-intake-candidates.cjs',
  '.github/scripts/jev-issue-intake.cjs',
  '.github/scripts/jev-intake-replay.cjs',
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

test('Markdown under packages/ is docs-only unless it sits in a fixture directory', () => {
  assert.equal(classifyPaths(['packages/web/e2e/README.md']), 'docs-only');
  assert.equal(classifyPaths(['packages/api-client/README.md']), 'docs-only');
  assert.equal(classifyPaths(['packages/web/e2e/README.md', 'README.md', 'docs/guide.md']), 'docs-only');
  for (const fixture of [
    'packages/cezar/src/core/__fixtures__/omp/README.md',
    'packages/web/e2e/fixtures/README.md',
    'packages/cezar/src/__snapshots__/notes.md',
  ]) assert.equal(classifyPaths([fixture]), 'full-matrix', fixture);
  for (const notDocs of ['packages/web/e2e/README.MD', 'packages/web/e2e/smoke.e2e.ts']) {
    assert.equal(classifyPaths([notDocs]), 'full-matrix', notDocs);
  }
  assert.equal(classifyPaths(['packages/web/e2e/README.md', 'packages/web/e2e/smoke.e2e.ts']), 'full-matrix');
});

test('Markdown a test reads runs the full matrix', () => {
  // bc-route-inventory.test.ts reads BACKWARD_COMPATIBILITY.md, and
  // harness-parity.test.ts reads AGENT_PROTOCOL.md and the parity matrix spec,
  // so none of them can skip Vitest.
  assert.deepEqual([...testReadDocuments].sort(), [
    '.ai/specs/2026-09-04-harness-parity-matrix.md',
    'AGENT_PROTOCOL.md',
    'BACKWARD_COMPATIBILITY.md',
  ]);
  for (const document of testReadDocuments) {
    assert.equal(isDocsPath(document), false, document);
    assert.equal(classifyPaths([document]), 'full-matrix', document);
    assert.equal(classifyPaths(['README.md', document]), 'full-matrix', document);
  }
});

test('isDocsPath agrees with the shared docs verdict list', () => {
  for (const { path, docs } of docsPathCases) {
    assert.equal(isDocsPath(path), docs, path);
    assert.equal(classifyPaths([path]), docs ? 'docs-only' : 'full-matrix', path);
  }
});

test('isDocsPath fails closed for unsafe paths', () => {
  for (const unsafe of [
    undefined, null, 42, '', '/README.md', 'docs\\guide.md', 'docs/guide.md\0',
    'docs/../README.md', 'docs//guide.md', 'packages/web/e2e/../README.md',
    'packages//web/README.md', 'packages/web/e2e/',
  ]) assert.equal(isDocsPath(unsafe), false, JSON.stringify(unsafe));
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
    '.github/scripts/change-surface-readers.test.cjs',
    '.github/scripts/fixtures/docs-path-cases.cjs',
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

// Empty input still means no paths. Malformed input now explains the input
// contract on stderr, while retaining the fail-closed stdout and exit status.
test('CLI fails closed and stays silent when stdin has no paths', () => {
  for (const input of ['', '\n']) {
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

test('CLI prints usage once for malformed or non-string JSON lines', () => {
  for (const input of [
    'AGENTS.md\n', 'not json\n', '{\n', 'null\n', '42\n',
    '{}\n', '["README.md"]\n', '"README.md"\nnot json\n',
    'not json\nnot json\n', '\n\n', '"README.md"\n\n', '   \n',
  ]) {
    const result = spawnSync(process.execPath, ['./change-surface.cjs'], {
      cwd: __dirname, input, encoding: 'utf8',
    });
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, 'full-matrix\n', JSON.stringify(input));
    assert.equal(result.stderr, usage, JSON.stringify(input));
  }
});

test('CLI keeps valid JSON string classifications silent', () => {
  for (const [input, surface] of [
    ['"AGENTS.md"\n', 'docs-only'],
    ['".github/workflows/sweep-ci-failures.yml"\n', 'infra-only'],
    ['"package.json"\n', 'full-matrix'],
    ['"docs/../README.md"\n', 'full-matrix'],
    ['""\n', 'full-matrix'],
  ]) {
    const result = spawnSync(process.execPath, ['./change-surface.cjs'], {
      cwd: __dirname, input, encoding: 'utf8',
    });
    assert.equal(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, `${surface}\n`, JSON.stringify(input));
    assert.equal(result.stderr, '', JSON.stringify(input));
  }
});

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

// Run by hand with no pipe, the CLI would wait for terminal input that never
// comes (hearsay-tools/cezarion#1640). util-linux script(1) gives the child a
// pseudo-terminal on stdin; other platforms ship a script(1) with other flags.
test('CLI prints usage and exits 2 when stdin is a terminal', {
  skip: process.platform !== 'linux' && 'needs util-linux script(1)',
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-surface-tty-'));
  try {
    const stderrFile = path.join(dir, 'stderr');
    const command = `${shellQuote(process.execPath)} ./change-surface.cjs 2>${shellQuote(stderrFile)}`;
    // script(1) sends EOF to the terminal when its own stdin ends, so stdin
    // stays an open pipe: a CLI that reads the terminal hangs instead.
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    let timedOut = false;
    // bound: hang guard only; the CLI exits before it reads stdin.
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    }).finally(() => clearTimeout(guard));

    assert.equal(timedOut, false, 'the CLI waited for input on the terminal');
    assert.equal(status, 2);
    assert.equal(stdout, '');
    assert.equal(fs.readFileSync(stderrFile, 'utf8'), usage);
    assert.match(usage, /one JSON string per line/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
