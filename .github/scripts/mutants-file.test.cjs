'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('./mutants-file.cjs');
const root = path.resolve(__dirname, '../..');
const mutant = (overrides = {}) => ({ status: 'Survived', mutator: 'StringLiteral', original: "'hello'", replacement: "''", function: 'guard', kind: 'Value', ...overrides });

function checkKind(mutator, original, replacement, expected, file = 'x.ts', status = 'Survived') {
  assert.equal(m.kindOf(mutant({ mutator, original, replacement, status }), file), expected);
}

test('kind precedence and every mutator family, including unlisted Value mutators', () => {
  checkKind('StringLiteral', 'flex gap-2', '', 'Class name', 'x.tsx', 'NoCoverage');
  checkKind('StringLiteral', "'flex gap-2 md:hover:bg-red-500'", '', 'Class name', 'x.tsx');
  checkKind('StringLiteral', 'flex gap-2', '', 'Text');
  checkKind('StringLiteral', "'Delete this branch'", '', 'Text', 'x.tsx');
  checkKind('StringLiteral', 'token', '', 'Value');
  checkKind('EqualityOperator', 'a < b', 'a >= b', 'Boundary');
  checkKind('EqualityOperator', 'a === b', 'a !== b', 'Condition');
  checkKind('EqualityOperator', 'a === (b >= c)', 'a !== (b >= c)', 'Condition');
  checkKind('EqualityOperator', 'a < b', 'a <= b', 'Boundary');
  checkKind('EqualityOperator', 'a <= b', 'a >= b', 'Boundary');
  checkKind('StringLiteral', 'prose text', '', 'Text', 'x.tsx', 'NoCoverage');
  checkKind('OptionalChaining', 'a?.b', 'a.b', 'Fallback');
  checkKind('LogicalOperator', 'a ?? b', 'a && b', 'Fallback');
  for (const name of ['ConditionalExpression', 'LogicalOperator', 'BooleanLiteral']) checkKind(name, 'x', 'y', 'Condition');
  for (const name of ['BlockStatement', 'CallExpression', 'ArrowFunction', 'MethodExpression']) checkKind(name, 'x', '', 'Removed call');
  for (const name of ['ObjectLiteral', 'ArrayDeclaration', 'Regex', 'UnaryOperator', 'UpdateOperator', 'AssignmentOperator', 'ArithmeticOperator']) checkKind(name, 'x', 'y', 'Value');
});

test('ast-grep assigns nested names, methods, anonymous callbacks, and module code', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-functions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.ts');
  const source = [
    'const moduleValue = 1;',
    'function outer() {',
    '  const nested = () => 2;',
    '  [1].map(() => 3);',
    '}',
    'class Example {',
    '  async method() { return 4; }',
    '}',
    'const expression = function () { return 5; };',
    'const arrow = () => 6;',
  ].join('\n');
  fs.writeFileSync(file, source);
  const ranges = m.functionRanges(file, root);
  const at = line => m.functionOf({ start: { line, column: 20 } }, ranges);
  assert.equal(at(1), '(module)');
  assert.equal(at(2), 'outer');
  assert.equal(at(3), 'nested');
  assert.equal(at(4), 'outer');
  assert.equal(at(7), 'Example.method');
  assert.equal(at(9), 'expression');
  assert.equal(at(10), 'arrow');
});

test('targets have the 33 baseline paths, derived tiers, and eight guard groups', () => {
  const targets = require('../mutants/targets.json');
  assert.equal(Object.keys(targets).length, 33);
  for (const [file, target] of Object.entries(targets)) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
    assert.equal(target.tier, file.startsWith('packages/web/') && file.endsWith('.tsx') ? 'component' : 'logic');
  }
  assert.equal(Object.values(targets).filter(t => t.guards.length).length, 8);
  assert.deepEqual(m.tierOf('packages/web/src/new.tsx', {}), { tier: 'component', guards: [] });
  assert.deepEqual(m.tierOf('packages/contract/src/new.ts', {}), { tier: 'logic', guards: [] });
});

test('scores exclude errors and ignored rows; timeout detects; empty counts score 100', () => {
  const counts = m.countsOf(['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'].map(status => mutant({ status })));
  assert.deepEqual(counts, { killed: 1, timeout: 1, survived: 1, noCoverage: 1, error: 2, ignored: 1 });
  assert.equal(m.scoreOf(counts), 50);
  assert.equal(m.scoreOf(m.countsOf([])), 100);
  assert.throws(() => m.countsOf([mutant({ status: 'unknown' })]), /Unknown/);
});

test('target evaluation counts guard text, omits classes, and fails missing guards', () => {
  const rows = [mutant({ status: 'Killed' }), mutant({ kind: 'Text', function: 'other' }), mutant({ kind: 'Class name' }), mutant({ kind: 'Text' })];
  const result = m.evaluate(rows, { tier: 'logic', guards: ['guard', 'missing'] }, [{ name: 'guard' }]);
  assert.equal(result.score, 50);
  assert.equal(result.rawScore, 25);
  assert.equal(result.survivors.length, 1);
  assert.equal(result.guards[0].survivors.length, 1);
  assert.equal(result.guards[1].found, false);
  assert.deepEqual(result.targets.map(t => t.pass), [false, true, false, false]);
});

test('logic needs covered lines and 85 percent; components need 75 percent', () => {
  const rows = Array.from({ length: 3 }, () => mutant({ status: 'Killed' })).concat(mutant({ status: 'NoCoverage', kind: 'Not covered' }));
  assert.deepEqual(m.evaluate(rows, { tier: 'logic', guards: [] }, []).targets.map(t => t.pass), [false, false]);
  assert.equal(m.evaluate(rows, { tier: 'component', guards: [] }, []).targets[0].pass, true);
  const eightyFive = Array.from({ length: 20 }, (_, i) => mutant({ status: i < 17 ? 'Killed' : 'Survived' }));
  assert.equal(m.evaluate(eightyFive, { tier: 'logic', guards: [] }, []).targets[0].pass, true);
});

test('comparison ignores line movement, reports changed survivors and counts', () => {
  const before = { version: 1, file: 'x.ts', ...m.evaluate([mutant({ original: 'a b', line: 1 }), mutant({ original: 'removed' })], { tier: 'logic', guards: [] }, []) };
  const after = { version: 1, file: 'x.ts', ...m.evaluate([mutant({ original: 'a b', line: 20 }), mutant({ original: 'added' }), mutant({ status: 'Killed' })], { tier: 'logic', guards: [] }, []) };
  const delta = m.compareResults(before, after);
  assert.equal(delta.added[0].original, 'added');
  assert.equal(delta.removed[0].original, 'removed');
  assert.equal(delta.counts.killed, 1);
  assert.ok(delta.score > 33);
  assert.throws(() => m.compareResults(before, { ...after, file: 'y.ts' }), /same/);
});

const { EventEmitter } = require('node:events');
const location = (line = 1) => ({ start: { line, column: 1 }, end: { line, column: 5 } });
const wireMutant = (status = 'Survived', overrides = {}) => ({ id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', location: location(), status, ...overrides });
const report = (file, mutants = [wireMutant()]) => ({ files: { [file]: { source: 'true\n', mutants } } });

function fakeDeps(file = 'packages/contract/src/sample.ts') {
  const calls = [];
  const deps = {
    git: (args, cwd) => { calls.push(['git', ...args]); return args[0] === 'rev-parse' ? 'abcdef\n' : 'packages/cezar/src/sample.test.ts\n'; },
    scratch: () => '/cache/scratch',
    command: async (bin, args) => { calls.push([bin, ...args]); },
    stryker: async (...args) => { calls.push(['stryker', args[0], args[3]]); return { outcome: 'exited', code: 0 }; },
    readReport: () => report(file), reset: cwd => calls.push(['reset', cwd]), removeReport: () => calls.push(['remove-report']),
    ranges: () => [], read: file => file.endsWith('equivalent.json') ? '[]' : "import { x } from '@open-mercato/cezar-contract/sample';",
    readJson: () => ({ vitest: { configFile: 'vitest.stryker.config.ts', pool: 'forks' }, reporters: ['json'], inPlace: true, timeoutMS: 30000 }), write: (file, text) => calls.push(['write', file, text]),
    removeScratch: () => calls.push(['remove-scratch']), log: text => calls.push(['log', text]),
  };
  return { deps, calls };
}

test('uncovered classes stay excluded; uncovered guard prose counts against its guard', () => {
  const classRow = mutant({ status: 'NoCoverage', original: 'flex gap-2' });
  classRow.kind = m.kindOf(classRow, 'file.tsx');
  const prose = mutant({ status: 'NoCoverage', original: 'refuse this action' });
  prose.kind = m.kindOf(prose, 'file.tsx');
  const result = m.evaluate([classRow, prose], { tier: 'component', guards: ['guard'] }, [{ name: 'guard' }]);
  assert.equal(m.evaluate([classRow], { tier: 'component', guards: [] }, []).score, 100);
  assert.equal(result.counts.noCoverage, 1);
  assert.equal(result.guards[0].survivors.length, 1);
  assert.equal(result.guards[0].pass, false);
});

test('arguments accept contract tests and reject invalid options before creating a worktree', () => {
  assert.deepEqual(m.parseArgs(['packages/contract/src/a.ts', '--tests', 'one', 'two', '--concurrency', '8']).tests, ['one', 'two']);
  assert.equal(m.parseArgs(['packages/cezar/src/a.ts']).concurrency, 4);
  for (const args of [[], ['../x.ts'], ['packages/cezar/src/a.ts', '--tests', 'x'], ['packages/contract/src/a.ts', '--tests'], ['packages/cezar/src/a.ts', '--out'], ['packages/cezar/src/a.ts', '--bad', 'x'], ['packages/cezar/src/a.ts', '--concurrency', '9']]) assert.throws(() => m.parseArgs(args));
});

test('direct consumers include package subpaths, relative js and ts imports, and explicit tests', () => {
  const file = 'packages/contract/src/sample.ts';
  const files = ['packages/cezar/src/a.test.ts', 'packages/web/src/b.test.tsx', 'packages/cezar/src/c.test.ts', 'packages/cezar/src/d.test.ts', 'packages/contract/src/e.test.ts'];
  const sources = ["import {x} from '@open-mercato/cezar-contract/sample'", "import {x} from '@open-mercato/cezar-api-client/contract/sample'", "import {x} from '../../contract/src/sample.js'", "import {x} from './other'", ''];
  assert.deepEqual(m.consumerTests(file, files, f => sources[files.indexOf(f)], [files[3]]), files.slice(0, 4).sort());
  assert.equal(m.importsModule("const x = import('../../contract/src/sample.ts')", files[0], file), true);
  assert.equal(m.importsModule("import {x} from '@open-mercato/cezar-contract/sample-other'", files[0], file), false);
  assert.throws(() => m.consumerTests(file, files, () => '', ['outside.test.ts']), /committed/);
  const config = m.consumerConfig(files.slice(0, 2));
  assert.match(config, /\.\.\.cezarConfig/);
  assert.match(config, /\.\.\.webConfig/);
  assert.match(config, /src\/a.test.ts/);
});

test('merge uses location, mutator and replacement, with detected statuses winning', () => {
  const file = 'x.ts';
  const first = report(file, [wireMutant('NoCoverage'), wireMutant('Timeout', { location: location(2) }), wireMutant('Survived', { location: location(3) })]);
  const second = report(file, [wireMutant('Survived'), wireMutant('Survived', { location: location(2) }), wireMutant('Killed', { location: location(3) })]);
  assert.deepEqual(m.mergeReports(first, second, file).files[file].mutants.map(m => m.status), ['Survived', 'Timeout', 'Killed']);
  assert.throws(() => m.mergeReports(first, { files: {} }, file), /does not contain/);
  assert.throws(() => m.mergeReports(first, { files: { [file]: { source: 'different' } } }, file), /different source/);
});

test('command installs, builds, measures own tests then consumers, writes versioned output, and removes worktree', async () => {
  const { deps, calls } = fakeDeps();
  const opts = m.parseArgs(['packages/contract/src/sample.ts', '--out', '/tmp/result.json']);
  const result = await m.runMeasurement(opts, deps);
  assert.equal(result.version, 1);
  assert.equal(result.head, 'abcdef');
  assert.deepEqual(calls.filter(c => ['pnpm', 'npm'].includes(c[0])), [['pnpm', 'install', '--frozen-lockfile'], ['npm', 'run', 'build:server']]);
  const runs = calls.filter(c => c[0] === 'stryker');
  assert.equal(runs.length, 2);
  assert.equal(runs[0][1], 'contract');
  assert.equal(runs[0][2].cwd, '/cache/scratch');
  assert.deepEqual(runs[0][2].extraArgs, ['--concurrency', '4']);
  assert.deepEqual(runs[1][2].extraArgs.slice(2), ['stryker.mutants-consumers.config.json']);
  assert.ok(calls.find(c => c[0] === 'write' && c[1] === '/tmp/result.json'));
  const configWrite = calls.find(c => c[0] === 'write' && c[1].endsWith('stryker.mutants-consumers.config.json'));
  assert.deepEqual(JSON.parse(configWrite[2]), { ...deps.readJson(), vitest: { pool: 'forks', configFile: 'vitest.mutants-consumers.config.ts' } });
  assert.deepEqual(calls.slice(-3), [['git', 'worktree', 'remove', '--force', '/cache/scratch'], ['git', 'worktree', 'prune'], ['remove-scratch']]);
  assert.match(m.summary(result), /FAIL: logic score/);
});

test('non-contract run uses its own package; no consumers means no second contract run', async () => {
  const file = 'packages/cezar/src/sample.ts';
  const a = fakeDeps(file);
  await m.runMeasurement(m.parseArgs([file]), a.deps);
  assert.deepEqual(a.calls.filter(c => c[0] === 'stryker').map(c => c[1]), ['cezar']);
  const b = fakeDeps();
  b.deps.read = () => '';
  await m.runMeasurement(m.parseArgs(['packages/contract/src/sample.ts']), b.deps);
  assert.equal(b.calls.filter(c => c[0] === 'stryker').length, 1);
});

test('install, build, Stryker and report failures all remove then prune', async () => {
  for (const stage of ['install', 'build:server', 'stryker', 'report']) {
    const { deps, calls } = fakeDeps();
    deps.command = async (bin, args) => { if (args.includes(stage)) throw new Error(stage); };
    if (stage === 'stryker') deps.stryker = async () => ({ outcome: 'exited', code: 1 });
    if (stage === 'report') deps.readReport = () => { throw new Error('report'); };
    await assert.rejects(m.runMeasurement(m.parseArgs(['packages/contract/src/sample.ts']), deps));
    assert.deepEqual(calls.slice(-3), [['git', 'worktree', 'remove', '--force', '/cache/scratch'], ['git', 'worktree', 'prune'], ['remove-scratch']]);
  }
});

test('SIGINT and SIGTERM stop Stryker group before worktree removal and return signal codes', async () => {
  const { runStryker } = require('./mutants-run.cjs');
  for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const { deps, calls } = fakeDeps();
    const events = new EventEmitter();
    const child = new EventEmitter();
    child.pid = 321;
    let exited = false;
    deps.stryker = (project, mutate, ms, options) => runStryker(project, mutate, ms, { ...options,
      spawn: () => { queueMicrotask(() => events.emit(signal)); return child; },
      kill: (pid, name) => { calls.push(['kill', pid, name]); if (!exited) { exited = true; queueMicrotask(() => child.emit('exit', null)); } },
    });
    assert.equal(await m.cli(['packages/contract/src/sample.ts'], deps, events), expected);
    const stopped = calls.findIndex(c => c[0] === 'kill');
    const removed = calls.findIndex(c => c[1] === 'worktree' && c[2] === 'remove');
    assert.ok(stopped >= 0 && removed > stopped);
    assert.deepEqual(calls[stopped], ['kill', -321, 'SIGKILL']);
    assert.equal(events.listenerCount(signal), 0);
  }
});

test('signal during setup cleans after the command settles, before starting Stryker', async () => {
  const { deps, calls } = fakeDeps();
  const events = new EventEmitter();
  deps.command = async (bin, args, cwd, signal) => { events.emit('SIGINT'); signal.throwIfAborted(); };
  assert.equal(await m.cli(['packages/contract/src/sample.ts'], deps, events), 130);
  assert.equal(calls.some(c => c[0] === 'stryker'), false);
  assert.equal(calls.at(-2)[2], 'prune');
});

test('measurement records source slices, function names and raw counts; compare is printed', () => {
  const file = 'packages/contract/src/sample.ts';
  const data = m.measure(report(file), file, 'sha', [{ name: 'named', range: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 } } }], {});
  assert.equal(data.mutants[0].original, 'true');
  assert.equal(data.mutants[0].function, 'named');
  data.comparison = m.compareResults(data, data);
  assert.match(m.summary(data), /Change:/);
  assert.throws(() => m.measure({ files: {} }, file, 'sha', []), /does not contain/);
});


test('qualified guard names find actual methods without matching another class', () => {
  const targets = require('../mutants/targets.json');
  for (const file of ['packages/cezar/src/preview/host.ts', 'packages/cezar/src/automations/scheduler.ts']) {
    const names = m.functionRanges(file, root).map(r => r.name);
    for (const guard of targets[file].guards) assert.ok(names.includes(guard), guard);
  }
  const target = { tier: 'logic', guards: ['One.check'] };
  const result = m.evaluate([mutant({ function: 'Two.check' })], target, [{ name: 'One.check' }]);
  assert.equal(result.guards[0].pass, true);
});


test('runStryker passes the config as a positional argument and keeps cwd and project', async () => {
  const { runStryker } = require('./mutants-run.cjs');
  const child = new EventEmitter();
  child.pid = 123;
  let emitted;
  await runStryker('contract', ['packages/contract/src/sample.ts'], 1000, {
    cwd: '/cache/tree', extraArgs: ['--concurrency', '4', 'stryker.mutants-consumers.config.json'],
    spawn: (bin, argv, options) => { emitted = { bin, argv, options }; queueMicrotask(() => child.emit('exit', 0)); return child; },
    kill: () => {},
  });
  assert.deepEqual(emitted.argv, ['run', '--mutate', 'packages/contract/src/sample.ts', '--concurrency', '4', 'stryker.mutants-consumers.config.json']);
  assert.equal(emitted.options.cwd, '/cache/tree');
  assert.equal(emitted.options.env.STRYKER_PROJECT, 'contract');
  assert.equal(emitted.options.detached, true);
});


const equivalentEntry = (overrides = {}) => ({ file: 'packages/contract/src/sample.ts', function: '(module)', mutator: 'BooleanLiteral', original: 'true', replacement: 'false', reason: 'fixture equivalence', ...overrides });

test('equivalents use full function identity, leave raw scores intact, and report only this file stale entries', () => {
  const file = 'packages/contract/src/sample.ts';
  const entries = [equivalentEntry(), equivalentEntry({ function: 'other' }), equivalentEntry({ file: 'packages/contract/src/other.ts' })];
  const result = m.measure(report(file), file, 'sha', [], {}, entries);
  assert.equal(result.equivalentCount, 1);
  assert.equal(result.mutants.length, 0);
  assert.equal(result.survivors.length, 0);
  assert.equal(result.counts.survived, 0);
  assert.equal(result.score, 100);
  assert.equal(result.rawScore, 0);
  assert.equal(result.rawCounts.survived, 1);
  assert.deepEqual(result.staleEquivalent, [entries[1]]);
  assert.match(m.summary(result), /Equivalent mutants excluded: 1/);
});

test('a matched guard equivalent passes its guard; same source in another function is not excluded', () => {
  const file = 'packages/contract/src/sample.ts';
  const ranges = [{ name: 'guard', range: { start: { line: 0, column: 0 }, end: { line: 1, column: 0 } } }];
  const targets = { [file]: { tier: 'logic', guards: ['guard'] } };
  const entry = equivalentEntry({ function: 'guard' });
  assert.equal(m.measure(report(file), file, 'sha', ranges, targets, [entry]).guards[0].pass, true);
  const other = m.measure(report(file), file, 'sha', ranges, targets, [equivalentEntry()]);
  assert.equal(other.equivalentCount, 0);
  assert.equal(other.guards[0].pass, false);
});

test('command keeps missing and empty equivalent lists behavior and warns on invalid lists', async () => {
  const file = 'packages/contract/src/sample.ts';
  const run = async contents => {
    const { deps } = fakeDeps(file);
    deps.read = name => {
      if (!name.endsWith('equivalent.json')) return '';
      if (contents === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return contents;
    };
    return m.runMeasurement(m.parseArgs([file]), deps);
  };
  const missing = await run(undefined);
  const empty = await run('[]');
  assert.deepEqual(missing, empty);
  assert.equal(empty.equivalentCount, 0);
  assert.equal(empty.warning, '');
  const invalid = await run('{');
  assert.deepEqual(invalid.counts, empty.counts);
  assert.match(invalid.warning, /Could not read equivalent mutants/);
  assert.match(m.summary(invalid), /Could not read equivalent mutants/);
  const matched = await run(JSON.stringify([equivalentEntry()]));
  assert.equal(matched.equivalentCount, 1);
  assert.equal(matched.survivors.length, 0);
});


test('comparison and equivalent stale checks preserve exact source text, including literal whitespace', () => {
  const file = 'packages/contract/src/sample.ts';
  const make = original => ({ version: 1, file, ...m.evaluate([mutant({ original })], { tier: 'logic', guards: [] }, []) });
  const before = make("'a  b'");
  const after = make("'a b'");
  assert.equal(m.compareResults(before, after).added.length, 1);
  assert.equal(m.compareResults(before, after).removed.length, 1);
  const spaced = equivalentEntry({ original: ' true ' });
  const result = m.measure(report(file), file, 'sha', [], {}, [spaced]);
  assert.equal(result.equivalentCount, 0);
  assert.deepEqual(result.staleEquivalent, [spaced]);
});

test('failed consumer pass writes own-package result and failing names, prints FAIL, exits 2', async () => {
  const { deps, calls } = fakeDeps();
  let runs = 0;
  deps.stryker = async (project, mutate, ms, options) => {
    if (++runs === 1) return { outcome: 'exited', code: 0 };
    options.onOutput('One or more tests failed in the initial test run:\n\tSuite fails one\n\t\texpected undefined to be +0\n\tSuite fails two\n');
    return { outcome: 'exited', code: 1 };
  };
  const code = await m.cli(['packages/contract/src/sample.ts', '--out', '/tmp/partial.json'], deps, new EventEmitter());
  assert.equal(code, 2);
  const result = JSON.parse(calls.find(c => c[0] === 'write' && c[1] === '/tmp/partial.json')[2]);
  assert.equal(result.counts.survived, 1);
  assert.equal(result.consumers.state, 'failed');
  assert.deepEqual(result.consumers.tests, ['packages/cezar/src/sample.test.ts']);
  assert.match(result.consumers.reason, /Suite fails one; Suite fails two/);
  assert.doesNotMatch(result.consumers.reason, /expected undefined/);
  assert.match(calls.find(c => c[0] === 'log')[1], /FAIL: consumer tests: failed/);
  assert.equal(calls.at(-2)[2], 'prune');
});

test('missing consumer report keeps own-package result and records the exit or read reason', async () => {
  const { deps } = fakeDeps();
  let reads = 0;
  deps.readReport = () => ++reads === 1 ? report('packages/contract/src/sample.ts') : null;
  const result = await m.runMeasurement(m.parseArgs(['packages/contract/src/sample.ts']), deps);
  assert.equal(result.consumers.state, 'failed');
  assert.match(result.consumers.reason, /no report/);
  assert.equal(result.rawCounts.survived, 1);
  assert.equal(m.consumerFailure('unrelated output', new Error('exit 1')), 'exit 1');
});

test('successful consumer pass records selected test paths and CLI exits zero', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await m.cli(['packages/contract/src/sample.ts', '--out', '/tmp/merged.json'], deps, new EventEmitter()), 0);
  const result = JSON.parse(calls.find(c => c[0] === 'write' && c[1] === '/tmp/merged.json')[2]);
  assert.deepEqual(result.consumers, { state: 'merged', tests: ['packages/cezar/src/sample.test.ts'] });
  assert.match(m.summary(result), /PASS: consumer tests: merged/);
});

test('captured Stryker output is delivered before its close result', async () => {
  const { runStryker } = require('./mutants-run.cjs');
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let captured = '';
  await runStryker('contract', ['file.ts'], 1000, {
    onOutput: chunk => { captured += chunk; }, kill: () => {},
    spawn: (bin, argv, options) => {
      assert.deepEqual(options.stdio, ['inherit', 'pipe', 'pipe']);
      queueMicrotask(() => { child.emit('exit', 1); child.stdout.emit('data', Buffer.from('late output\n')); child.emit('close', 1); });
      return child;
    },
  });
  assert.equal(captured, 'late output\n');
});


test('pass reset restores mock executability before consumers and also runs after consumer failure', async () => {
  for (const consumerCode of [0, 1]) {
    const { deps, calls } = fakeDeps();
    let executable = true;
    let passes = 0;
    deps.stryker = async () => {
      assert.equal(executable, true, 'each pass must see an executable mock');
      executable = false;
      return { outcome: 'exited', code: ++passes === 1 ? 0 : consumerCode };
    };
    deps.reset = cwd => { executable = true; calls.push(['reset', cwd]); };
    const result = await m.runMeasurement(m.parseArgs(['packages/contract/src/sample.ts']), deps);
    assert.equal(passes, 2);
    assert.equal(calls.filter(c => c[0] === 'reset').length, 2);
    assert.equal(executable, true);
    assert.equal(result.consumers.state, consumerCode ? 'failed' : 'merged');
  }
});

test('pass reset runs after missing report and thrown Stryker errors', async () => {
  for (const failure of ['missing', 'throw']) {
    const { deps, calls } = fakeDeps();
    if (failure === 'missing') deps.readReport = () => null;
    else deps.stryker = async () => { throw new Error('spawn failed'); };
    await assert.rejects(m.runMeasurement(m.parseArgs(['packages/contract/src/sample.ts']), deps));
    assert.equal(calls.filter(c => c[0] === 'reset').length, 1);
    assert.ok(calls.findIndex(c => c[0] === 'reset') < calls.findIndex(c => c[2] === 'remove'));
  }
});
