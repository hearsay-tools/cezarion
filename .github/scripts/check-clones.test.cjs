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
  try {
    git('init', '--quiet');
    write('packages/demo/src/first.ts', `export function calculate(values: number[]) {\n let total = 0;\n${code}\n return total;\n}\n`);
    write('packages/demo/src/second.ts', fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')));
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    assert.equal(scan(base).status, 0);
    t.diagnostic("existing baseline clones: exit 0");
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
  assert.deepEqual(compare(base, summary([reportedClone(a, a, 100, false)])), []);
  assert.match(compare(base, summary([reportedClone(a, a, 100)]))[0], /New same-file clone/);
  assert.match(compare(base, summary([reportedClone(a, b, 100, false)]))[0], /Cross-package clone/);
  for (const tokens of [undefined, NaN, -1, 0, 1.5]) assert.throws(() => summary([reportedClone(a, a, tokens)]), /Invalid clone accounting/);
  assert.throws(() => summary([reportedClone('../outside.ts', a, 100)]), /outside the scanned packages/);
  const bad = reportedClone(a, a, 100); bad.firstFile.start = 0;
  assert.throws(() => summary([bad]), /Invalid clone location/);
});

test('same-file fingerprints and empty committed trees retain their policy', () => {
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
    assert.equal(recut.status, 1, recut.stdout + recut.stderr);
    assert.match(recut.stdout, /New same-file clone/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
