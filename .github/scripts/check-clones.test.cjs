const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const script = path.join(__dirname, 'check-clones.cjs');

test('existing clones pass; an added clone fails and prints both source locations', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-proof-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), content); };
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const code = Array.from({ length: 12 }, (_, i) => `  total += values[${i}] * ${i + 37};`).join('\n');
  const source = (comment) => `export function calculate(values: number[]) {\n let total = 0;\n // ${comment}\n${code}\n return total;\n}\n`;
  try {
    git('init', '--quiet');
    write('packages/demo/src/first.ts', source('weights rows by position'));
    write('packages/demo/src/second.ts', source('weights rows by position'));
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    assert.equal(scan(base).status, 0);
    t.diagnostic("existing baseline clones: exit 0");
    // hearsay-tools/squawk#1888: jscpd counts no comment tokens, so a comment edit inside a clone keeps its pair total.
    write('packages/demo/src/second.ts', source('weights each row by its position in the list'));
    git('add', '.'); git('commit', '-qm', 'comment edit');
    const commentEdit = scan(base);
    assert.equal(commentEdit.status, 0, commentEdit.stdout + commentEdit.stderr);
    write('packages/demo/src/third.ts', fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')));
    git('add', '.'); git('commit', '-qm', 'clone');
    const failure = scan(base);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.match(failure.stdout, /packages\/demo\/src\/first\.ts/);
    assert.match(failure.stdout, /packages\/demo\/src\/third\.ts/);
    t.diagnostic("added clone: exit 1; " + failure.stdout.split("\n").filter(line => /(?:first|third)\.ts/.test(line)).join("; "));
    write('packages/demo/src/third.ts', '// jscpd:ignore-start -- deliberate test example\n' + fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')) + '// jscpd:ignore-end\n');
    git('add', '.'); git('commit', '-qm', 'reasoned exception');
    assert.equal(scan(base).status, 0);
    fs.unlinkSync(path.join(repo, 'packages/demo/src/third.ts'));
    for (const name of ['ignored.test.ts', 'ignored.testkit.ts', 'ignored.e2e.ts', 'fixtures/example.ts']) {
      write(`packages/demo/src/${name}`, fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')));
    }
    write('.jscpd.json', '{"minTokens":1000000000}');
    write('.gitignore', 'packages/\n');
    git('add', '-f', '.'); git('commit', '-qm', 'excluded copies');
    assert.equal(scan(base).status, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// hearsay-tools/cezarion#1813: a baseline cannot grandfather a second package's copy.
test('cross-package clones fail even when already in the baseline', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-package-clone-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), content); };
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const code = `export function calculate(values: number[]) {\n let total = 0;\n${Array.from({ length: 12 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n')}\n return total;\n}\n`;
  try {
    git('init', '--quiet');
    write('packages/contract/src/shared.ts', code);
    // A same-package baseline clone must stay allowed.
    write('packages/contract/src/other.ts', code);
    git('add', '.'); git('commit', '-qm', 'same-package baseline');
    const initial = git('rev-parse', 'HEAD');
    assert.equal(scan(initial).status, 0);
    write('packages/web/src/copied.ts', code);
    git('add', '.'); git('commit', '-qm', 'planted cross-package clone');
    for (const base of ['HEAD', initial]) {
      const failure = scan(base);
      assert.equal(failure.status, 1, `base ${base}: ${failure.stdout}${failure.stderr}`);
      assert.match(failure.stdout, /Cross-package clone/);
      assert.match(failure.stdout, /packages\/contract\/src\/(?:shared|other)\.ts:\d+/);
      assert.match(failure.stdout, /packages\/web\/src\/copied\.ts:\d+/);
    }
    t.diagnostic('planted cross-package clone rejected both as new code and as baseline code');
    fs.unlinkSync(path.join(repo, 'packages/web/src/copied.ts'));
    for (const name of ['ignored.test.ts', 'ignored.testkit.ts', 'ignored.e2e.ts', 'fixtures/example.ts']) {
      write(`packages/web/src/${name}`, code);
    }
    git('add', '.'); git('commit', '-qm', 'only excluded cross-package copies');
    assert.equal(scan('HEAD').status, 0);
    // A candidate cannot weaken the trusted report configuration.
    write('packages/web/src/copied.ts', code);
    write('.jscpd.json', '{"minTokens":1000000000}');
    write('.gitignore', 'packages/\n');
    git('add', '-f', '.'); git('commit', '-qm', 'candidate attempts to hide copy');
    assert.equal(scan('HEAD').status, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// hearsay-tools/cezarion#2135: shrinking an inherited pair can change every fingerprint.
test('recut cross-file clones pass within the inherited token ceiling', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-recut-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const folder = path.join(repo, 'packages/demo/src');
  const code = `export function calculate(values: number[]) {\n let total = 0;\n${Array.from({ length: 30 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n')}\n return total;\n}\n`;
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '--quiet'); fs.mkdirSync(folder, { recursive: true });
    for (const name of ['first.ts', 'second.ts']) fs.writeFileSync(path.join(folder, name), code);
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(folder, 'second.ts'), code.replace(' total += values[15] * 52;', ' total = uniqueBoundary(total);'));
    git('add', '.'); git('commit', '-qm', 'recut inherited clone');
    const recut = scan(base);
    assert.equal(recut.status, 0, recut.stdout + recut.stderr);
    // Growing the original pair must fail even without introducing a third file.
    const grown = code.replace(' return total;', ' total += values[100] * 137;\n return total;');
    for (const name of ['first.ts', 'second.ts']) fs.writeFileSync(path.join(folder, name), grown);
    git('add', '.'); git('commit', '-qm', 'grow inherited clone');
    const growth = scan(base);
    assert.equal(growth.status, 1, growth.stdout + growth.stderr);
    assert.match(growth.stdout, /tokens/);
    // Uncommitted edits cannot change the measured result.
    fs.writeFileSync(path.join(folder, 'second.ts'), 'export const unique = 1;\n');
    assert.equal(scan(base).status, 1);
    git('add', '.'); git('commit', '-qm', 'remove pair');
    assert.equal(scan(base).status, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

const { summarize, compare } = require('./check-clones.cjs');
const reportRoot = path.join(os.tmpdir(), 'clone-report-root');
function reportedClone(first, second, tokens, isNew = true) {
  return { firstFile: { name: path.join(reportRoot, first), start: 1 }, secondFile: { name: path.join(reportRoot, second), start: 10 }, tokens, isNew };
}

test('pair totals are unordered and cannot borrow allowance from another pair', () => {
  const a = 'packages/demo/src/a.ts'; const b = 'packages/demo/src/b.ts'; const c = 'packages/demo/src/c.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([reportedClone(a, b, 200), reportedClone(a, c, 200)]);
  assert.deepEqual(compare(base, summary([reportedClone(b, a, 80), reportedClone(a, b, 120)])), []);
  assert.deepEqual(compare(base, summary([])), []);
  const failures = compare(base, summary([reportedClone(a, b, 201), reportedClone(a, c, 50)]));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /baseline 200, head 201 tokens/);
  assert.equal(compare(base, summary([reportedClone(b, c, 50)])).length, 1);
});

test('report validation and same-file and cross-package policies fail closed', () => {
  const a = 'packages/demo/src/a.ts'; const b = 'packages/other/src/b.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([]);
  assert.match(compare(base, summary([reportedClone(a, a, 100, false)]))[0], /New same-file clone/);
  assert.match(compare(base, summary([reportedClone(a, a, 100)]))[0], /New same-file clone/);
  assert.match(compare(base, summary([reportedClone(a, b, 100, false)]))[0], /Cross-package clone/);
  for (const tokens of [undefined, NaN, -1, 0, 1.5]) assert.throws(() => summary([reportedClone(a, a, tokens)]), /Invalid clone accounting/);
  assert.throws(() => summary([reportedClone('../outside.ts', a, 100)]), /outside the scanned packages/);
  const bad = reportedClone(a, a, 100); bad.firstFile.start = 0;
  assert.throws(() => summary([bad]), /Invalid clone location/);
});

test('same-file token ceilings and empty committed trees retain their policy', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-self-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const folder = path.join(repo, 'packages/demo/src');
  const code = `export function calculate(values: number[]) {\n let total = 0;\n${Array.from({ length: 30 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n')}\n return total;\n}\n`;
  try {
    git('init', '--quiet'); git('commit', '--allow-empty', '-qm', 'empty baseline');
    const empty = git('rev-parse', 'HEAD');
    const emptyScan = scan(empty);
    assert.equal(emptyScan.status, 0, emptyScan.stdout + emptyScan.stderr);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'self.ts');
    fs.writeFileSync(file, code + code.replace('calculate', 'another'));
    git('add', '.'); git('commit', '-qm', 'same-file clones');
    const base = git('rev-parse', 'HEAD');
    assert.equal(scan(base).status, 0);
    assert.equal(scan(empty).status, 1);
    fs.writeFileSync(file, code + code.replace('calculate', 'another').replace(' total += values[15] * 52;', ' total = uniqueBoundary(total);'));
    git('add', '.'); git('commit', '-qm', 'recut same-file clone');
    const recut = scan(base);
    assert.equal(recut.status, 0, recut.stdout + recut.stderr);
    const grown = code.replace(' return total;', ' total += values[100] * 137;\n return total;');
    fs.writeFileSync(file, grown + grown.replace('calculate', 'another'));
    git('add', '.'); git('commit', '-qm', 'grow same-file clone');
    const growth = scan(base);
    assert.equal(growth.status, 1, growth.stdout + growth.stderr);
    assert.match(growth.stdout, /Clone token increase:.*baseline \d+, head \d+ tokens/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('named wait-baseline exception allows only its unordered file pair', () => {
  const server = 'packages/cezar/src/lint/wait-baseline.ts';
  const web = 'packages/web/src/test/wait-baseline.ts';
  const other = 'packages/contract/src/other.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([]);
  for (const [first, second] of [[server, web], [web, server]]) {
    const clone = reportedClone(first, second, 100);
    clone.firstFile.start = 42;
    clone.secondFile.start = 99;
    assert.deepEqual(compare(base, summary([clone])), []);
    for (const tokens of [undefined, NaN, -1, 0, 1.5]) {
      assert.throws(() => summary([reportedClone(first, second, tokens)]), /Invalid clone accounting/);
    }
    clone.firstFile.start = 0;
    assert.throws(() => summary([clone]), /Invalid clone location/);
  }
  for (const first of [server, web]) {
    assert.match(compare(base, summary([reportedClone(first, other, 100)]))[0], /Cross-package clone/);
  }
  assert.match(compare(base, summary([reportedClone('packages/demo/src/a.ts', other, 100)]))[0], /Cross-package clone/);
});

// hearsay-tools/cezarion#2532: removing a copy can re-cut the remaining clone.
test('removes one copy of a repeated block without raising same-file tokens', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-remove-copy-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const folder = path.join(repo, 'packages/demo/src');
  const code = Array.from({ length: 12 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n');
  const block = (name, suffix = '') => `export function ${name}(values: number[]) {\n let total = 0;\n${code}\n${suffix}\n return total;\n}\n`;
  try {
    git('init', '--quiet'); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'self.ts');
    const remaining = block('second', ' total = finishSecond(total);') + block('third', ' total = finishThird(total);');
    fs.writeFileSync(file, block('first') + remaining);
    git('add', '.'); git('commit', '-qm', 'three repeated blocks');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(file, remaining);
    git('add', '.'); git('commit', '-qm', 'remove first copy');
    const result = spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('same-file totals ignore fingerprints and cannot borrow another file or pair allowance', () => {
  const a = 'packages/demo/src/a.ts'; const b = 'packages/demo/src/b.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([reportedClone(a, a, 200, false), reportedClone(b, b, 200, false), reportedClone(a, b, 200, false)]);
  for (const tokens of [199, 200]) {
    assert.deepEqual(compare(base, summary([reportedClone(a, a, 80), reportedClone(a, a, tokens - 80)])), []);
  }
  assert.deepEqual(compare(base, summary([])), []);
  const growth = compare(base, summary([reportedClone(a, a, 100, false), reportedClone(a, a, 101, false)]));
  assert.equal(growth.length, 1);
  assert.match(growth[0], /Clone token increase:.*baseline 200, head 201 tokens/);
  assert.match(compare(summary([reportedClone(a, b, 200)]), summary([reportedClone(a, a, 50, false)]))[0], /New same-file clone/);
});
