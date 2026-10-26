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
