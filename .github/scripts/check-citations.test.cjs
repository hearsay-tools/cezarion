const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { bareCitations, checkCitations } = require('./check-citations.cjs');

const script = path.join(__dirname, 'check-citations.cjs');
const cites = (file, text) => bareCitations(file, text).map(({ line, number, context }) => `${line}:${number}:${context}`);

test('reads a bare citation in a TS comment, with its line and number', () => {
  assert.deepEqual(cites('src/a.ts', 'const a = 1;\n// #1265: the captured text\n/**\n * Fixed in (#723).\n */\n'), [
    '2:1265:comment',
    '4:723:comment',
  ]);
});

test('passes qualified citations and the documented fork and upstream forms', () => {
  const text = [
    '// hearsay-tools/cezarion#1265 and open-mercato/cezar#811',
    '// fork #12, upstream #13, upstream PR #14, Fork issue #15',
    '// [#16](https://github.com/hearsay-tools/cezarion/pull/16)',
  ].join('\n');
  assert.deepEqual(cites('src/a.ts', text), []);
});

test('a GitHub link qualifies only the number of the issue or PR it opens', () => {
  const text = [
    'See [#46842](https://github.com/anomalyco/opencode/issues/46842) and [#16](https://github.com/o/r/pull/16/files).',
    'Wrong: [#12](https://github.com/example/project/issues/34).',
    'Not an issue: [#13](https://github.com/o/r/blob/main/a.md).',
    'Two: [#14, #15](https://github.com/o/r/issues/14).',
  ].join('\n');
  assert.deepEqual(cites('notes.md', text), ['2:12:Markdown prose', '3:13:Markdown prose', '4:15:Markdown prose']);
});

test('passes colors, entities, shell syntax, anchors and a # joined to a word or path', () => {
  const text = '// #000 #0f0 #12ab &#8212; $# ${#args[@]} README.md#12 https://x.test/page#12 (#12-step) PR#12\n';
  assert.deepEqual(cites('src/a.ts', text), []);
});

test('passes text in backticks: test filters, protocol and UI sample values', () => {
  assert.deepEqual(cites('src/a.ts', '// run `npm test -- -t "R44 (#723)"`; the chip shows `#777`\n'), []);
  assert.deepEqual(cites('notes.md', 'The chip shows `#777`, and ``a `#1` b`` too.\n'), []);
});

test('leaves code, string literals and JSX text alone, and reads JSX comments', () => {
  const text = [
    "const chip = '#790';",
    'const label = `PR #${n}`;',
    "expect(row.textContent).toBe('#2 in queue');",
    'const view = <p>#12 {/* #13: why */}</p>;',
  ].join('\n');
  assert.deepEqual(cites('src/a.tsx', text), ['4:13:comment']);
});

test('reads test titles, and no other call that happens to be named test', () => {
  const text = [
    "describe('the calmer row (#617)', () => {",
    "  it.each([1, 2])('pins row %s (#935)', () => {});",
    '  test(`${backend} R14 runs a chain (#452)`, () => {});',
    "  describeRunners('every runner (#1288)', () => {});",
    "  it('keeps `#1` in backticks', () => {});",
    "  expect(/#\\d+/.test('#12')).toBe(true);",
    "  expect(pattern.test('#13 x')).toBe(true);",
    '});',
  ].join('\n');
  assert.deepEqual(cites('src/a.test.ts', text), ['1:617:test title', '2:935:test title', '3:452:test title', '4:1288:test title']);
});

test('reads CSS comments but not CSS values', () => {
  assert.deepEqual(cites('a.css', '/* #724: the shared row */\n.a { color: #171717; content: "#12"; }\n'), ['1:724:comment']);
});

test('reads YAML and shell comments but not values, strings or $#', () => {
  const yaml = 'on: push # since #1448\nrun: |\n  echo "PR #12" \'#13\'\n  echo $# ${#a[@]}\n  # see #31\n';
  assert.deepEqual(cites('ci.yml', yaml), ['1:1448:comment', '5:31:comment']);
  assert.deepEqual(cites('up.sh', '#!/bin/sh\n#1310: not a citation, the comment marker\n# returns (#36)\n'), ['3:36:comment']);
});

test('a shell quote opens mid-word, and a YAML quote only at the start of a token', () => {
  const shell = "printf pre' # see #12'\nx=a\" # see #13\"\necho it\\'s # (#37)\n# real (#36)\n";
  assert.deepEqual(cites('up.sh', shell), ['3:37:comment', '4:36:comment']);
  assert.deepEqual(cites('ci.yml', "note: the fork's rail # see #14\n"), ['1:14:comment']);
});

test('reads Markdown prose but not code fences, inline code or qualified links', () => {
  const text = [
    '# Notes',
    'Fixes #12.',
    '```bash',
    'npm test -- -t "(#13)"',
    '```',
    '~~~~',
    '#14',
    '~~~~',
    'See [#15](https://github.com/open-mercato/cezar/issues/15) and `#16`.',
    '| #17 | cell |',
  ].join('\n');
  assert.deepEqual(cites('notes.md', text), ['2:12:Markdown prose', '10:17:Markdown prose']);
});

test('reads nothing in file types it does not know', () => {
  assert.deepEqual(cites('data.json', '{"title": "#12"}'), []);
  assert.deepEqual(cites('mock.html', '<p>#12</p>'), []);
});

/** A throwaway repository: `commit(files)` writes or deletes (null) files and commits them. */
function fixtureRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cez-citations-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (files) => {
    for (const [file, text] of Object.entries(files)) {
      const full = path.join(dir, file);
      if (text === null) fs.rmSync(full);
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
      }
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'change');
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

const findings = (repo, base) => checkCitations({ cwd: repo.dir, base }).findings
  .map(({ path: file, line, number }) => `${file}:${line}:${number}`);

test('fails an added bare citation and passes a file whose bare citations are legacy', (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit({ 'src/a.ts': '// #468: legacy\nexport const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
  repo.commit({ 'src/a.ts': '// #468: legacy\nexport const a = 1;\nexport const c = 3;\n' });
  assert.deepEqual(findings(repo, base), [], 'a touched file that adds no citation passes');
  repo.commit({ 'src/a.ts': '// #468: legacy, reworded\nexport const a = 1;\n' });
  assert.deepEqual(findings(repo, base), [], 'a reworded legacy line passes');
  repo.commit({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': '// #468: legacy, moved\nexport const b = 2;\n' });
  assert.deepEqual(findings(repo, base), [], 'a legacy citation moved to another file passes');
  repo.commit({ 'src/b.ts': '// #468: legacy, moved\nexport const b = 2;\n// #1265: new\n// #468: cited again\n' });
  assert.deepEqual(findings(repo, base), ['src/b.ts:1:468', 'src/b.ts:3:1265', 'src/b.ts:4:468']);
});

test('reads every file type it knows in a diff, and no other', (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit({ 'README.md': 'Hello.\n' });
  repo.commit({
    'src/a.ts': '// #11\n', 'a.css': '/* #12 */\n', 'ci.yml': '# #13\n', 'up.sh': '# #14\n', 'notes.md': '#15\n',
    'data.json': '{"title": "#16"}\n', 'mock.html': '<p>#17</p>\n',
  });
  assert.deepEqual(findings(repo, base), ['a.css:1:12', 'ci.yml:1:13', 'notes.md:1:15', 'src/a.ts:1:11', 'up.sh:1:14']);
});

test('the CLI names the file, the line and the qualified form, and exits 1', (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit({ 'src/a.ts': 'export const a = 1;\n' });
  repo.commit({ 'src/a.ts': 'export const a = 1;\n// #1265: the captured text\n' });
  const run = (env) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });
  const local = run({});
  assert.equal(local.status, 1, local.stderr);
  assert.match(local.stdout, /^src\/a\.ts:2: bare #1265 in a comment\. Write hearsay-tools\/cezarion#1265 \(fork\) or open-mercato\/cezar#1265 \(upstream\)\.$/m);
  assert.doesNotMatch(local.stdout, /::error/);
  const actions = run({ GITHUB_ACTIONS: 'true' });
  assert.match(actions.stdout, /^::error file=src\/a\.ts,line=2,title=Bare issue citation::bare #1265 in a comment\./m);
});

test('the CLI exits 0 on a clean diff and 2 on a base it cannot resolve', (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit({ 'src/a.ts': 'export const a = 1;\n' });
  repo.commit({ 'src/a.ts': 'export const a = 1; // hearsay-tools/cezarion#1265\n' });
  const clean = spawnSync(process.execPath, [script, '--base', base], { cwd: repo.dir, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /no bare issue or PR citation added/);
  const missing = spawnSync(process.execPath, [script, '--base', 'no-such-ref'], { cwd: repo.dir, encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no-such-ref/);
});

test('the CLI exits 2, naming the file, when it cannot parse a script', (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit({ 'README.md': 'Hello.\n' });
  repo.commit({ 'src/broken.ts': 'const = ; // #1265\n' });
  const result = spawnSync(process.execPath, [script, '--base', base], { cwd: repo.dir, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot parse src\/broken\.ts/);
});

test('skips generated files, test data and an archive import, and checks a later archive edit', (t) => {
  const repo = fixtureRepo(t);
  const note = '> Historical source: `open-mercato/cezar` (upstream), preserved at fork point `feb85666`.\n';
  const base = repo.commit({ 'README.md': 'Hello.\n' });
  repo.commit({
    '.ai/upstream/LEDGER.md': '| fix (#943) |\n',
    '.ai/upstream/scans/2026-10-25.md': '| fix (#944) |\n',
    'src/fixtures/issue.md': 'Fixes #945.\n',
    'src/__snapshots__/a.test.ts.snap': '// #946\n',
    '.ai/specs/old.md': `# Old\n\n${note}\nRelates to #947.\n`,
  });
  assert.deepEqual(findings(repo, base), []);
  const imported = repo.git('rev-parse', 'HEAD');
  repo.commit({ '.ai/specs/old.md': `# Old\n\n${note}\nRelates to #947.\nNew prose cites #948.\n` });
  assert.deepEqual(findings(repo, imported), ['.ai/specs/old.md:6:948']);
});

test('checks new prose in an existing file that gains its source note in the same change', (t) => {
  const repo = fixtureRepo(t);
  const note = '> Historical source: `open-mercato/cezar` (upstream), preserved at fork point `feb85666`.\n';
  const base = repo.commit({ '.ai/specs/kept.md': '# Kept\n\nRelates to #947.\n' });
  repo.commit({ '.ai/specs/kept.md': `# Kept\n\n${note}\nRelates to #947.\nNew prose cites #948.\n` });
  assert.deepEqual(findings(repo, base), ['.ai/specs/kept.md:6:948'], 'the legacy #947 passes, the new #948 fails');
});

test('names only resolved SHAs in every git call after resolving the range', (t) => {
  const repo = fixtureRepo(t);
  const base = repo.commit({ 'src/a.ts': 'export const a = 1;\n' });
  repo.commit({ 'src/a.ts': 'export const a = 1;\n// #1265: new\n', 'notes.md': 'See #12.\n' });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-git-shim-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const log = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\0' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [script, '--base', 'main~1'], {
    cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stderr);
  const calls = fs.readFileSync(log, 'utf8').split('\0\n').filter(Boolean).map((call) => call.split('\0'));
  assert.ok(calls.length > 2, 'the range is resolved first, then read');
  const sha = /^[0-9a-f]{40}$/;
  for (const call of calls.slice(2)) {
    for (const arg of call.filter((a) => !a.startsWith('-') && !['diff', 'cat-file', 'blob'].includes(a))) {
      assert.match(arg, sha, `git ${call.join(' ')} names a ref that can move: ${arg}`);
    }
  }
});
