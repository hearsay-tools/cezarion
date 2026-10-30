#!/usr/bin/env node
'use strict';
// Whole-file mutation facts. Unlisted mutators are Value, including arithmetic and unary changes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const os = require('node:os');
const { promisify } = require('node:util');
const { sliceSource } = require('./mutants-report.cjs');
const { runStryker, restoreTree } = require('./mutants-run.cjs');
const { EQUIVALENT_FILE, readEquivalent, matchesEntry } = require('./mutants-equivalent.cjs');
const { namedRanges, functionRanges, functionOf } = require('./mutants-functions.cjs');
const TARGETS = require('../mutants/targets.json');
const REPORT = 'reports/mutation/mutation.json';
const STATUS = { Killed: 'killed', Timeout: 'timeout', Survived: 'survived', NoCoverage: 'noCoverage', CompileError: 'error', RuntimeError: 'error', Ignored: 'ignored' };
const undetected = m => ['Survived', 'NoCoverage'].includes(m.status);
const flat = text => text.replace(/\s+/g, ' ').trim();

function classText(text) {
  const words = text.replace(/^['"`]|['"`]$/g, '').trim().split(/\s+/);
  return words.length > 0 && words.every(word => /^(?:(?:[\w-]+|\[[^\]]+\]):)*-?(?:[\w]+-[\w\[\]./#%()-]+|flex|grid|hidden|block|inline|relative|absolute|fixed|sticky|truncate|italic|underline|sr-only)$/.test(word));
}

/** Compare only the changed operator, retaining shared characters within that operator. */
function boundarySwap(original, replacement) {
  let start = 0;
  while (start < original.length && original[start] === replacement[start]) start++;
  let suffix = 0;
  while (suffix < original.length - start && suffix < replacement.length - start && original.at(-suffix - 1) === replacement.at(-suffix - 1)) suffix++;
  while (start > 0 && /[<>=!]/.test(original[start - 1])) start--;
  while (suffix > 0 && /[<>=!]/.test(original[original.length - suffix])) suffix--;
  const operators = ['<', '<=', '>', '>='];
  return operators.includes(original.slice(start, original.length - suffix)) && operators.includes(replacement.slice(start, replacement.length - suffix));
}

function kindOf(m, file) {
  if (m.mutator === 'StringLiteral') {
    if (file.endsWith('.tsx') && classText(m.original)) return 'Class name';
    if (flat(m.original).split(' ').length >= 2) return 'Text';
  }
  if (m.status === 'NoCoverage') return 'Not covered';
  if (m.mutator === 'EqualityOperator' && boundarySwap(m.original, m.replacement)) return 'Boundary';
  if (m.mutator === 'OptionalChaining' || (m.mutator === 'LogicalOperator' && `${m.original} ${m.replacement}`.includes('??'))) return 'Fallback';
  if (['ConditionalExpression', 'LogicalOperator', 'EqualityOperator', 'BooleanLiteral'].includes(m.mutator)) return 'Condition';
  if (['BlockStatement', 'CallExpression', 'ArrowFunction', 'MethodExpression'].includes(m.mutator)) return 'Removed call';
  return 'Value';
}

function tierOf(file, targets = TARGETS) {
  return targets[file] ?? { tier: file.startsWith('packages/web/') && file.endsWith('.tsx') ? 'component' : 'logic', guards: [] };
}

function countsOf(mutants) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, error: 0, ignored: 0 };
  for (const m of mutants) {
    if (!STATUS[m.status]) throw new Error(`Unknown mutant status: ${m.status}`);
    counts[STATUS[m.status]] += 1;
  }
  return counts;
}

function scoreOf(c) {
  const total = c.killed + c.timeout + c.survived + c.noCoverage;
  return total === 0 ? 100 : 100 * (c.killed + c.timeout) / total;
}

function evaluate(mutants, target, ranges) {
  const counted = mutants.filter(m => m.kind !== 'Class name' && (m.kind !== 'Text' || target.guards.includes(m.function)));
  const counts = countsOf(counted);
  const guards = target.guards.map(name => {
    const found = ranges.some(r => r.name === name);
    const survivors = mutants.filter(m => m.function === name && m.kind !== 'Class name' && undetected(m));
    return { name, found, survivors, pass: found && survivors.length === 0 };
  });
  const targets = [{ name: `${target.tier} score`, pass: scoreOf(counts) >= (target.tier === 'logic' ? 85 : 75) }];
  if (target.tier === 'logic') targets.push({ name: 'covered lines', pass: counts.noCoverage === 0 });
  targets.push(...guards.map(g => ({ name: g.name, pass: g.pass })));
  return { counts, score: scoreOf(counts), rawCounts: countsOf(mutants), rawScore: scoreOf(countsOf(mutants)), survivors: counted.filter(undetected), guards, targets };
}

const survivorKey = m => JSON.stringify([m.function, m.mutator, m.original, m.replacement]);
function compareResults(before, after) {
  if (before.version !== after.version || before.file !== after.file) throw new Error('Comparison needs the same result version and file');
  const oldKeys = new Set(before.survivors.map(survivorKey));
  const newKeys = new Set(after.survivors.map(survivorKey));
  return { score: after.score - before.score, rawScore: after.rawScore - before.rawScore,
    counts: Object.fromEntries(Object.keys(after.counts).map(key => [key, after.counts[key] - before.counts[key]])),
    added: after.survivors.filter(m => !oldKeys.has(survivorKey(m))), removed: before.survivors.filter(m => !newKeys.has(survivorKey(m))) };
}

function parseArgs(argv) {
  const [file, ...rest] = argv;
  if (!/^packages\/[^/]+\/src\/.+\.tsx?$/.test(file ?? '') || file.split('/').includes('..')) throw new Error('Usage: mutants-file.cjs packages/<pkg>/src/<file>.ts [--tests <files>] [--compare <json>] [--out <json>] [--concurrency <n>]');
  const opts = { file, tests: [], concurrency: 4 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--tests') {
      const start = i + 1;
      while (rest[i + 1] && !rest[i + 1].startsWith('--')) opts.tests.push(rest[++i]);
      if (i < start) throw new Error('--tests needs at least one test file');
    } else {
      if (!['--compare', '--out', '--concurrency'].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}`);
      opts[flag.slice(2)] = rest[++i];
    }
  }
  opts.concurrency = Number(opts.concurrency);
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 8) throw new Error('--concurrency must be an integer from 1 to 8');
  if (opts.tests.length && file.split('/')[1] !== 'contract') throw new Error('--tests is supported only for contract files');
  return opts;
}

function importsModule(source, testFile, file) {
  const module = file.slice('packages/contract/src/'.length).replace(/\.tsx?$/, '');
  const specs = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
  return specs.some(spec => {
    if ([`@open-mercato/cezar-contract/${module}`, `@open-mercato/cezar-api-client/contract/${module}`].includes(spec)) return true;
    if (!spec.startsWith('.')) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(testFile), spec)).replace(/\.(?:[cm]?js|tsx?)$/, '');
    return resolved === file.replace(/\.tsx?$/, '');
  });
}

function consumerTests(file, files, read, extra = []) {
  const direct = files.filter(f => /^packages\/(?:cezar|web)\/src\/.+\.test\.tsx?$/.test(f) && importsModule(read(f), f, file));
  for (const test of extra) {
    if (!/^packages\/(?:cezar|web)\/src\/.+\.test\.tsx?$/.test(test) || test.split('/').includes('..') || !files.includes(test)) throw new Error(`Not a committed server or web test file: ${test}`);
  }
  return [...new Set([...direct, ...extra])].sort();
}

/** Reuse each package's real setup, aliases and environment; restrict only its include list. */
function consumerConfig(tests) {
  const projects = ['cezar', 'web'].flatMap(pkg => {
    const include = tests.filter(f => f.startsWith(`packages/${pkg}/`)).map(f => f.slice(`packages/${pkg}/`.length));
    return include.length ? [`{ ...${pkg}Config, root: resolve('packages/${pkg}'), test: { ...${pkg}Config.test, include: ${JSON.stringify(include)} } }`] : [];
  });
  return `import { defineConfig } from 'vitest/config';\nimport { resolve } from 'node:path';\nimport cezarConfig from './packages/cezar/vitest.config';\nimport webConfig from './packages/web/vitest.config';\nexport default defineConfig({ test: { projects: [${projects.join(',')}] } });\n`;
}

const reportKey = m => JSON.stringify([m.location, m.mutatorName, m.replacement]);
const statusRank = status => ({ Killed: 6, Timeout: 5, Survived: 4, NoCoverage: 3, RuntimeError: 2, CompileError: 1, Ignored: 0 })[status] ?? -1;
function mergeReports(first, second, file) {
  const a = first.files?.[file];
  const b = second.files?.[file];
  if (!a || !b) throw new Error(`Report does not contain ${file}`);
  if (a.source !== b.source) throw new Error('Cannot merge reports with different source text');
  const merged = new Map(a.mutants.map(m => [reportKey(m), m]));
  for (const m of b.mutants) {
    const old = merged.get(reportKey(m));
    if (!old || statusRank(m.status) > statusRank(old.status)) merged.set(reportKey(m), m);
  }
  return { ...first, files: { ...first.files, [file]: { ...a, mutants: [...merged.values()] } } };
}

function measure(report, file, head, ranges, targets = TARGETS, entries = []) {
  const data = report.files?.[file];
  if (!data) throw new Error(`Report does not contain ${file}`);
  const mutants = data.mutants.map(m => {
    const row = { file, location: m.location, line: m.location.start.line, mutator: m.mutatorName, original: sliceSource(data.source, m.location), replacement: m.replacement, status: m.status, function: functionOf(m.location, ranges) };
    return { ...row, kind: kindOf(row, file) };
  });
  const target = tierOf(file, targets);
  const kept = mutants.filter(m => !entries.some(entry => matchesEntry(entry, m)));
  const staleEquivalent = entries.filter(entry => entry.file === file && !mutants.some(m => matchesEntry(entry, m)));
  return { version: 1, file, head, tier: target.tier, mutants: kept, equivalentCount: mutants.length - kept.length,
    ...evaluate(kept, target, ranges), rawCounts: countsOf(mutants), rawScore: scoreOf(countsOf(mutants)), staleEquivalent };
}

function summary(result) {
  const lines = [`File: ${result.file}`, `HEAD: ${result.head}`, `Tier: ${result.tier}`, `Counts: ${JSON.stringify(result.counts)}`, `Counted score: ${result.score.toFixed(1)}%`, `Raw counts: ${JSON.stringify(result.rawCounts)}`, `Stryker raw score: ${result.rawScore.toFixed(1)}%`];
  lines.push(`Not-covered lines: ${[...new Set(result.survivors.filter(m => m.status === 'NoCoverage').map(m => m.line))].join(', ') || 'none'}`);
  const names = [...new Set(result.survivors.map(m => m.function))];
  for (const name of names) {
    lines.push(`Survivors in ${name}:`);
    for (const m of result.survivors.filter(m => m.function === name)) lines.push(`  L${m.line} ${m.kind} / ${m.mutator}: ${flat(m.original)} -> ${flat(m.replacement)}`);
  }
  for (const guard of result.guards) lines.push(`Guard ${guard.name}: ${guard.found ? `${guard.survivors.length} undetected` : 'NOT FOUND'}`);
  for (const target of result.targets) lines.push(`${target.pass ? 'PASS' : 'FAIL'}: ${target.name}`);
  lines.push(`Equivalent mutants excluded: ${result.equivalentCount}`, `Stale equivalent entries: ${JSON.stringify(result.staleEquivalent)}`);
  if (result.consumers) lines.push(result.consumers.state === 'failed' ? `FAIL: consumer tests: failed — ${result.consumers.reason}` : `PASS: consumer tests: merged (${result.consumers.tests.length} files)`);
  if (result.warning) lines.push(result.warning);
  if (result.comparison) lines.push(`Change: ${JSON.stringify(result.comparison)}`);
  return lines.join('\n');
}

async function strykerReport(deps, cwd, opts, project, extraArgs, signal, onOutput) {
  deps.removeReport(cwd);
  try {
    const result = await deps.stryker(project, [opts.file], 24 * 60 * 60_000, { cwd, extraArgs: ['--concurrency', String(opts.concurrency), ...extraArgs], signal, onOutput });
    signal.throwIfAborted();
    if (result.outcome !== 'exited' || result.code !== 0) throw new Error(`Stryker failed: ${result.outcome}, exit ${result.code}`);
    const report = deps.readReport(cwd);
    if (!report) throw new Error('Stryker wrote no report');
    return report;
  } finally {
    deps.reset(cwd);
  }
}

/** One committed snapshot, always removed after the active command has stopped. */
async function runMeasurement(opts, deps, signal = new AbortController().signal) {
  const head = deps.git(['rev-parse', 'HEAD']).trim();
  const cwd = deps.scratch();
  let registered = false;
  try {
    deps.git(['worktree', 'add', '--detach', cwd, head]);
    registered = true;
    await deps.command('pnpm', ['install', '--frozen-lockfile'], cwd, signal);
    await deps.command('npm', ['run', 'build:server'], cwd, signal);
    signal.throwIfAborted();
    const ranges = deps.ranges(opts.file, cwd);
    const first = await strykerReport(deps, cwd, opts, opts.file.split('/')[1], [], signal);
    const consumer = opts.file.startsWith('packages/contract/')
      ? await runConsumers(opts, deps, cwd, first, signal) : { report: first };
    const { report, consumers } = consumer;
    const equivalent = readEquivalent(path.join(cwd, EQUIVALENT_FILE), { readFileSync: deps.read });
    const result = { ...measure(report, opts.file, head, ranges, TARGETS, equivalent.entries), warning: equivalent.warning, ...(consumers ? { consumers } : {}) };
    if (opts.compare) result.comparison = compareResults(deps.readJson(opts.compare), result);
    if (opts.out) deps.write(opts.out, `${JSON.stringify(result, null, 2)}\n`);
    deps.log(summary(result));
    return result;
  } finally {
    try {
      if (registered) deps.git(['worktree', 'remove', '--force', cwd]);
    } finally {
      deps.git(['worktree', 'prune']);
      deps.removeScratch(cwd);
    }
  }
}

async function runConsumers(opts, deps, cwd, first, signal) {
  const files = deps.git(['ls-files'], cwd).trim().split('\n');
  const tests = consumerTests(opts.file, files, file => deps.read(path.join(cwd, file)), opts.tests);
  if (tests.length === 0) return { report: first };
  deps.write(path.join(cwd, 'vitest.mutants-consumers.config.ts'), consumerConfig(tests));
  const config = deps.readJson(path.join(cwd, 'stryker.config.json'));
  const scratchConfig = { ...config, vitest: { ...config.vitest, configFile: 'vitest.mutants-consumers.config.ts' } };
  deps.write(path.join(cwd, 'stryker.mutants-consumers.config.json'), `${JSON.stringify(scratchConfig, null, 2)}\n`);
  let output = '';
  try {
    const second = await strykerReport(deps, cwd, opts, 'contract', ['stryker.mutants-consumers.config.json'], signal, chunk => { output = (output + chunk).slice(-1024 * 1024); });
    return { report: mergeReports(first, second, opts.file), consumers: { state: 'merged', tests } };
  } catch (error) {
    signal.throwIfAborted();
    return { report: first, consumers: { state: 'failed', reason: consumerFailure(output, error), tests } };
  }
}

/** Keep Stryker's failing test names, without mistaking indented assertion text for names. */
function consumerFailure(output, error) {
  const marker = 'One or more tests failed in the initial test run:';
  const tail = output.slice(output.indexOf(marker) + marker.length);
  const names = output.includes(marker) ? tail.split('\n').filter(line => /^\t[^\t\s]/.test(line)).map(line => line.trim()) : [];
  return names.length ? `${error.message}: ${names.join('; ')}` : error.message;
}

function defaultDeps() {
  return {
    git: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
    scratch: () => {
      const base = path.join(os.homedir(), '.cache/cez/mutants');
      fs.mkdirSync(base, { recursive: true });
      return fs.mkdtempSync(path.join(base, 'file-'));
    },
    command: (bin, args, cwd, signal) => promisify(execFile)(bin, args, { cwd, signal, maxBuffer: 32 * 1024 * 1024 }).then(({ stdout, stderr }) => { process.stdout.write(stdout); process.stderr.write(stderr); }),
    stryker: runStryker,
    reset: cwd => restoreTree(cwd, { removeReport: true }),
    readReport: cwd => JSON.parse(fs.readFileSync(path.join(cwd, REPORT), 'utf8')),
    removeReport: cwd => fs.rmSync(path.join(cwd, REPORT), { force: true }),
    ranges: functionRanges,
    read: file => fs.readFileSync(file, 'utf8'),
    readJson: file => JSON.parse(fs.readFileSync(file, 'utf8')),
    write: (file, text) => fs.writeFileSync(file, text),
    removeScratch: cwd => fs.rmSync(cwd, { recursive: true, force: true }),
    log: text => console.log(text),
  };
}

async function cli(argv, deps = defaultDeps(), events = process) {
  const opts = parseArgs(argv);
  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => { exitCode = 130; controller.abort(); };
  const terminate = () => { exitCode = 143; controller.abort(); };
  events.on('SIGINT', interrupt);
  events.on('SIGTERM', terminate);
  try {
    const result = await runMeasurement(opts, deps, controller.signal);
    return exitCode || (result.consumers?.state === 'failed' ? 2 : 0);
  } catch (error) {
    if (exitCode) return exitCode;
    throw error;
  } finally {
    events.removeListener('SIGINT', interrupt);
    events.removeListener('SIGTERM', terminate);
  }
}

module.exports = { classText, kindOf, namedRanges, functionRanges, functionOf, tierOf, countsOf, scoreOf, evaluate, compareResults, parseArgs, importsModule, consumerTests, consumerConfig, mergeReports, measure, summary, strykerReport, runMeasurement, runConsumers, consumerFailure, defaultDeps, cli };
if (require.main === module) cli(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
