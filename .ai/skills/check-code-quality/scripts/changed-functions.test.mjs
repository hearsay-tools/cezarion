import './test-support.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareFunctions, exceededMetrics, matchFunctions, runChangedFunctions, scanChanges } from './changed-functions.mjs';

test('limits flag either score strictly above the threshold and preserve missing CRAP', () => {
  assert.deepEqual(exceededMetrics({ complexity: 20, crap: 30 }), []);
  assert.deepEqual(exceededMetrics({ complexity: 21, crap: null }), ['complexity']);
  assert.deepEqual(exceededMetrics({ complexity: 2, crap: 30.001 }), ['crap']);
  assert.deepEqual(exceededMetrics({ complexity: 21, crap: 31 }), ['crap', 'complexity']);
  assert.deepEqual(exceededMetrics({ complexity: 2, crap: null }), []);
});

test('selects edited functions and ignores line shifts and untouched siblings', () => {
  const before = 'function a(x) { return x; }\nfunction b() { return 2; }';
  const after = '// new heading\nfunction a(x) { return x ? 1 : 0; }\nfunction b() { return 2; }';
  const result = compareFunctions(before, after, 'file.ts');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'a');
  assert.equal(result[0].line, 2);
  assert.equal(result[0].complexity, 2);
  assert.deepEqual(result[0].baseline, { name: 'a', line: 1, complexity: 1 });
});

test('nested body edits belong to the nested function; parent edits stay selected', () => {
  const before = 'function outer() { const inner = (x) => { return x; }; return inner(1); }';
  const after = before.replace('return x;', 'return x ? 1 : 0;');
  assert.deepEqual(compareFunctions(before, after, 'file.js').map(fn => fn.name), ['inner']);
  assert.deepEqual(compareFunctions(before, after.replace('inner(1)', 'inner(2)'), 'file.js').map(fn => fn.name), ['outer', 'inner']);
});

test('tracks additions and duplicate identities conservatively and omits removals', () => {
  const removed = 'function gone() {}';
  assert.deepEqual(compareFunctions(removed, '', 'file.ts'), []);
  assert.equal(compareFunctions('', removed, 'file.ts')[0].change, 'added');
  const before = 'const a = { f() { return 1; } }; const b = { f() { return 2; } };';
  const after = before.replace('return 1', 'return 3');
  const changed = compareFunctions(before, after, 'file.ts');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].change, 'unknown');
  assert.equal(changed[0].baseline, null);
  assert.deepEqual(changed[0].candidates.map(({ name, complexity }) => [name, complexity]), [['f', 1], ['f', 1]]);
});

test('details expose decision points, body hashes and the functions nothing took over', () => {
  const before = 'function keep(x) { return x; }\nfunction gone(x) { if (x) return 1; return 2; }';
  const after = 'function keep(x) { return x; }\nfunction fresh(x) { if (x) return 1; return 2; }';
  const { changed, unmatched } = matchFunctions(before, after, 'file.ts', { details: true });
  assert.deepEqual(changed.map(fn => fn.name), ['fresh']);
  assert.deepEqual(changed[0].points, [{ line: 2, kind: 'IfStatement' }]);
  assert.deepEqual(unmatched.map(fn => fn.name), ['gone']);
  assert.equal(unmatched[0].bodyHash, changed[0].bodyHash, 'a rename keeps the body hash');
  assert.deepEqual(matchFunctions(before, after, 'file.ts').unmatched, []);
  const twins = 'const a = { f() { return 1; } }; const b = { f() { return 2; } };';
  const ambiguous = matchFunctions(twins, twins.replace('return 1', 'return 3'), 'file.ts', { details: true });
  assert.equal(ambiguous.changed[0].change, 'unknown');
  assert.deepEqual(ambiguous.unmatched, [], 'the candidates of an ambiguous match were not removed');
  assert.equal('bodyHash' in compareFunctions(before, after, 'file.ts')[0], false, 'plain comparisons keep their shape');
});

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-quality-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Metrics Test');
  git('config', 'user.email', 'metrics@example.invalid');
  const write = (path, source) => writeFileSync(join(cwd, path), source);
  write('file.ts', 'function choose(x) { return x; }');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  return { cwd, git, write, base };
}

test('scan includes branch, staged, unstaged and untracked source; honors ignores', t => {
  const f = repo(t);
  f.write('file.ts', 'function choose(x) { return x ? 1 : 0; }');
  f.git('commit', '-qam', 'change');
  f.write('staged.ts', 'function staged() {}');
  f.git('add', 'staged.ts');
  f.write('file.ts', 'function choose(x) { if (x) return 1; return x ? 2 : 0; }');
  f.write('new "quoted"\nfile.ts', 'function fresh() {}');
  f.write('.gitignore', 'ignored.ts\n');
  f.write('ignored.ts', 'this is invalid syntax');
  const result = scanChanges(f.base, f.cwd);
  assert.equal(result.base, f.base);
  assert.equal(result.files.length, 3);
  const changed = result.files.find(file => file.file === 'file.ts');
  assert.equal(changed.functions[0].complexity, 3);
  assert.equal(changed.functions[0].baseline.complexity, 1);
  assert.equal(changed.sourceHash.length, 64);
  assert.ok(result.files.some(file => file.file === 'new "quoted"\nfile.ts'));
});

test('uses merge-base rather than changes made only on the target branch', t => {
  const f = repo(t);
  f.git('checkout', '-qb', 'target');
  f.write('target.ts', 'function onlyOnTarget() {}');
  f.git('add', '.');
  f.git('commit', '-qm', 'target-only');
  f.git('checkout', '--detach', f.base);
  f.write('file.ts', 'function choose(x) { return x || 0; }');
  const result = scanChanges('target', f.cwd);
  assert.equal(result.base, f.base);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.deletedFiles, []);
});

test('deleted files have no scores and symlink sources cannot read outside the repo', t => {
  const f = repo(t);
  rmSync(join(f.cwd, 'file.ts'));
  assert.deepEqual(scanChanges(f.base, f.cwd).deletedFiles, ['file.ts']);
  symlinkSync(join(f.cwd, '.git/config'), join(f.cwd, 'link.ts'));
  assert.throws(() => scanChanges(f.base, f.cwd), /regular source file/);
});

test('unknown base, invalid source and incomplete arguments fail instead of passing', t => {
  const f = repo(t);
  let output = '', error = '';
  const invoke = args => runChangedFunctions(args, {
    cwd: f.cwd, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } },
  });
  assert.equal(invoke([]), 1);
  assert.match(error, /--base/);
  assert.equal(invoke(['--base', 'absent']), 1);
  f.write('file.ts', 'function broken(');
  assert.equal(invoke(['--base', f.base]), 1);
  assert.equal(output, '');
});

test('the real scanner runs from a different repository and returns machine-readable JSON', t => {
  const f = repo(t);
  mkdirSync(join(f.cwd, 'src'));
  f.write('src/added.ts', 'export const added = () => 1;');
  const script = new URL('./changed-functions.mjs', import.meta.url);
  const result = JSON.parse(execFileSync(process.execPath, [script.pathname, '--base', f.base], { cwd: f.cwd, encoding: 'utf8' }));
  assert.equal(result.root, f.cwd);
  assert.equal(result.files[0].functions[0].name, 'added');
});

test('every Git call after baseline resolution uses its pinned attribute source', t => {
  const f = repo(t);
  f.write('file.ts', 'function choose(x) { return x || 0; }');
  const executable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.cwd, 'bin');
  const log = join(f.cwd, 'git-calls.jsonl');
  mkdirSync(bin);
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
  const shim = join(bin, 'git');
  writeFileSync(shim, `#!${process.execPath}
    import { appendFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
    const result = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  `);
  chmodSync(shim, 0o755);
  const script = new URL('./changed-functions.mjs', import.meta.url);
  execFileSync(process.execPath, [script.pathname, '--base', f.base], {
    cwd: f.cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const resolved = calls.findIndex(args => args[0] === 'merge-base');
  assert.ok(resolved >= 0);
  const reads = calls.slice(resolved + 1);
  assert.ok(reads.some(args => args.includes('show')), 'baseline source was read');
  for (const args of reads) assert.equal(args[0], `--attr-source=${f.base}`, JSON.stringify(args));
  assert.ok(reads.some(args => args.includes('--no-textconv')), 'raw content reads disable text conversion');
});

test('a head revision is read from Git objects, never from the working tree', t => {
  const f = repo(t);
  f.write('file.ts', 'function choose(x) { return x ? 1 : 0; }');
  symlinkSync('file.ts', join(f.cwd, 'link.ts'));
  f.git('add', '.');
  f.git('commit', '-qm', 'head');
  const head = f.git('rev-parse', 'HEAD');
  f.write('file.ts', 'function choose(x) { return x && x.a && x.b && x.c ? 1 : 0; }');
  f.write('untracked.ts', 'function stray() {}');
  const result = scanChanges(f.base, f.cwd, { head });
  assert.equal(result.head, head);
  assert.deepEqual(result.files.map(file => file.file), ['file.ts'], 'the symlink is skipped, the untracked file is not seen');
  assert.equal(result.files[0].functions[0].complexity, 2);
  assert.equal('removed' in result, false);
});

test('details offer the functions of a deleted file as the source of a move', t => {
  const f = repo(t);
  const body = '{ if (x) return 1; if (y) return 2; return 3; }';
  f.write('old.ts', `export function relocated(x, y) ${body}`);
  f.git('add', '.');
  f.git('commit', '-qm', 'old home');
  const base = f.git('rev-parse', 'HEAD');
  rmSync(join(f.cwd, 'old.ts'));
  f.write('new.ts', `export function relocated(x, y) ${body}`);
  f.git('add', '-A');
  f.git('commit', '-qm', 'move');
  const result = scanChanges(base, f.cwd, { head: f.git('rev-parse', 'HEAD'), details: true });
  assert.deepEqual(result.deletedFiles, ['old.ts']);
  assert.deepEqual(result.removed.map(fn => [fn.file, fn.name, fn.complexity]), [['old.ts', 'relocated', 3]]);
  assert.equal(result.removed[0].bodyHash, result.files[0].functions[0].bodyHash);
});
