import './test-support.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { findGrowth, pairMoves, runComplexityGate } from './complexity-gate.mjs';

const OWNER_NOTE = 'For an owner-approved increase, the owner adds the baseline-growth label, then re-runs the failed complexity-gate job.';

/** A function with `points` decision points, so its complexity is points + 1. */
const complex = (name, points, extra = '') =>
  `export function ${name}(x) {\n${'  if (x) { x++; }\n'.repeat(points)}${extra}  return x;\n}\n`;

/** Same shape as `complex`, with a body that shares no line with it: a different function that may bear the same name. */
const unrelated = (name, points, extra = '') =>
  `export function ${name}(y) {\n${'  if (y) { y--; }\n'.repeat(points)}${extra}  return y;\n}\n`;

function repo(t, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-gate-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Gate Test');
  git('config', 'user.email', 'gate@example.invalid');
  const write = (path, source) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), source);
  };
  const commit = (changes, message = 'change') => {
    for (const [path, source] of Object.entries(changes)) {
      if (source === null) git('rm', '-q', path); else write(path, source);
    }
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, write, commit, base: commit(files, 'baseline') };
}

function gate(f, head, args = [], env = {}) {
  let output = '', error = '';
  const code = runComplexityGate(['--base', f.base, '--head', head, ...args], {
    cwd: f.cwd, env, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } },
  });
  return { code, output, error };
}

test('a new function passes at the limit and fails one point over, with both values and the commands', t => {
  const f = repo(t, { 'a.ts': complex('small', 1) });
  const atLimit = f.commit({ 'a.ts': complex('small', 1) + complex('atLimit', 19) });
  assert.equal(gate(f, atLimit).code, 0);

  const over = f.commit({ 'a.ts': complex('small', 1) + complex('atLimit', 19) + complex('over', 20) });
  const result = gate(f, over);
  assert.equal(result.code, 1, result.error);
  assert.match(result.output, /a\.ts:\d+ over: complexity 21 \(new function; limit 20\)/);
  assert.doesNotMatch(result.output, /atLimit/);
  assert.match(result.output, /head: node .*metrics\.mjs 'a\.ts' --function 'over' --line \d+ --breakdown/);
  assert.equal(result.output.split('\n').filter(line => /^ {6}\d+ IfStatement$/.test(line)).length, 20);
  assert.ok(result.output.includes(OWNER_NOTE));
});

test('a function over the limit may fall or stay level but not rise; crossing the limit fails', t => {
  const f = repo(t, { 'big.ts': complex('grow', 24) + complex('level', 24) + complex('lower', 24) + complex('cross', 14) });
  const head = f.commit({
    'big.ts': complex('grow', 25) + complex('level', 24, '  x += 1;\n') + complex('lower', 21) + complex('cross', 20),
  });
  const result = gate(f, head);
  assert.equal(result.code, 1);
  assert.match(result.output, /grow: complexity 26 \(was 25 at the merge base; limit 20\)/);
  assert.match(result.output, /cross: complexity 21 \(was 15 at the merge base; limit 20\)/);
  assert.doesNotMatch(result.output, /level|lower/);
  assert.match(result.output, new RegExp(`base: git show ${f.base}:big\\.ts > "\\$\\{TMPDIR:-/tmp\\}/complexity-base\\.ts" && node .*metrics\\.mjs .* --function 'grow' --line 1$`, 'm'));
  assert.match(result.output, /^2 changed functions are over/m);
});

test('a passing run names the changed functions that stay over the limit without growing', t => {
  const f = repo(t, { 'a.ts': complex('lowered', 30) + complex('level', 24) + complex('fine', 5) });
  const head = f.commit({ 'a.ts': complex('lowered', 25) + complex('level', 24, '  x += 1;\n') + complex('fine', 6) });
  const result = gate(f, head);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /^2 changed functions stay over 20 without growing\. The pre-PR check still reports them:$/m);
  assert.match(result.output, /a\.ts:\d+ lowered: complexity 26 \(was 31 at the merge base; limit 20\)/);
  assert.match(result.output, /a\.ts:\d+ level: complexity 25 \(was 25 at the merge base; limit 20\)/);
  assert.doesNotMatch(result.output, /fine/);

  const untouched = f.commit({ 'a.ts': complex('lowered', 30) + complex('level', 24) + complex('fine', 7) });
  assert.doesNotMatch(gate(f, untouched).output, /stay over/);
});

test('a long function the change does not touch never fails the change', t => {
  const f = repo(t, { 'a.ts': complex('huge', 40) + complex('tiny', 1) });
  const head = f.commit({ 'a.ts': complex('huge', 40) + complex('tiny', 2) });
  const result = gate(f, head);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Checked 1 changed functions in 1 files/);
  assert.equal(gate(f, f.commit({ 'a.ts': null })).output.startsWith('Checked 0 changed functions'), true);
});

test('the head comes from Git objects, not from the working tree or untracked files', t => {
  const f = repo(t, { 'a.ts': complex('small', 1) });
  const head = f.commit({ 'a.ts': complex('small', 1) + complex('over', 20) });
  f.write('a.ts', complex('small', 1));
  f.write('stray.ts', complex('untracked', 40));
  const result = gate(f, head);
  assert.equal(result.code, 1);
  assert.match(result.output, /over: complexity 21/);
  assert.doesNotMatch(result.output, /untracked/);
});

test('a renamed function, a moved function and a function in a renamed parent are matched to their origin', t => {
  const nested = name => `export function ${name}(x) {\n  const inner = (y) => {\n${'    if (y) { y++; }\n'.repeat(24)}    return y;\n  };\n  return inner(x);\n}\n`;
  const f = repo(t, { 'a.ts': complex('keep', 1) + complex('big', 24) + nested('outer'), 'b.ts': complex('other', 1) });
  const head = f.commit({ 'a.ts': complex('keep', 1) + complex('bigger', 24) + nested('outerRenamed') });
  const renamed = gate(f, head);
  assert.equal(renamed.code, 0, renamed.output);
  assert.match(renamed.output, /matched to a removed function: a\.ts:\d+ bigger: complexity 25 \(was 25 in a\.ts:big at the merge base/);
  assert.match(renamed.output, /inner: complexity 25 \(was 25 in a\.ts:inner/);

  const moved = f.commit({ 'a.ts': complex('keep', 1) + nested('outerRenamed'), 'b.ts': complex('other', 1) + complex('bigger', 24) });
  assert.equal(gate(f, moved).code, 0);
});

test('a function moved with edits keeps its name and is compared with the original', t => {
  const f = repo(t, { 'a.ts': complex('keep', 1) + complex('big', 24) });
  const level = f.commit({ 'a.ts': complex('keep', 1), 'b.ts': complex('big', 24, '  x += 1;\n') });
  assert.equal(gate(f, level).code, 0);
  const grown = f.commit({ 'b.ts': complex('big', 25, '  x += 1;\n') });
  const result = gate(f, grown);
  assert.equal(result.code, 1);
  assert.match(result.output, /b\.ts:\d+ big: complexity 26 \(was 25 in a\.ts:big at the merge base; limit 20\)/);
});

test('a new function is not paired with a removed function of the same name whose body it does not share', t => {
  const f = repo(t, { 'a.ts': complex('keep', 1) + complex('foo', 34) });
  const head = f.commit({ 'a.ts': complex('keep', 1), 'b.ts': unrelated('foo', 20) });
  const result = gate(f, head);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /b\.ts:\d+ foo: complexity 21 \(new function; limit 20\)/);
  assert.match(result.output, /removed these functions over 20/);
});

test('with the same name in several files, a moved function is compared with the one it shares its body with', t => {
  const f = repo(t, { 'a.ts': complex('keep', 1) + complex('run', 34), 'b.ts': unrelated('run', 20) });
  const level = f.commit({ 'a.ts': complex('keep', 1), 'b.ts': null, 'c.ts': unrelated('run', 20, '  y += 1;\n') });
  assert.equal(gate(f, level).code, 0);
  const grown = f.commit({ 'c.ts': unrelated('run', 21, '  y += 1;\n') });
  const result = gate(f, grown);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /c\.ts:\d+ run: complexity 22 \(was 21 in b\.ts:run at the merge base; limit 20\)/);
});

test('a new function with no origin lists the over-limit functions the change removed', t => {
  const f = repo(t, { 'a.ts': complex('keep', 1) + complex('big', 24) });
  const result = gate(f, f.commit({ 'a.ts': complex('keep', 1) + complex('renamed', 21, '  x += 1;\n') }));
  assert.equal(result.code, 1);
  assert.match(result.output, /renamed: complexity 22 \(new function; limit 20\)/);
  assert.match(result.output, /removed these functions over 20/);
  assert.match(result.output, /a\.ts:\d+ big \(complexity 25\)/);
});

test('same-named functions that cannot be told apart are compared with the most complex one', t => {
  const twins = (first, second) => `const a = { ${complex('f', first).replace('export function f(x)', 'f(x)')} };\nconst b = { ${complex('f', second).replace('export function f(x)', 'f(x)')} };\n`;
  const f = repo(t, { 'a.ts': twins(21, 19) });
  const grown = gate(f, f.commit({ 'a.ts': twins(22, 19) }));
  assert.equal(grown.code, 1);
  assert.match(grown.output, /complexity 23 \(was at most 22 among 2 functions with this name at the merge base/);
  const level = f.commit({ 'a.ts': twins(21, 19).replace('x++; }', 'x--; }') });
  assert.equal(gate(f, level).code, 0);
});

test('an unparseable changed file, a missing argument and an unknown revision stop the check', t => {
  const f = repo(t, { 'a.ts': complex('small', 1) });
  const broken = gate(f, f.commit({ 'broken.ts': 'function broken(' }));
  assert.equal(broken.code, 2);
  assert.match(broken.error, /broken\.ts: /);
  assert.equal(broken.output, '');
  assert.equal(runComplexityGate(['--base', f.base], { cwd: f.cwd, stderr: { write: () => {} } }), 2);
  assert.equal(gate(f, 'no-such-revision').code, 2);
});

test('--allow-growth prints the findings as warnings and passes; Actions annotations carry file and line', t => {
  const f = repo(t, { 'a.ts': complex('small', 1) });
  const head = f.commit({ 'a.ts': complex('small', 1) + complex('over', 20) });
  const approved = gate(f, head, ['--allow-growth'], { GITHUB_ACTIONS: 'true' });
  assert.equal(approved.code, 0);
  assert.match(approved.output, /over: complexity 21/);
  assert.ok(approved.output.includes('Complexity growth approved by the baseline-growth label; owner merge required.'));
  assert.ok(!approved.output.includes(OWNER_NOTE));
  assert.match(approved.output, /^::warning file=a\.ts,line=\d+,title=Function complexity::a\.ts:\d+ over: complexity 21/m);
  const failed = gate(f, head, [], { GITHUB_ACTIONS: 'true' });
  assert.match(failed.output, /^::error file=a\.ts,line=\d+,title=Function complexity::/m);
  assert.doesNotMatch(gate(f, head).output, /^::error/m, 'plain runs print no annotations');
});

test('one removed function serves one pair, so a copy of a long function is still new', () => {
  const copy = name => ({ name, complexity: 25, bodyHash: 'same', change: 'added' });
  const donor = { file: 'a.ts', name: 'big', line: 1, complexity: 25, bodyHash: 'same' };
  const [first, second] = [copy('copy'), copy('copy2')];
  const { pairs, free } = pairMoves([first, second], [donor]);
  assert.equal(pairs.get(first), donor);
  assert.equal(pairs.has(second), false);
  assert.equal(free.size, 0);
  const result = findGrowth({ files: [{ file: 'b.ts', functions: [first, second] }], removed: [donor] });
  assert.deepEqual(result.growth.map(item => item.fn.name), ['copy2']);
});

test('the script runs as a command and exits 1 when complexity grew', t => {
  const f = repo(t, { 'a.ts': complex('small', 1) });
  const head = f.commit({ 'a.ts': complex('small', 1) + complex('over', 20) });
  const script = new URL('./complexity-gate.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [script, '--base', f.base, '--head', head], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /over: complexity 21/);
});
