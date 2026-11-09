import { nodeModulesWith } from './test-support.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { runCheck } from './check.mjs';
import { runMetrics } from './metrics.mjs';
import { nativeCoverageSource, preserveVitestSourceProvenance } from './vitest-provenance.mjs';

test('an installed provider without the provenance hook fails closed', () => {
  assert.doesNotThrow(() => preserveVitestSourceProvenance({}, '/unused'));
  assert.throws(() => preserveVitestSourceProvenance({ coverageProvider: {} }, '/unused'), /lacks remapCoverage/);
  assert.throws(() => preserveVitestSourceProvenance({ coverageProvider: { remapCoverage: true } }, '/unused'), /lacks remapCoverage/);
});

const staticImports = `import { existsSync } from 'node:fs';
import { join } from 'node:path';
`;

const functions = `export function called(name) {
  const __vite_ssr_import_99__ = { default: { existsSync } };
  return function nested() {
    const existsSync = __vite_ssr_import_99__.default["existsSync"];
    return existsSync(join(process.cwd(), name));
  };
}
export function outerOnly(name) {
  return function unusedInner() {
    return existsSync(join(process.cwd(), name));
  };
}
export function neither(name) {
  return function neverNested() {
    return existsSync(join(process.cwd(), name));
  };
}
`;

function fixture(t, native = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'quality-vitest-provenance-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  symlinkSync(nodeModulesWith('vitest'), join(cwd, 'node_modules'), 'dir');
  const write = (file, source) => writeFileSync(join(cwd, file), source);
  write('package.json', '{"type":"module"}');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'quality@example.invalid');
  git('config', 'user.name', 'Quality');
  git('add', 'package.json');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  write('source.mjs', staticImports + functions);
  write('vitest.config.mjs', `export default { test: { include: ['source.test.js'], environment: 'jsdom' } };`);
  const loadSource = native
    ? `import { createRequire } from 'node:module';
const { called, outerOnly, neither } = createRequire(import.meta.url)('./source.mjs');`
    : `import { called, outerOnly, neither } from './source.mjs';`;
  write('source.test.js', `import { expect, test } from 'vitest';
${loadSource}
test('nested native calls', () => {
  expect(called('package.json')()).toBe(true);
  expect(called('package.json')()).toBe(true);
  expect(typeof outerOnly('package.json')).toBe('function');
  expect(typeof neither).toBe('function');
});`);
  return { cwd, base };
}

function assertMeasurements(measured) {
  assert.deepEqual(measured.map(fn => [fn.name, fn.coverage.status, fn.coverage.calls, fn.coverage.percent]), [
    ['called', 'available', 2, 100],
    ['nested', 'available', 2, 100],
    ['outerOnly', 'available', 1, 100],
    ['unusedInner', 'available', 0, 0],
    ['neither', 'available', 0, 0],
    ['neverNested', 'available', 0, 0],
  ]);
  assert.ok(measured.every(fn => fn.crap !== null));
  assert.ok(measured.find(fn => fn.name === 'called').coverage.executableLines > 0);
  assert.ok(measured.find(fn => fn.name === 'nested').coverage.executableLines > 0);
}

// Vite injects named-import adapters at synthetic line-one locations in jsdom.
// The real collector must distinguish them from the original nested functions.
test('jsdom named Node imports retain called and uncalled function coverage through the changed-code gate', async t => {
  const { cwd, base } = fixture(t);
  let output = '', log = '';
  const status = await runCheck(['--base', base, '--test', 'source.test.js', '--json'], {
    cwd, stdout: { write: value => { output += value; } }, stderr: { write: value => { log += value; } },
  });
  const report = JSON.parse(output);
  assert.equal(status, 0, log + output);
  assert.equal(report.status, 'pass');
  assertMeasurements(report.files.find(file => file.file === 'source.mjs').functions);
  assert.equal(report.summary.functions, 7);
  assert.equal(report.summary.unavailable, 0);
  assert.ok(report.files.find(file => file.file === 'source.test.js').functions.every(fn => fn.coverage.calls === 1));
});

test('jsdom createRequire native imports retain nested function counters through standalone metrics', async t => {
  const { cwd } = fixture(t, true);
  let output = '', log = '';
  const status = await runMetrics(['source.mjs', '--test', 'source.test.js', '--json'], {
    cwd, stdout: { write: value => { output += value; } }, stderr: { write: value => { log += value; } },
  });
  assert.equal(status, 0, log + output);
  const report = JSON.parse(output);
  assert.equal(report.coverageSource, 'test-run');
  assertMeasurements(report.functions);
});

test('native modules loaded before precise coverage retain function-only counters', async t => {
  const { cwd } = fixture(t, true);
  writeFileSync(join(cwd, 'vitest.config.mjs'), `export default { test: {
    include: ['source.test.js'], environment: 'jsdom', execArgv: ['--import', './source.mjs'],
  } };`);
  let output = '', log = '';
  const status = await runMetrics(['source.mjs', '--test', 'source.test.js', '--json'], {
    cwd, stdout: { write: value => { output += value; } }, stderr: { write: value => { log += value; } },
  });
  assert.equal(status, 0, log + output);
  assertMeasurements(JSON.parse(output).functions);
});

test('native provenance rejects stale, ambiguous and missing snapshots from actual Node execution', t => {
  const { cwd } = fixture(t);
  const sourcePath = join(cwd, 'source.mjs');
  const url = pathToFileURL(sourcePath).href;
  const source = staticImports + functions + "called('package.json')();\n";
  const changed = source.replace("called('package.json')();", "called('package.jsox')();");
  assert.equal(changed.length, source.length);
  const raw = join(cwd, 'raw');
  mkdirSync(raw);
  writeFileSync(join(raw, 'quality-inputs.json'), JSON.stringify([sourcePath]));
  writeFileSync(sourcePath, source);
  const env = { ...process.env, NODE_V8_COVERAGE: raw };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const execute = () => execFileSync(process.execPath, ['--import', new URL('./inspector-preload.mjs', import.meta.url).href, sourcePath], {
    cwd, env, encoding: 'utf8',
  });
  execute();
  const reports = readdirSync(raw).filter(file => /^coverage-\d+-.*\.json$/.test(file));
  assert.ok(reports.length > 0);
  const coverage = reports.flatMap(file => JSON.parse(readFileSync(join(raw, file), 'utf8')).result)
    .find(script => script.url === url);
  assert.ok(coverage, 'the real process must report the selected script');
  assert.deepEqual(nativeCoverageSource(url, coverage.functions, raw), { code: source, map: undefined });
  const functionOnly = coverage.functions.filter(fn => fn.ranges[0].startOffset !== 0);
  assert.ok(functionOnly.length > 0);
  assert.equal(nativeCoverageSource(url, functionOnly, raw).code, source);

  writeFileSync(sourcePath, changed);
  assert.throws(() => nativeCoverageSource(url, coverage.functions, raw), /stale native source snapshot/);
  assert.throws(() => nativeCoverageSource(url, functionOnly, raw), /stale native source snapshot/);
  writeFileSync(sourcePath, source);
  assert.equal(nativeCoverageSource(url, coverage.functions, raw).code, source);

  writeFileSync(sourcePath, changed);
  execute();
  assert.throws(() => nativeCoverageSource(url, coverage.functions, raw), /Ambiguous native generated source snapshot/);
  assert.throws(() => nativeCoverageSource(url, functionOnly, raw), /Ambiguous native generated source snapshot/);

  rmSync(join(raw, 'sources'), { recursive: true });
  assert.throws(() => nativeCoverageSource(url, coverage.functions, raw), /Missing native generated source snapshot/);
  assert.throws(() => nativeCoverageSource(url, functionOnly, raw), /Missing native generated source snapshot/);
});

test('identical generated code cannot erase a stale-at-capture source map after original source restoration', t => {
  const { cwd } = fixture(t);
  const originalPath = join(cwd, 'original.ts');
  const emittedPath = join(cwd, 'emitted.mjs');
  const url = pathToFileURL(emittedPath).href;
  const source = 'export function actual(value: number) { return value; }\nactual(1);\n';
  const generated = transformSync(source, { loader: 'ts', sourcefile: originalPath, sourcemap: 'inline', format: 'esm' }).code;
  writeFileSync(emittedPath, generated);
  const raw = join(cwd, 'raw');
  mkdirSync(raw);
  writeFileSync(join(raw, 'quality-inputs.json'), JSON.stringify([originalPath, emittedPath]));
  const env = { ...process.env, NODE_V8_COVERAGE: raw };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const execute = () => execFileSync(process.execPath, ['--import', new URL('./inspector-preload.mjs', import.meta.url).href, emittedPath], {
    cwd, env, encoding: 'utf8',
  });

  writeFileSync(originalPath, source.replace('return value;', 'return value + 1;'));
  execute();
  writeFileSync(originalPath, source);
  execute();

  const snapshots = readdirSync(join(raw, 'sources'))
    .map(file => JSON.parse(readFileSync(join(raw, 'sources', file), 'utf8'))).filter(snapshot => snapshot.url === url);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every(snapshot => snapshot.code === generated));
  assert.equal(snapshots.filter(snapshot => snapshot.error).length, 1);
  const coverage = readdirSync(raw).filter(file => /^coverage-\d+-.*\.json$/.test(file))
    .flatMap(file => JSON.parse(readFileSync(join(raw, file), 'utf8')).result).find(script => script.url === url);
  assert.ok(coverage, 'actual emitted-code counters must exist');
  assert.throws(() => nativeCoverageSource(url, coverage.functions, raw), /Ambiguous native generated source snapshot/);
});
