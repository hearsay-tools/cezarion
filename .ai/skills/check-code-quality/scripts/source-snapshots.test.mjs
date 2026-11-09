import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { nodeModulesWith } from './test-support.mjs';
import { collectCoverage } from './coverage.mjs';
import { runCheck } from './check.mjs';
import { inlineSourceMap, measurementEnabled, recordGeneratedSource } from './source-snapshots.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'quality-snapshots-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  symlinkSync(nodeModulesWith('tsx'), join(cwd, 'node_modules'), 'dir');
  const write = (file, source) => writeFileSync(join(cwd, file), source);
  write('package.json', '{"type":"module"}');
  return { cwd, write };
}

async function collect(f, files, extra = {}) {
  const directory = join(f.cwd, 'report');
  mkdirSync(directory);
  let log = '';
  let result;
  try { result = await collectCoverage({ cwd: f.cwd, runner: 'node', imports: [import.meta.resolve('tsx')],
    tests: ['source.test.ts'], projects: [], stderr: { write: value => { log += value; } }, files, ...extra }, directory); }
  catch (error) { error.message += '\n' + log; throw error; }
  return { result, report: JSON.parse(readFileSync(result.path, 'utf8')), log, directory };
}

const typed = `export function outer(value: number) {
  return function inner(other: number) {
    if (other > value) return other;
    return value;
  };
}
export function unused(value: number) {
  return function unusedInner() { return value; };
}
`;

// This goes through the public gate: exact mapped function anchors and separate
// counters must remain available for both called and uncalled nested functions.
test('Node tsx measures called and uncalled nested TypeScript and changed tests', async t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'quality@example.invalid'); git('config', 'user.name', 'Quality');
  git('add', 'package.json'); git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  f.write('source.ts', typed);
  f.write('source.test.ts', `import assert from 'node:assert/strict';
import test from 'node:test';
import { outer } from './source.ts';
function check(value: number) { assert.equal(outer(2)(value), 2); }
test('nested', () => { check(1); check(2); assert.equal(outer(2)(3), 3); });`);
  let output = '', log = '';
  const status = await runCheck(['--base', base, '--collection', JSON.stringify({ runner: 'node', tests: ['source.test.ts'], imports: ['tsx'] }), '--json'],
    { cwd: f.cwd, stdout: { write: value => { output += value; } }, stderr: { write: value => { log += value; } } });
  const report = JSON.parse(output);
  assert.equal(status, 0, log + output);
  const source = report.files.find(file => file.file === 'source.ts');
  assert.deepEqual(source.functions.map(fn => fn.coverage.percent), [100, 100, 0, 0]);
  assert.deepEqual(source.functions.map(fn => fn.coverage.calls), [3, 3, 0, 0]);
  assert.ok(report.files.find(file => file.file === 'source.test.ts').functions.every(fn => fn.coverage.percent === 100));
});

test('archive maps an emitted child after cleanup even when the child clears loader options', async t => {
  const f = fixture(t);
  f.write('source.ts', typed + 'outer(2)(3);');
  f.write('source.test.ts', `import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { recordGeneratedSource } from ${JSON.stringify(new URL('./source-snapshots.mjs', import.meta.url).href)};
const code = transformSync(readFileSync('source.ts', 'utf8'), {loader: 'ts', sourcefile: process.cwd() + '/source.ts', sourcemap: 'inline', format: 'esm'}).code;
recordGeneratedSource(pathToFileURL(process.cwd() + '/emitted.mjs').href, code);
writeFileSync('emitted.mjs', code);
const env = {...process.env}; delete env.NODE_OPTIONS;
execFileSync(process.execPath, ['emitted.mjs'], {env});
unlinkSync('emitted.mjs');`);
  const { report, directory } = await collect(f, ['source.ts']);
  assert.equal(existsSync(join(f.cwd, 'emitted.mjs')), false);
  assert.ok(readdirSync(join(directory, 'raw/sources')).length > 0);
  const entry = report[join(f.cwd, 'source.ts')];
  assert.ok(entry, JSON.stringify(report));
  assert.ok(Object.values(entry.f).includes(1));
  assert.ok(Object.values(entry.f).includes(0));
});

test('Vitest child environment captures tsx transformed child code', async t => {
  const f = fixture(t);
  f.write('source.ts', typed + 'outer(2)(3);');
  f.write('vitest.config.mjs', `export default { test: { include: ['**/*.test.js'], environment: 'node' } };`);
  f.write('source.test.js', `import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
test('child', () => { expect(execFileSync(process.execPath, ['--import', 'tsx', 'source.ts'], {encoding:'utf8'})).toBe(''); });`);
  const { report } = await collect(f, ['source.ts'], { runner: 'vitest', imports: [], tests: ['source.test.js'] });
  const entry = report[join(f.cwd, 'source.ts')];
  assert.ok(entry, JSON.stringify(report));
  assert.ok(Object.values(entry.f).includes(1));
  assert.ok(Object.values(entry.f).includes(0));
});

test('native TypeScript without an inline map stays incomplete', async t => {
  const f = fixture(t);
  f.write('source.ts', 'export function typed(value: number) { return value; }\ntyped(1);');
  f.write('source.test.ts', "import './source.ts';");
  await assert.rejects(collect(f, ['source.ts'], { imports: [] }), /Missing inline source map/);
});

test('stale emitted map contents fail after the actual child ran', async t => {
  const f = fixture(t);
  f.write('source.ts', typed);
  f.write('source.test.ts', `import { transformSync } from 'esbuild';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const code = transformSync('export function stale(value: number) { return value; }\\nstale(1);', {loader:'ts',sourcefile:process.cwd()+'/source.ts',sourcemap:'inline',format:'esm'}).code;
writeFileSync('emitted.mjs', code);
execFileSync(process.execPath, ['emitted.mjs']);
unlinkSync('emitted.mjs');`);
  await assert.rejects(collect(f, ['source.ts']), /Stale or missing mapped source content/);
});

test('two archived transforms for the same selected script stay ambiguous', async t => {
  const f = fixture(t);
  f.write('source.mjs', 'export function actual(value) { return value; }\nactual(1);');
  f.write('source.test.ts', `import { recordGeneratedSource } from ${JSON.stringify(new URL('./source-snapshots.mjs', import.meta.url).href)};
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import './source.mjs';
recordGeneratedSource(pathToFileURL(process.cwd()+'/source.mjs').href, readFileSync('source.mjs','utf8')+'\\n// second transform');`);
  await assert.rejects(collect(f, ['source.mjs']), /Ambiguous generated source snapshots/);
});

test('snapshot helper stays inert outside measurement and rejects malformed inline maps', t => {
  const previous = process.env.NODE_V8_COVERAGE;
  delete process.env.NODE_V8_COVERAGE;
  t.after(() => { if (previous !== undefined) process.env.NODE_V8_COVERAGE = previous; });
  assert.equal(measurementEnabled(), false);
  assert.equal(recordGeneratedSource('file:///does-not-exist.ts', 'anything'), undefined);
  assert.throws(() => inlineSourceMap('//# sourceMappingURL=external.map'), /inline source map/);
  assert.throws(() => inlineSourceMap('//# sourceMappingURL=data:application/json;base64,e30='), /Incomplete/);
  assert.throws(() => inlineSourceMap('//# sourceMappingURL=a\n//# sourceMappingURL=b'), /Ambiguous/);
});

test('mixed Node and Vitest collections run each test once and measure the merged inventory', async t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'quality@example.invalid'); git('config', 'user.name', 'Quality');
  git('add', 'package.json'); git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  f.write('source.ts', `export function choose(value: boolean): string {
  if (value) return 'yes';
  return 'no';
}`);
  mkdirSync(join(f.cwd, 'node'));
  f.write('node/choose.test.ts', `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { choose } from '../source.ts';
function check() { assert.equal(choose(false), 'no'); }
check(); appendFileSync('../ran.txt', 'node\\n');`);
  f.write('choose.test.js', `import { expect, test } from 'vitest';
import { appendFileSync } from 'node:fs';
import { choose } from './source.ts';
test('choose', () => { expect(choose(true)).toBe('yes'); appendFileSync('ran.txt', 'vitest\\n'); });`);
  f.write('vitest.config.mjs', `export default { test: { include: ['*.test.js'] } };`);
  let output = '', log = '';
  const args = ['--base', base, '--json', '--collection', JSON.stringify({ runner: 'node', cwd: 'node', tests: ['choose.test.ts'], imports: ['tsx'] }),
    '--collection', JSON.stringify({ runner: 'vitest', tests: ['choose.test.js'] })];
  const status = await runCheck(args, { cwd: f.cwd, stdout: {write: value => { output += value; }}, stderr: {write: value => { log += value; }} });
  const report = JSON.parse(output);
  assert.equal(status, 0, log + output);
  assert.deepEqual(readFileSync(join(f.cwd, 'ran.txt'), 'utf8').trim().split('\n').sort(), ['node', 'vitest']);
  const fn = report.files.find(file => file.file === 'source.mjs').functions[0];
  assert.equal(fn.coverage.percent, 100);
  assert.equal(fn.coverage.calls, 2);
  assert.equal(report.measurement.collections.length, 2);
  assert.equal(report.summary.functions, 3);
});

test('Vitest leaves never-loaded source absent rather than inventing default-zero coverage', async t => {
  const f = fixture(t);
  f.write('source.ts', typed);
  f.write('source.test.js', `import { test, expect } from 'vitest'; test('actual test', () => { expect(1).toBe(1); });`);
  f.write('vitest.config.mjs', `export default { test: { include: ['*.test.js'] } };`);
  const { report } = await collect(f, ['source.ts'], {runner:'vitest',imports:[],tests:['source.test.js']});
  assert.equal(report[join(f.cwd, 'source.ts')], undefined);
});

test('Vitest rejects a selected test file excluded by its project even when another test passes', async t => {
  const f = fixture(t);
  f.write('source.mjs', 'export function choose() { return 1; }');
  f.write('source.test.js', `import { test, expect } from 'vitest'; import { choose } from './source.mjs'; test('loaded', () => { expect(choose()).toBe(1); });`);
  f.write('excluded.test.js', `throw new Error('must not silently omit selected test');`);
  f.write('vitest.config.mjs', `export default { test: { include: ['source.test.js'] } };`);
  await assert.rejects(collect(f, ['source.mjs'], {runner:'vitest',imports:[],tests:['source.test.js','excluded.test.js']}), /Selected Vitest test was not selected/);
});

test('Vitest rejects assigning one selected test to two projects before executing either', async t => {
  const f = fixture(t);
  f.write('source.mjs', 'export function choose() { return 1; }');
  f.write('source.test.js', `import { test, expect } from 'vitest'; import { choose } from './source.mjs'; test('loaded', () => { expect(choose()).toBe(1); });`);
  f.write('vitest.config.mjs', `export default { test: { projects: [
  {test:{name:'one',include:['source.test.js']}}, {test:{name:'two',include:['source.test.js']}}
] } };`);
  await assert.rejects(collect(f, ['source.mjs'], {runner:'vitest',imports:[],tests:['source.test.js'],projects:['one','two']}), /Duplicate Vitest test execution/);
});

test('Vitest collection cwd can sit below the selected imported source', async t => {
  const f = fixture(t);
  f.write('source.ts', typed);
  mkdirSync(join(f.cwd, 'nested'));
  f.write('nested/source.test.ts', `import { test, expect } from 'vitest';
import { outer } from '../source.ts';
test('external selected source', () => { expect(outer(2)(1)).toBe(2); expect(outer(2)(3)).toBe(3); });`);
  f.write('nested/vitest.config.mjs', `export default { test: { include: ['source.test.ts'] } };`);
  const { report } = await collect(f, [join(f.cwd, 'source.ts')], {runner:'vitest',cwd:join(f.cwd,'nested'),imports:[],tests:['source.test.ts']});
  const entry = report[join(f.cwd, 'source.ts')];
  assert.ok(entry, JSON.stringify(report));
  assert.ok(Object.values(entry.f).includes(2));
  assert.ok(Object.values(entry.f).includes(0));
});
