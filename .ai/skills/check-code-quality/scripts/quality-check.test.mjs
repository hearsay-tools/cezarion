import { nodeModulesWith } from './test-support.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeSource } from './code-metrics.mjs';
import { runCheck } from './check.mjs';
import { convertNodeCoverage } from './coverage.mjs';
import { finishReport, markdownReport } from './quality-report.mjs';
import { thresholds } from './changed-functions.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'quality-check-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, content) => writeFileSync(join(cwd, file), content);
  git('init', '-q');
  git('config', 'user.name', 'Quality Test');
  git('config', 'user.email', 'quality@example.invalid');
  write('package.json', '{"type":"module"}');
  write('.gitignore', 'reports/\ncoverage.json\n*.test.mjs\nsetup.mjs\nnode_modules/\n');
  write('source.mjs', 'export function choose(x) { return x; }\nexport const untouched = () => 1;');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  write('source.mjs', 'export function choose(x) {\n if (x) return 1;\n return 2;\n}\nexport const untouched = () => 1;');
  write('source.test.mjs', `import assert from 'node:assert/strict';
    import { choose } from './source.mjs';
    assert.equal(choose(true), 1); assert.equal(choose(false), 2);`);
  return { cwd, base, git, write };
}

function coverage(f, file = 'source.mjs') {
  const path = join(f.cwd, file);
  const functions = analyzeSource(readFileSync(path, 'utf8'), path);
  const entry = { path, fnMap: {}, f: {}, statementMap: {}, s: {} };
  for (const [id, fn] of functions.entries()) {
    entry.fnMap[id] = { name: fn.name, loc: { start: fn.bodyLoc, end: { line: fn.bodyEndLine, column: 1 } } };
    entry.f[id] = 1;
    entry.statementMap[id] = { start: fn.bodyLoc, end: fn.bodyLoc };
    entry.s[id] = 1;
  }
  return { [path]: entry };
}

async function invoke(f, args = [], dependencies = {}) {
  let output = '', error = '';
  const code = await runCheck(['--base', f.base, '--json', ...args], {
    cwd: f.cwd, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } },
    ...dependencies,
  });
  return { code, report: JSON.parse(output), error };
}

test('groups Node tests, converts process coverage, matches changed functions and writes reports', async t => {
  const f = fixture(t);
  f.write('setup.mjs', 'globalThis.qualitySetup = true;');
  f.write('source.test.mjs', 'import { choose } from "./source.mjs"; choose(true);');
  f.write('setup.test.mjs', `import assert from "node:assert/strict";
    import { choose } from "./source.mjs";
    assert.equal(globalThis.qualitySetup, true); assert.equal(choose(false), 2);`);
  const { code, report, error } = await invoke(f, ['--runner', 'node', '--test', 'source.test.mjs',
    '--test', 'setup.test.mjs', '--node-import', 'setup.mjs', '--output', 'reports/quality.md']);
  assert.equal(code, 0, error + JSON.stringify(report));
  assert.equal(report.status, 'pass');
  assert.equal(report.base, f.base);
  assert.equal(report.summary.functions, 1);
  assert.equal(report.files[0].functions[0].name, 'choose');
  assert.equal(report.files[0].functions[0].coverage.percent, 100);
  assert.equal(report.files[0].functions[0].crap, 2);
  assert.equal(report.files[0].functions[0].baseline.complexity, 1);
  assert.equal(report.measurement.runner, 'node');
  assert.ok(report.measurement.command.includes(join(f.cwd, 'setup.test.mjs')));
  assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, 'reports/quality.json'), 'utf8')), report);
  assert.match(readFileSync(join(f.cwd, 'reports/quality.md'), 'utf8'), /Result: PASS/);
});

test('pass, exceeded and incomplete are distinct process exit codes', async t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('./check.mjs', import.meta.url));
  for (const [decisions, expected] of [[19, 0], [20, 1]]) {
    f.write('source.mjs', `export function choose(x) { ${'if (x) x--; '.repeat(decisions)} return x; }`);
    f.write('coverage.json', JSON.stringify(coverage(f)));
    const result = spawnSync(process.execPath, [cli, '--base', f.base, '--coverage', 'coverage.json', '--json'], { cwd: f.cwd, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.files[0].functions[0].complexity, decisions + 1);
  }
  const incomplete = spawnSync(process.execPath, [cli, '--base', f.base, '--json'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).status, 'incomplete');
});

test('missing, stale and unmatched coverage remain incomplete', async t => {
  const f = fixture(t);
  f.write('coverage.json', '{}');
  const absent = await invoke(f, ['--coverage', 'coverage.json']);
  assert.equal(absent.code, 2);
  assert.equal(absent.report.summary.unavailable, 1);
  const report = coverage(f);
  report[join(f.cwd, 'source.mjs')].fnMap[0].loc.start.column++;
  f.write('coverage.json', JSON.stringify(report));
  assert.equal((await invoke(f, ['--coverage', 'coverage.json'])).code, 2);
  f.write('coverage.json', JSON.stringify(coverage(f)));
  utimesSync(join(f.cwd, 'coverage.json'), new Date(0), new Date(0));
  const stale = await invoke(f, ['--coverage', 'coverage.json']);
  assert.equal(stale.code, 2);
  assert.match(stale.report.files[0].functions[0].coverage.reason, /newer/);
});

test('coverage is collected once for every changed file and temporary reports are removed', async t => {
  const f = fixture(t);
  f.write('second.mjs', 'export function second() { return 2; }');
  let calls = 0, temporary;
  const result = await invoke(f, ['--test', 'source.test.mjs'], {
    collect(options, directory) {
      calls++;
      temporary = directory;
      assert.deepEqual(options.files, ['second.mjs', 'source.mjs']);
      const path = join(directory, 'coverage-final.json');
      writeFileSync(path, JSON.stringify({ ...coverage(f), ...coverage(f, 'second.mjs') }));
      return { path, runner: 'fixture' };
    },
  });
  assert.equal(result.code, 0, JSON.stringify(result.report));
  assert.equal(calls, 1);
  assert.equal(existsSync(temporary), false);
  assert.equal(result.report.summary.functions, 2);
});

test('a source edit or new function during coverage invalidates the check', async t => {
  for (const added of [true, false]) {
    const f = fixture(t);
    let temporary;
    const result = await invoke(f, ['--test', 'source.test.mjs'], {
      collect(options, directory) {
        temporary = directory;
        const path = join(directory, 'coverage-final.json');
        writeFileSync(path, JSON.stringify(coverage(f)));
        if (added) f.write('added.mjs', 'export function added() {}');
        else f.write('source.mjs', 'export function changed() {}');
        return { path, runner: 'fixture' };
      },
    });
    assert.equal(result.code, 2);
    assert.match(result.report.errors.join(' '), /Source changed|source set/);
    assert.equal(existsSync(temporary), false);
  }
});

test('a successful collection cannot hide a missing function result', async t => {
  const f = fixture(t);
  f.write('coverage.json', JSON.stringify(coverage(f)));
  const result = await invoke(f, ['--coverage', 'coverage.json'], {
    measure: file => ({ ...file, functions: [] }),
  });
  assert.equal(result.code, 2);
  assert.equal(result.report.summary.expectedFunctions, 1);
  assert.equal(result.report.summary.functions, 0);
});

test('failing Node tests produce no accepted scores and keep logs off JSON stdout', async t => {
  const f = fixture(t);
  f.write('source.test.mjs', 'throw new Error("intentional coverage failure");');
  const result = await invoke(f, ['--runner', 'node', '--test', 'source.test.mjs']);
  assert.equal(result.code, 2);
  assert.match(result.report.errors.join(' '), /Coverage tests failed/);
  assert.match(result.error, /intentional coverage failure/);
  assert.equal(result.report.summary.functions, 0);
});

// A package with an exports map hides same-named packages in ancestor directories, so a
// stub without a `./node` export or provider entry stands for a missing install.
function fakeVitest(f, node, coverageProvider = true) {
  for (const [name, files] of [['vitest', { 'node.mjs': node ?? '' }], ['@vitest/coverage-v8', { 'index.mjs': '' }]]) {
    const directory = join(f.cwd, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    const exports = name === 'vitest' ? { './package.json': './package.json', ...(node === undefined ? {} : { './node': './node.mjs' }) }
      : coverageProvider ? { '.': './index.mjs' } : { './package.json': './package.json' };
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports }));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(directory, file), content);
  }
}

test('Vitest resolves in the target project and receives all files, tests and projects once', async t => {
  const f = fixture(t);
  f.write('second.mjs', 'export function second() { return 2; }');
  fakeVitest(f, `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    export async function createVitest(mode, options) {
      assert.equal(mode, 'test');
      assert.equal(process.cwd(), ${JSON.stringify(f.cwd)});
      assert.equal(process.env.VITEST, 'true');
      assert.deepEqual(options.project, ['unit']);
      assert.deepEqual(options.coverage.include, ['second.mjs', 'source.mjs']);
      const config = { include: ['**/*.test.mjs'], coverage: { exclude: ['**/*.test.mjs', 'custom/**'] } };
      const project = { config: { include: ['**/*.e2e.ts'], coverage: { exclude: ['**/*.e2e.ts', '**/*.test.mjs'] } } };
      return {
        config, projects: [project],
        async start(filters) {
          // Only the globs Vitest adds from test.include leave the exclusions.
          assert.deepEqual(config.coverage.exclude, ['custom/**']);
          assert.deepEqual(project.config.coverage.exclude, []);
          // Spawned Node processes inherit the worker environment and record process coverage.
          for (const { env } of [config, project.config]) assert.match(env.NODE_V8_COVERAGE, /raw$/);
          assert.deepEqual(filters, [${JSON.stringify(join(f.cwd, 'source.test.mjs'))}]);
          writeFileSync(join(options.coverage.reportsDirectory, 'coverage-final.json'), ${JSON.stringify(JSON.stringify({ ...coverage(f), ...coverage(f, 'second.mjs') }))});
          console.log('fixture vitest log');
        },
        async exit() {},
      };
    }
  `);
  const result = await invoke(f, ['--test', 'source.test.mjs', '--project', 'unit']);
  assert.equal(result.code, 0, result.error + JSON.stringify(result.report));
  assert.match(result.error, /fixture vitest log/);
  assert.equal(result.report.measurement.runner, 'vitest');
});

test('missing Vitest packages and transformed Node sources name the next step', async t => {
  const f = fixture(t);
  fakeVitest(f);
  const missing = await invoke(f, ['--test', 'source.test.mjs']);
  assert.equal(missing.code, 2);
  assert.match(missing.report.errors.join(' '), /Vitest is not installed .* Install vitest and @vitest\/coverage-v8/);
  // Node caches package metadata per path, so each install shape needs its own fixture.
  const g = fixture(t);
  fakeVitest(g, 'export function createVitest() { throw new Error("must not start"); }', false);
  const provider = await invoke(g, ['--test', 'source.test.mjs']);
  assert.match(provider.report.errors.join(' '), /@vitest\/coverage-v8 is not installed/);
  f.write('typed.ts', 'export function typed(x: string) { return x; }');
  const node = await invoke(f, ['--runner', 'node', '--test', 'source.test.mjs']);
  assert.match(node.report.errors.join(' '), /not typed\.ts\. Use --runner vitest with the --project/);
});

// A real Vitest run in a project shaped like this repository: unit and browser projects with
// their own setup, alias and include globs. Vitest itself excludes every include glob from
// coverage, so these tests prove the collector measures changed test functions anyway.
function vitestFixture(t) {
  const f = fixture(t);
  symlinkSync(nodeModulesWith('vitest'), join(f.cwd, 'node_modules'), 'dir');
  f.write('vitest.config.mjs', `import { fileURLToPath } from 'node:url';
    import { defineConfig } from 'vitest/config';
    const alias = { '#source': fileURLToPath(new URL('./source.mjs', import.meta.url)) };
    export default defineConfig({ cacheDir: 'reports/vite', test: { projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['**/*.test.js'], setupFiles: ['./setup.js'] } },
      { test: { name: 'e2e', include: ['**/*.e2e.ts'], environment: 'node' } },
    ] } });`);
  f.write('setup.js', 'globalThis.qualitySetup = true;');
  f.write('choose.test.js', `import { expect, test } from 'vitest';
    import { choose } from '#source';
    function expectChoice(value, expected) { expect(choose(value)).toBe(expected); }
    test('choose', () => { expect(globalThis.qualitySetup).toBe(true); expectChoice(true, 1); expectChoice(false, 2); });`);
  f.write('flow.e2e.ts', `import { expect, test } from 'vitest';
    import { choose } from './source.mjs';
    const pick = (value: boolean): number => choose(value);
    test('flow', () => { expect(pick(true)).toBe(1); expect(pick(false)).toBe(2); });`);
  return f;
}

const measured = report => report.files.flatMap(file => file.functions.map(fn => `${file.file}:${fn.name}:${fn.coverage.percent}`));

test('Vitest measures changed unit-test functions with the project setup and aliases', async t => {
  const f = vitestFixture(t);
  f.write('flow.e2e.ts', '');
  const result = await invoke(f, ['--test', 'choose.test.js', '--project', 'unit']);
  assert.equal(result.code, 0, result.error + JSON.stringify(result.report.errors));
  assert.deepEqual(measured(result.report), ['choose.test.js:expectChoice:100', 'choose.test.js:anonymous@4:20:100', 'source.mjs:choose:100']);
});

test('Vitest selects .e2e.ts browser tests through their project and measures them', async t => {
  const f = vitestFixture(t);
  const result = await invoke(f, ['--test', 'choose.test.js', '--test', 'flow.e2e.ts', '--project', 'unit', '--project', 'e2e']);
  assert.equal(result.code, 0, result.error + JSON.stringify(result.report.errors));
  assert.deepEqual(measured(result.report).filter(name => name.startsWith('flow.e2e.ts')),
    ['flow.e2e.ts:pick:100', 'flow.e2e.ts:anonymous@4:18:100']);
  assert.equal(result.report.summary.functions, 5);
});

// A runner mock is such a script: the selected test starts it as a separate `node` process.
test('Vitest measures functions that run only in spawned node children and merges in-process counts', async t => {
  const f = vitestFixture(t);
  f.git('checkout', '--', 'source.mjs');
  f.write('flow.e2e.ts', '');
  f.write('choose.test.js', '');
  const main = 'process.argv[1] === fileURLToPath(import.meta.url)';
  f.write('child.mjs', `import { fileURLToPath } from 'node:url';
function viaChild(value) {
  if (value) return 1;
  return 2;
}
if (${main}) process.stdout.write(String(viaChild(process.argv[2] === 'yes')));`);
  f.write('both.mjs', `import { fileURLToPath } from 'node:url';
export function twice(value) {
  if (value) return 'in-process';
  return 'child';
}
if (${main}) process.stdout.write(twice(false));`);
  f.write('spawn.test.js', `import { execFileSync } from 'node:child_process';
    import { expect, test } from 'vitest';
    import { twice } from './both.mjs';
    const run = (...args) => execFileSync(process.execPath, args, { encoding: 'utf8' });
    test('children', () => {
      expect(run('child.mjs', 'yes') + run('child.mjs', 'no')).toBe('12');
      expect(run('both.mjs')).toBe('child');
      expect(twice(true)).toBe('in-process');
    });`);
  const result = await invoke(f, ['--test', 'spawn.test.js', '--project', 'unit']);
  assert.equal(result.code, 0, result.error + JSON.stringify(result.report.errors));
  assert.deepEqual(measured(result.report).filter(name => !name.startsWith('spawn.test.js')),
    ['both.mjs:twice:100', 'child.mjs:viaChild:100']);
});

test('invalid runner arguments fail before starting tests', async t => {
  const f = fixture(t);
  for (const args of [['--runner', 'unknown'], ['--runner', 'node'],
    ['--coverage', 'coverage.json', '--test', 'source.test.mjs'],
    ['--runner', 'node', '--test', 'source.test.mjs', '--project', 'unit'],
    ['--test', 'source.test.mjs', '--node-import', 'source.test.mjs'],
    ['--test', 'source.test.mjs', '--project', ''], ['--output', 'source.mjs'],
    ['--test', 'source.mjs']]) {
    const result = await invoke(f, args, { collect: () => assert.fail('must not run tests') });
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.report.status, 'incomplete');
  }
});

test('empty supported change set passes without running tests', async t => {
  const f = fixture(t);
  f.git('checkout', '--', 'source.mjs');
  const result = await invoke(f, [], { collect: () => assert.fail('must not run tests') });
  assert.equal(result.code, 0);
  assert.equal(result.report.summary.functions, 0);
  assert.equal(result.report.summary.maxCrap, null);
});

test('Node conversion rejects missing reports and Node runner refuses transformed sources', async t => {
  const f = fixture(t);
  const raw = join(f.cwd, 'reports');
  mkdirSync(raw);
  await assert.rejects(convertNodeCoverage(raw, ['source.mjs'], f.cwd, join(raw, 'out.json')), /no V8 coverage/);
  f.write('typed.ts', 'export function typed(x: string) { return x; }');
  const result = await invoke(f, ['--runner', 'node', '--test', 'source.test.mjs']);
  assert.equal(result.code, 2);
  assert.match(result.report.errors.join(' '), /untransformed JavaScript/);
});

test('report thresholds include CRAP equality, missing coverage and escaped paths', () => {
  const fn = { name: 'choose', line: 1, column: 1, complexity: 20, crap: 30,
    coverage: { status: 'available', percent: 100 }, exceeded: [] };
  const file = { file: 'quoted|file.mjs', sourceHash: 'abc', functions: [fn] };
  const scan = { files: [file], thresholds, base: 'base', head: 'head', deletedFiles: [] };
  const pass = finishReport(scan, [file], null);
  assert.equal(pass.status, 'pass');
  assert.match(markdownReport(pass), /quoted\\\|file/);
  fn.crap = 30.01;
  fn.exceeded = ['crap'];
  assert.equal(finishReport(scan, [file], null).status, 'exceeded');
  fn.crap = null;
  fn.coverage = { status: 'unavailable', reason: 'missing' };
  assert.equal(finishReport(scan, [file], null).status, 'incomplete');
});

test('copied skill runs the complete Node coverage check outside this checkout', t => {
  const f = fixture(t);
  const skill = join(f.cwd, 'node_modules/copied-skill');
  mkdirSync(join(f.cwd, 'node_modules'));
  // A skill-local dependency install must not collide with the fixture's dependency link.
  cpSync(fileURLToPath(new URL('..', import.meta.url)), skill, {
    recursive: true, filter: source => basename(source) !== 'node_modules',
  });
  symlinkSync(nodeModulesWith('@babel/parser'), join(skill, 'node_modules'), 'dir');
  const result = spawnSync(process.execPath, [join(skill, 'scripts/check.mjs'), '--base', f.base,
    '--runner', 'node', '--test', 'source.test.mjs', '--json'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.functions, 1);
});
