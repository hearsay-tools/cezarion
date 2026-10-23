import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeSource, functionResults, measureCoverage, selectFunctions } from '../.ai/skills/check-code-quality/scripts/code-metrics.mjs';
import { runMetrics } from './metrics.mjs';

test('classic complexity counts decisions, defaults, short circuits and optional chains', () => {
  const source = `export function choose(x: any = 0) {
    if (x > 0 && x < 3) return x ? 1 : 2;
    for (let i = 0; i < 2; i++) x++;
    try { work(); } catch { recover(); }
    switch (x) { case 0: break; case 1: break; default: break; }
    x ||= 1;
    return x?.f?.();
  }`;
  assert.equal(analyzeSource(source, 'choose.ts')[0].complexity, 12);
  const loops = 'function loops(xs) { for (const x of xs) {} for (const x in xs) {} while (xs) {} do {} while (xs); }';
  assert.equal(analyzeSource(loops, 'loops.js')[0].complexity, 5);
});

test('nested functions, comments, strings and types do not add decisions to their parent', () => {
  const source = `type Result<T> = T extends string ? 1 : 2;
  function outer(x: number) {
    // if (x) while (x) {}
    const text = 'if && || ?';
    if (x) return () => x ? 1 : 2;
    return () => 0;
  }`;
  assert.deepEqual(analyzeSource(source, 'nested.ts').map(fn => fn.complexity), [2, 2, 1]);
});

test('accepts TSX, JavaScript modules and TypeScript overloads, and rejects invalid source', () => {
  assert.equal(analyzeSource('const View = ({ ok }: { ok: boolean }) => <div>{ok ? "yes" : "no"}</div>;', 'view.tsx')[0].complexity, 2);
  assert.equal(analyzeSource('module.exports = function (x) { return x ?? 0; };', 'index.cjs')[0].complexity, 2);
  assert.equal(analyzeSource('function f(x: string): string; function f(x: string) { return x; }', 'overload.ts').length, 1);
  assert.deepEqual(analyzeSource('export const value = 1;', 'constant.mts'), []);
  assert.throws(() => analyzeSource('function broken( {', 'broken.ts'), /Unexpected token/);
});

test('names methods and isolates class initialization from an enclosing function', () => {
  const source = `function make() {
    class Box {
      value = flag ? 1 : 0;
      static { if (flag) work(); }
      get size() { return this.value; }
      #adjust(x) { return x ? 1 : 0; }
      map = (x) => x && 1;
    }
    return Box;
  }`;
  assert.deepEqual(analyzeSource(source, 'box.ts').map(fn => [fn.name, fn.complexity]), [
    ['make', 1], ['Box.size', 1], ['Box.#adjust', 2], ['Box.map', 2],
  ]);
});

test('computed method keys count in their enclosing function, not the method body', () => {
  const functions = analyzeSource('function outer(x) { return { [x ? "a" : "b"]() { return 1; } }; }', 'computed.js');
  assert.deepEqual(functions.map(fn => fn.complexity), [2, 1]);
});

test('selects names, class methods and the innermost function at a line; refuses ambiguous names', () => {
  const functions = analyzeSource(`function same() {
    const inner = () => 1;
  }
  class Box { same() {} }`, 'names.ts');
  assert.equal(selectFunctions(functions, { line: 2 })[0].name, 'inner');
  assert.equal(selectFunctions(functions, { name: 'Box.same' })[0].line, 4);
  assert.equal(selectFunctions(functions, { name: 'same', line: 1 })[0].line, 1);
  assert.throws(() => selectFunctions(functions, { name: 'same' }), /Several functions.*--line/);
  assert.throws(() => selectFunctions(functions, { line: 9 }), /No function matches/);
  assert.throws(() => selectFunctions(functions, { name: 'missing' }), /No function matches/);
});

function coverageFor(source, functions, statements, calls = {}) {
  const point = marker => {
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `fixture marker exists: ${marker}`);
    const before = source.slice(0, at).split('\n');
    return { line: before.length, column: before.at(-1).length };
  };
  return {
    fnMap: Object.fromEntries(functions.map((fn, i) => [i, { name: fn.name, loc: { start: { ...fn.bodyLoc }, end: { line: fn.bodyEndLine, column: null } } }])),
    f: Object.fromEntries(functions.map((fn, i) => [i, calls[fn.name] ?? 1])),
    statementMap: Object.fromEntries(statements.map(([marker], i) => [i, { start: point(marker) }])),
    s: Object.fromEntries(statements.map(([, count], i) => [i, count])),
  };
}

test('coverage excludes declarations and nested bodies, including an uncalled inline arrow', () => {
  const source = `export const unused = () => 0;
  function parent(x) {
    const child = () => { if (x) return 1; return 0; };
    if (x) return child();
    return 2;
  }`;
  const functions = analyzeSource(source, 'coverage.ts');
  const entry = coverageFor(source, functions, [
    ['unused =', 1], ['0;', 0], ['child =', 1], ['if (x) return 1', 0],
    ['return 1', 0], ['return 0', 0], ['if (x) return child', 1], ['return 2', 1],
  ], { unused: 0, child: 0 });
  const result = functionResults(functions, measureCoverage(source, functions, entry));
  assert.deepEqual(result.map(fn => [fn.name, fn.coverage.percent, fn.crap]), [
    ['unused', 0, 2], ['parent', 100, 2], ['child', 0, 6],
  ]);
});

test('CRAP uses unrounded per-function line counts and handles empty bodies by call count', () => {
  const source = 'function partial(x) {\n if (x) return 1;\n return 2;\n}\nfunction empty() {}';
  const functions = analyzeSource(source, 'partial.js');
  const entry = coverageFor(source, functions, [['if (x)', 1], ['return 1', 1], ['return 2', 0]], { empty: 0 });
  const results = functionResults(functions, measureCoverage(source, functions, entry));
  assert.equal(results[0].coverage.percent, 50);
  assert.equal(results[0].crap, 2.5);
  assert.deepEqual(results[0].coverage.uncoveredLines, [3]);
  assert.equal(results[1].crap, 2);
  entry.f['1'] = 1;
  assert.equal(functionResults(functions, measureCoverage(source, functions, entry))[1].crap, 1);
});

test('class initialization does not reduce the enclosing function body coverage', () => {
  const source = 'function factory() {\n class Box { value = flag ? 1 : 0; }\n return Box;\n}';
  const functions = analyzeSource(source, 'class.js');
  const entry = coverageFor(source, functions, [['class Box', 1], ['flag ?', 0], ['return Box', 1]]);
  const result = functionResults(functions, measureCoverage(source, functions, entry))[0];
  assert.equal(result.coverage.percent, 100);
  assert.equal(result.crap, 1);
});

test('missing, ambiguous or inconsistent function coverage stays unavailable', () => {
  const source = 'const fn = () => 1;';
  const functions = analyzeSource(source, 'fn.js');
  const entry = coverageFor(source, functions, [['1;', 1]]);
  const missing = functionResults(functions);
  assert.equal(missing[0].crap, null);
  assert.equal(missing[0].coverage.status, 'unavailable');
  entry.fnMap['0'].loc.start.column++;
  assert.equal(functionResults(functions, measureCoverage(source, functions, entry))[0].crap, null);
  entry.fnMap['0'].loc.start.column--;
  entry.fnMap['1'] = entry.fnMap['0'];
  assert.equal(functionResults(functions, measureCoverage(source, functions, entry))[0].crap, null);
  delete entry.fnMap['1'];
  entry.f['0'] = 0;
  assert.equal(functionResults(functions, measureCoverage(source, functions, entry))[0].crap, null);
});

test('rejects malformed reports and invalid counters or source positions', () => {
  const source = 'function fn() { return 1; }';
  const functions = analyzeSource(source, 'fn.js');
  assert.throws(() => measureCoverage(source, functions, {}), /coverage-final.json/);
  for (const invalid of [
    entry => { entry.s['0'] = -1; },
    entry => { entry.f['0'] = '1'; },
    entry => { entry.statementMap['0'].start.line = 999; },
    entry => { entry.statementMap['0'].start.column = 999; },
  ]) {
    const entry = coverageFor(source, functions, [['return 1', 1]]);
    invalid(entry);
    assert.throws(() => measureCoverage(source, functions, entry), /Invalid|outside the source/);
  }
});

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-metrics-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'source.ts');
  const source = 'export function choose(x: boolean) {\n if (x) return 1;\n return 2;\n}';
  writeFileSync(file, source);
  const entry = coverageFor(source, analyzeSource(source, file), [['if (x)', 1], ['return 1', 1], ['return 2', 0]]);
  const report = { [file]: entry };
  return { cwd, file, source, report };
}

async function invoke(args, options = {}) {
  let output = '', error = '';
  const code = await runMetrics(args, {
    stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } }, ...options,
  });
  return { code, output, error };
}

test('CLI reads explicit or discovered coverage and retains null when the file is absent', async t => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, 'coverage'));
  const report = join(f.cwd, 'coverage/coverage-final.json');
  writeFileSync(report, JSON.stringify(f.report));
  const discovered = await invoke(['source.ts', '--json'], { cwd: f.cwd });
  assert.equal(discovered.code, 0, discovered.error);
  assert.equal(JSON.parse(discovered.output).functions[0].crap, 2.5);
  const explicit = await invoke(['source.ts', '--function', 'choose', '--coverage', report], { cwd: f.cwd });
  assert.equal(explicit.code, 0, explicit.error);
  assert.match(explicit.output, /50\.00%\s+2\.50/);
  writeFileSync(report, '{}');
  const missing = await invoke(['source.ts', '--coverage', report, '--json'], { cwd: f.cwd });
  assert.equal(JSON.parse(missing.output).functions[0].crap, null);
  assert.match(JSON.parse(missing.output).functions[0].coverage.reason, /absent/);
});

test('CLI refuses older coverage instead of showing stale scores', async t => {
  const f = fixture(t);
  const report = join(f.cwd, 'report.json');
  writeFileSync(report, JSON.stringify(f.report));
  utimesSync(report, new Date(0), new Date(0));
  const result = await invoke(['source.ts', '--coverage', report, '--json'], { cwd: f.cwd });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.output).functions[0].crap, null);
  assert.match(JSON.parse(result.output).functions[0].coverage.reason, /newer/);
});

test('CLI validates selection and arguments before running tests', async t => {
  const f = fixture(t);
  for (const args of [[], ['source.ts', 'extra.ts'], ['source.ts', '--line', '0'],
    ['source.ts', '--line', '1.5'], ['source.ts', '--function', ''],
    ['source.ts', '--function', 'absent', '--test', 'unused.test.ts'],
    ['source.ts', '--coverage', 'report.json', '--test', 'unused.test.ts'], ['source.ts', '--unknown'],
    ['source.ts', '--test', '.'], ['source.ts', '--test', 'source.ts']]) {
    const result = await invoke([...args, '--json'], { cwd: f.cwd, runTests: () => assert.fail('tests must not run') });
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.ok(JSON.parse(result.output).error);
  }
});

test('project selection requires tests and supplies target cwd to the coverage runner', async t => {
  const f = fixture(t);
  for (const args of [['--project', 'unit'], ['--project', '', '--test', 'source.spec.ts']]) {
    assert.equal((await invoke(['source.ts', '--json', ...args], { cwd: f.cwd })).code, 1);
  }
  writeFileSync(join(f.cwd, 'source.spec.ts'), '');
  const result = await invoke(['source.ts', '--test', 'source.spec.ts', '--project', 'unit', '--project', 'client', '--json'], {
    cwd: f.cwd,
    runTests(file, tests, directory, stderr, context) {
      assert.deepEqual(context, { cwd: f.cwd, projects: ['unit', 'client'] });
      assert.deepEqual(tests, [join(f.cwd, 'source.spec.ts')]);
      const report = join(directory, 'coverage-final.json');
      writeFileSync(report, JSON.stringify(f.report));
      return report;
    },
  });
  assert.equal(result.code, 0, result.error);
});

test('coverage resolves Vitest from the target project and keeps its output off JSON stdout', async t => {
  const f = fixture(t);
  const vitest = join(f.cwd, 'node_modules/vitest');
  mkdirSync(vitest, { recursive: true });
  writeFileSync(join(vitest, 'package.json'), JSON.stringify({ name: 'vitest', version: '1.0.0' }));
  writeFileSync(join(f.cwd, 'source.test.ts'), '');
  writeFileSync(join(vitest, 'vitest.mjs'), `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    assert.equal(process.cwd(), ${JSON.stringify(f.cwd)});
    const args = process.argv.slice(2);
    assert.equal(args[0], 'run');
    assert.equal(args[args.indexOf('--project') + 1], 'custom-unit');
    assert.ok(args.includes(${JSON.stringify(join(f.cwd, 'source.test.ts'))}));
    const directory = args[args.indexOf('--coverage.reportsDirectory') + 1];
    writeFileSync(join(directory, 'coverage-final.json'), ${JSON.stringify(JSON.stringify(f.report))});
    console.log('coverage fixture output');
  `);
  const result = await invoke(['source.ts', '--test', 'source.test.ts', '--project', 'custom-unit', '--json'], { cwd: f.cwd });
  assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(result.output).functions[0].crap, 2.5);
  assert.match(result.error, /coverage fixture output/);
});

test('copied skill needs no original checkout scripts to analyze another project', t => {
  const f = fixture(t);
  const skill = join(f.cwd, 'copied-skill');
  cpSync(fileURLToPath(new URL('../.ai/skills/check-code-quality', import.meta.url)), skill, { recursive: true });
  // Supply only the dependency tree. Every tool source must come from the copy.
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(skill, 'node_modules'), 'dir');
  const output = execFileSync(process.execPath, [join(skill, 'scripts/metrics.mjs'), f.file, '--json'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(JSON.parse(output).functions[0].complexity, 2);
});

test('fresh coverage selects supplied tests and removes temporary reports on success', async t => {
  const f = fixture(t);
  const testFile = join(f.cwd, 'source.test.ts');
  writeFileSync(testFile, '');
  let temporary;
  const result = await invoke(['source.ts', '--test', testFile, '--test', testFile, '--line', '2', '--json'], {
    cwd: f.cwd,
    runTests(file, tests, directory, stderr) {
      assert.equal(file, f.file);
      assert.deepEqual(tests, [testFile, testFile]);
      temporary = directory;
      stderr.write('test log\n');
      const report = join(directory, 'coverage-final.json');
      writeFileSync(report, JSON.stringify(f.report));
      return report;
    },
  });
  assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(result.output).functions[0].crap, 2.5);
  assert.equal(JSON.parse(result.output).coverageSource, 'test-run');
  assert.equal(result.error, 'test log\n');
  assert.equal(existsSync(temporary), false);
});

test('failed test runs and source changes produce no scores and clean temporary reports', async t => {
  for (const changed of [false, true]) {
    const f = fixture(t);
    const testFile = join(f.cwd, 'source.test.ts');
    writeFileSync(testFile, '');
    let temporary;
    const result = await invoke(['source.ts', '--test', testFile, '--json'], {
      cwd: f.cwd,
      runTests(file, tests, directory) {
        temporary = directory;
        if (!changed) throw new Error('Coverage tests failed');
        writeFileSync(file, f.source + '\n// changed');
        return join(directory, 'coverage-final.json');
      },
    });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.output).error, changed ? /Source changed/ : /tests failed/);
    assert.equal(existsSync(temporary), false);
  }
});

test('the real CLI emits JSON for a source file outside the checkout', t => {
  const f = fixture(t);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cli = fileURLToPath(new URL('./metrics.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, f.file, '--function', 'choose', '--json'], { cwd: root, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.file, f.file);
  assert.equal(result.functions.length, 1);
  assert.equal(result.functions[0].complexity, 2);
  assert.equal(result.functions[0].crap, null);
});
