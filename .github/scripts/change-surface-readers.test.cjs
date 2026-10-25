// Tripwire for the docs rule (hearsay-tools/cezarion#1099). change-surface.cjs
// lets Markdown under packages/ skip Vitest and cockpit browser E2E because no
// test reads it. This file fails when package code starts naming such a file
// by path, so a new reader cannot hide behind the docs-only skip.
//
// It is a text scan, not a parser. It catches a path token that names the
// file, resolved from the naming file's directory or one of its ancestors
// (`e2e/fixture-server.md` from packages/web/src/test/). It misses a path
// assembled from separate segments, such as
// join(root, 'packages', 'contract', 'README.md'), a path built at runtime,
// and a token on a line the comment filter skips (`//`, `/*`, `*`).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { isDocsPath, testReadDocuments } = require('./change-surface.cjs');

const repoRoot = path.join(__dirname, '..', '..');

// Package files that name a docs-only Markdown file without reading it, as the
// `naming file -> Markdown path` pairs the scan below finds.
const TEMP_NOTES = 'names notes.md in a temporary repo or skill fixture, never this one';
const FIXTURE_README = 'writes or checks README.md in a temporary fixture repo, never this one';
const mentionedOnly = [
  { file: 'packages/cezar/scripts/mock-claude.mjs', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/artifacts/contract.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/server/worktrees-api.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/skills-remote.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/workflows/run.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/workflows/system-prompt.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/src/workflows/team-skill-materialize.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/cezar/test/unit/skills-remote.test.ts', markdown: 'packages/cezar/notes.md', reason: TEMP_NOTES },
  { file: 'packages/web/e2e/agents-dock.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/commit-list.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/composer-defaults.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/composer.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/create-project.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/live-preview.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/markdown-preview.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/new-task-hierarchy.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/new-task-picker-layout.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/new-task.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/plan-mode.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/queued-stack.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/review-gate.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/settings-monitoring.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/sidebar-reference-status.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/skill-search-ranking.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/task-changes.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/task-files.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/task-github-items.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/task-pr-collection.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/task-views-layout.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/touch-targets.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/e2e/worktree-setup.e2e.ts', markdown: 'packages/web/e2e/README.md', reason: FIXTURE_README },
  { file: 'packages/web/src/test/e2e-wait-discipline.baseline.json', markdown: 'packages/web/e2e/README.md', reason: 'names the wait rules in its $comment' },
  { file: 'packages/web/src/test/e2e-wait-discipline.test.ts', markdown: 'packages/web/e2e/README.md', reason: 'names the wait rules in an assertion message' },
  { file: 'packages/web/src/test/e2e-wait-discipline.ts', markdown: 'packages/web/e2e/README.md', reason: 'names the wait rules in its failure message; scans only .ts specs' },
  { file: 'packages/web/src/test/fixture-server-start.test.ts', markdown: 'packages/web/e2e/fixture-server.md', reason: 'names the doc in its problem message; reads only .e2e.ts specs' },
];

function trackedFiles(...pathspecs) {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

function markdownTokens(source) {
  const tokens = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    tokens.push(...line.replace(/ \/\/.*$/, '').match(/[\w.@/-]+\.md(?!\w)/g) ?? []);
  }
  return tokens;
}

// Every (naming file, Markdown path) pair where a tracked code file under
// packages/ names a tracked package Markdown file that isDocsPath admits. A
// token resolves against the naming file's directory and each ancestor, so
// `e2e/fixture-server.md` named from packages/web/src/test/ still counts.
function docsMarkdownNamedByPackageCode() {
  const files = trackedFiles('packages');
  const markdown = new Set(files.filter((file) => file.endsWith('.md') && isDocsPath(file)));
  const hits = new Set();
  for (const file of files) {
    if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(file)) continue;
    const absolute = path.join(repoRoot, file);
    if (!fs.existsSync(absolute)) continue;
    const directories = [];
    for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
      directories.push(dir);
      if (dir === '.') break;
    }
    for (const token of markdownTokens(fs.readFileSync(absolute, 'utf8'))) {
      for (const dir of directories) {
        const candidate = path.posix.normalize(path.posix.join(dir, token));
        if (markdown.has(candidate)) hits.add(`${file} -> ${candidate}`);
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

test('package code names no docs-only Markdown it might read', () => {
  const listed = new Set(mentionedOnly.map(({ file, markdown }) => `${file} -> ${markdown}`));
  const hits = docsMarkdownNamedByPackageCode();
  const unlisted = hits.filter((hit) => !listed.has(hit));
  assert.deepEqual(unlisted, [], [
    'Package code names Markdown that the docs-only change surface lets skip every test:',
    ...unlisted.map((hit) => `  ${hit}`),
    'If a Vitest test or cockpit browser spec reads the file, add it to testReadDocuments in',
    '.github/scripts/change-surface.cjs. If the code only names it, add the pair to',
    'mentionedOnly in .github/scripts/change-surface-readers.test.cjs with a one-line reason.',
  ].join('\n'));
  const stale = [...listed].filter((entry) => !hits.includes(entry));
  assert.deepEqual(stale, [], `mentionedOnly lists pairs the scan no longer finds; remove them:\n  ${stale.join('\n  ')}`);
  for (const { reason } of mentionedOnly) assert.ok(reason?.trim(), 'every mentionedOnly entry needs a reason');
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
