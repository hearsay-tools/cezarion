import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./test-changed.mjs', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'test-changed-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text = 'export const value = 1;\n') => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  put('packages/web/src/a.ts');
  git('add', '.');
  git('commit', '-m', 'base');
  git('checkout', '-b', 'feature');
  return { cwd, git, put };
}
function plan(cwd, ...args) {
  const result = spawnSync(process.execPath, [script, '--plan', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('selects branch changes plus staged, unstaged, and untracked source files', t => {
  const { cwd, git, put } = fixture(t);
  put('packages/web/src/committed.ts');
  git('add', '.'); git('commit', '-m', 'source');
  put('packages/web/src/staged.ts'); git('add', '.');
  put('packages/web/src/a.ts', 'export const value = 2;\n');
  put('packages/web/src/new.test.ts');
  const p = plan(cwd);
  assert.equal(p.mode, 'changed');
  assert.deepEqual(p.files, ['packages/web/src/a.ts', 'packages/web/src/committed.ts', 'packages/web/src/new.test.ts', 'packages/web/src/staged.ts']);
  assert.deepEqual(p.args, ['test', '--', `--changed=${git('rev-parse', 'main')}`, '--passWithNoTests=false']);
});

test('compares against merge-base, not unrelated changes on main', t => {
  const { cwd, git, put } = fixture(t);
  const base = git('rev-parse', 'main');
  git('checkout', 'main'); put('package.json', '{}'); git('add', '.'); git('commit', '-m', 'base-only');
  git('checkout', 'feature'); put('packages/web/src/a.ts', 'changed');
  const p = plan(cwd);
  assert.equal(p.mode, 'changed');
  assert.equal(p.base, base);
  assert.deepEqual(p.files, ['packages/web/src/a.ts']);
});

for (const path of ['package.json', 'vitest.config.ts', '.github/workflows/ci.yml', 'packages/contract/src/runs.ts', 'packages/web/src/global.css', 'packages/cezar/src/fixtures/data.json']) {
  test(`falls back to full Vitest for shared/configuration/unknown input: ${path}`, t => {
    const { cwd, put } = fixture(t); put(path);
    const p = plan(cwd);
    assert.equal(p.mode, 'full');
    assert.deepEqual(p.args, ['test']);
  });
}

test('staged and unstaged changes cannot cancel a shared input out of classification', t => {
  const { cwd, git, put } = fixture(t);
  put('package.json', '{}'); git('add', '.'); git('commit', '-m', 'manifest');
  git('branch', '-f', 'main', 'HEAD');
  put('package.json', '{"scripts":{}}'); git('add', '.'); put('package.json', '{}');
  put('packages/web/src/a.ts', 'changed');
  assert.equal(plan(cwd).mode, 'full');
});

test('deletions and renames fall back rather than losing dependents', t => {
  const { cwd, git } = fixture(t);
  git('mv', 'packages/web/src/a.ts', 'packages/web/src/renamed.ts');
  assert.equal(plan(cwd).mode, 'full');
});

test('unusual Git-quoted source paths fall back to full selection', t => {
  const { cwd, put } = fixture(t); put('packages/web/src/ü.ts');
  assert.equal(plan(cwd).mode, 'full');
});

test('missing base fails closed to the full suite', t => {
  const { cwd } = fixture(t);
  assert.equal(plan(cwd, '--base=missing-ref').mode, 'full');
});

test('no Git repository fails closed to the full suite', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'no-git-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(plan(cwd).mode, 'full');
});

test('clean and documentation-only changes explicitly skip iteration tests', t => {
  const { cwd, put } = fixture(t);
  assert.equal(plan(cwd).mode, 'skip');
  put('README.md', '# Docs');
  put('docs/guide.md', '# Guide');
  const p = plan(cwd);
  assert.equal(p.mode, 'skip');
  assert.deepEqual(p.args, []);
});

test('an explicit base overrides automatic main selection', t => {
  const { cwd, git, put } = fixture(t);
  put('packages/web/src/new.ts'); git('add', '.'); git('commit', '-m', 'new');
  assert.equal(plan(cwd, '--base=HEAD').mode, 'skip');
});

test('full fallback propagates a failing npm test exit code', t => {
  const { cwd, put } = fixture(t);
  put('package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(23)"' } }));
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /full:/);
});

test('clean changes skip without invoking the test command', t => {
  const { cwd, git, put } = fixture(t);
  put('package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(23)"' } }));
  git('add', '.'); git('commit', '-m', 'test command');
  const result = spawnSync(process.execPath, [script, '--base=HEAD'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip:/);
});

test('changed mode executes only related tests with the installed Vitest', t => {
  const { cwd, git, put } = fixture(t);
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  put('package.json', JSON.stringify({ type: 'module', scripts: {
    test: `${JSON.stringify(process.execPath)} ${JSON.stringify(vitest)} run`,
  } }));
  put('.gitignore', 'node_modules/\n');
  put('vitest.config.mjs', 'export default {test: {globals: true, passWithNoTests: true, maxWorkers: 1, include: ["packages/web/src/*.test.ts"]}};');
  put('packages/web/src/a.test.ts', 'import { value } from "./a"; test("related passes", () => expect(value).toBe(2));');
  put('packages/web/src/b.test.ts', 'test("unrelated must not run", () => { throw new Error("unrelated selected"); });');
  git('add', '.'); git('commit', '-m', 'test fixtures');
  git('branch', '-f', 'main', 'HEAD');
  put('packages/web/src/a.ts', 'export const value = 2;');
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 passed/);
  assert.doesNotMatch(result.stdout, /unrelated must not run/);
  put('packages/web/src/a.ts', 'export const value = 3;');
  const failed = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  git('restore', 'packages/web/src/a.ts');
  put('packages/web/src/orphan.ts', 'export const orphan = true;');
  const orphanPlan = plan(cwd);
  assert.equal(orphanPlan.mode, 'changed', JSON.stringify(orphanPlan));
  const unmatched = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(unmatched.status, 1, unmatched.stdout + unmatched.stderr);
  assert.match(unmatched.stdout + unmatched.stderr, /No test files found/);
});

test('unknown flags cannot silently weaken selection', t => {
  const { cwd } = fixture(t);
  const result = spawnSync(process.execPath, [script, '--shard=1/4'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown argument/);
});
