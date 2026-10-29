// Tripwire for the docs rule (hearsay-tools/cezarion#1099,
// hearsay-tools/cezarion#2166). change-surface.cjs lets a docs-only change skip
// Vitest and cockpit browser E2E because no test reads those paths. This file
// fails when package code starts reading such a path, so a new reader cannot
// hide behind the docs-only skip. node:test entry files need no scan: the
// unconditional build-and-package job runs every one of them, so a check on a
// docs-only file belongs there (packages/cezar/test/unit/message-docs.test.ts).
//
// It is a text scan, not a parser. It counts a path token that names a tracked
// docs-only file, resolved from the naming file's directory or one of its
// ancestors (`e2e/fixture-server.md` from packages/web/src/test/), when a read
// call stands within READ_WINDOW_LINES lines of it. It misses a path assembled
// from separate segments, such as join(root, 'packages', 'contract',
// 'README.md'), a path built at runtime, a path held further from its read,
// and a token on a line the comment filter skips (`//`, `/*`, `*`). The last
// test pins that the scan still finds every reader testReadDocuments lists.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { isDocsPath, testReadDocuments } = require('./change-surface.cjs');

const repoRoot = path.join(__dirname, '..', '..');

// Package files that name a docs-only file near a read call without reading
// it, as the `naming file -> docs path` pairs the scan below finds.
const TEMP_NOTES = 'reads notes.md in a temporary repo or skill fixture, never this one';
const mentionedOnly = [
  { file: 'packages/cezar/src/runs/store-database.test.ts', markdown: 'docs/run-history-recovery.md', reason: 'asserts that a warning names the doc' },
  { file: 'packages/cezar/src/server/checkout.test.ts', markdown: 'README.md', reason: 'reads README.md in a temporary checkout, never this one' },
  { file: 'packages/cezar/src/skills-remote.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/workflows/run.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/workflows/system-prompt.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/workflows/team-skill-materialize.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
];

// A call that reads a file's content. A token this many lines away still
// counts, so a path listed just above its read is found (harness-parity).
const READ_CALL = /\b(?:readFile|readFileSync|createReadStream)\b|new URL\(/;
const READ_WINDOW_LINES = 5;

// The node:test entry files under packages/, from the test:unit and
// test:package scripts in packages/cezar/package.json. The scan skips them;
// the helpers they import are still scanned.
const NODE_TEST_GLOBS = ['test/unit/*.test.ts', 'test/e2e/*.test.ts'];
const nodeTestEntry = /^packages\/cezar\/test\/(?:unit|e2e)\/[^/]+\.test\.ts$/;

function trackedFiles(...pathspecs) {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

// Each line with comment lines blanked and a trailing ` //` comment removed.
function codeLines(source) {
  return source.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return '';
    return line.replace(/ \/\/.*$/, '');
  });
}

// Path tokens on lines within READ_WINDOW_LINES of a read call.
function readPathTokens(source) {
  const lines = codeLines(source);
  const tokens = [];
  lines.forEach((line, index) => {
    const window = lines.slice(Math.max(0, index - READ_WINDOW_LINES), index + READ_WINDOW_LINES + 1);
    if (!window.some((nearby) => READ_CALL.test(nearby))) return;
    tokens.push(...line.match(/[\w.@/-]+\.\w+(?![\w/])/g) ?? []);
  });
  return tokens;
}

// Every (naming file, path) pair where a tracked code file under packages/
// names one of `paths` near a read call. A token resolves against the naming
// file's directory and each ancestor, so `e2e/fixture-server.md` named from
// packages/web/src/test/ still counts.
function pathsReadByPackageCode(paths) {
  const hits = new Set();
  for (const file of trackedFiles('packages')) {
    if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(file) || nodeTestEntry.test(file)) continue;
    const absolute = path.join(repoRoot, file);
    if (!fs.existsSync(absolute)) continue;
    const directories = [];
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      directories.push(dir);
      if (dir === '.') break;
    }
    for (const token of readPathTokens(fs.readFileSync(absolute, 'utf8'))) {
      for (const dir of directories) {
        const candidate = path.posix.normalize(path.posix.join(dir, token));
        if (paths.has(candidate)) hits.add(`${file} -> ${candidate}`);
      }
    }
  }
  return [...hits].sort();
}

// A repository-local approximation of Squeal's glob compiler, covering `**`,
// `*` and `{a,b}` only. Other syntax throws rather than being escaped, so a
// config glob that uses it fails here instead of matching the wrong files.
function globToRegExp(glob) {
  if (/[?[\]]/.test(glob) || glob.startsWith('!')) {
    throw new Error(`globToRegExp does not implement the syntax in ${JSON.stringify(glob)}; extend globToRegExp before relying on it`);
  }
  const convert = (pattern) => {
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
      if (pattern.startsWith('**/', i)) { source += '(?:[^/]+/)*'; i += 2; }
      else if (pattern.startsWith('**', i)) { source += '.*'; i += 1; }
      else if (pattern[i] === '*') source += '[^/]*';
      else if (pattern[i] === '{') {
        const end = pattern.indexOf('}', i);
        source += `(?:${pattern.slice(i + 1, end).split(',').map(convert).join('|')})`;
        i = end;
      } else source += pattern[i].replace(/[.+?^$()|[\]\\]/g, '\\$&');
    }
    return source;
  };
  return new RegExp(`^${convert(glob)}$`);
}

test('package code reads no docs-only file', () => {
  const listed = new Set(mentionedOnly.map(({ file, markdown }) => `${file} -> ${markdown}`));
  const hits = pathsReadByPackageCode(new Set(trackedFiles().filter(isDocsPath)));
  const unlisted = hits.filter((hit) => !listed.has(hit));
  assert.deepEqual(unlisted, [], [
    'Package code reads a file that the docs-only change surface lets skip every test:',
    ...unlisted.map((hit) => `  ${hit}`),
    'If the check needs only the file\'s text, move it to a node:test file in packages/cezar/test/unit/,',
    'which runs on docs-only changes too. If a Vitest test or cockpit browser spec must read the file,',
    'add it to testReadDocuments in .github/scripts/change-surface.cjs. If the code only names it,',
    'add the pair to mentionedOnly in .github/scripts/change-surface-readers.test.cjs with a one-line reason.',
  ].join('\n'));
  const stale = [...listed].filter((entry) => !hits.includes(entry));
  assert.deepEqual(stale, [], `mentionedOnly lists pairs the scan no longer finds; remove them:\n  ${stale.join('\n  ')}`);
  for (const { reason } of mentionedOnly) assert.ok(reason?.trim(), 'every mentionedOnly entry needs a reason');
});

test('the scan finds a reader for every test-read document', () => {
  const hits = pathsReadByPackageCode(new Set(testReadDocuments));
  for (const document of testReadDocuments) {
    assert.ok(hits.some((hit) => hit.endsWith(` -> ${document}`)),
      `testReadDocuments lists ${document}, but the scan finds no package code that reads it`);
  }
});

test('the skipped node:test entries match the package node:test scripts', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/cezar/package.json'), 'utf8'));
  const globs = [scripts['test:unit'], scripts['test:package']].map((script) => script.split(' ').at(-1));
  assert.deepEqual(globs, NODE_TEST_GLOBS);
  assert.ok(nodeTestEntry.test('packages/cezar/test/unit/message-docs.test.ts'));
  assert.ok(!nodeTestEntry.test('packages/cezar/test/unit/test-env-lease-churn.testkit.mjs'));
  assert.ok(!nodeTestEntry.test('packages/cezar/src/delegation/message-docs.test.ts'));
});

test('every test-read document is a tracked file', () => {
  const tracked = new Set(trackedFiles(...testReadDocuments));
  for (const document of testReadDocuments) {
    assert.ok(tracked.has(document), `testReadDocuments lists ${document}, which is not a tracked file`);
  }
});

test('local globToRegExp helper matches the Squeal glob forms it supports', () => {
  const pattern = globToRegExp('packages/web/e2e/**/*.{ts,mjs}');
  assert.ok(pattern.test('packages/web/e2e/smoke.e2e.ts'));
  assert.ok(pattern.test('packages/web/e2e/fixtures/preview-app.mjs'));
  assert.ok(!pattern.test('packages/web/e2e/README.md'));
  assert.ok(!pattern.test('packages/web/e2e/smoke.e2e.tsx'));
  assert.ok(globToRegExp('packages/web/e2e/fixtures/**').test('packages/web/e2e/fixtures/a/b.png'));
  assert.ok(!globToRegExp('packages/web/*.json').test('packages/web/e2e/x.json'));
  for (const unsupported of ['packages/web/e2e/?.ts', 'packages/web/e2e/[ab].ts', 'packages/web/e2e/a].ts', '!packages/web/e2e/**']) {
    assert.throws(() => globToRegExp(unsupported), /extend globToRegExp/, unsupported);
  }
});

test('Squeal browser-spec inputs cover exactly the non-docs files under packages/web/e2e/', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squeal.config.json'), 'utf8'));
  const inputs = config.inputs['packages/web/e2e/*.e2e.ts'].map(globToRegExp);
  const files = trackedFiles('packages/web/e2e');
  assert.ok(files.some(isDocsPath) && files.some((file) => !isDocsPath(file)), 'expected docs and non-docs files');
  const disagreements = files
    .filter((file) => inputs.some((input) => input.test(file)) === isDocsPath(file))
    .map((file) => `${file}: ${isDocsPath(file) ? 'docs-only, yet a browser-spec input' : 'not docs, yet no browser-spec input'}`);
  assert.deepEqual(disagreements, [], [
    'squeal.config.json inputs["packages/web/e2e/*.e2e.ts"] and isDocsPath disagree:',
    ...disagreements.map((line) => `  ${line}`),
  ].join('\n'));
});
