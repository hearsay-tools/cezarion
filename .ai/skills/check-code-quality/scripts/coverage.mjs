import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import convert from 'ast-v8-to-istanbul';
import { vitestCoverageArguments } from './vitest-coverage.mjs';

function execute(argv, { cwd, stderr, coverageTimeout = 600_000 }, env) {
  // A collector invoked by node:test must start a new test coordinator.
  env = { ...env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, argv, {
    cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: coverageTimeout, killSignal: 'SIGTERM',
  });
  if (result.stdout) stderr.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`Coverage collection exceeded ${coverageTimeout} ms. Raise the limit with --coverage-timeout <ms> (for example, --coverage-timeout 900000), or use --coverage <coverage-final.json> with a separately collected current Istanbul report. Temporary coverage is removed.`);
  }
  if (result.error) throw new Error(`Coverage run failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Coverage tests failed (exit ${result.status ?? result.signal}).`);
}

const untransformed = file => /\.[cm]?js$/i.test(file);

async function nodeCoverageReport(raw, files, cwd) {
  const selected = new Set(files.map(file => pathToFileURL(resolve(cwd, file)).href));
  const inputs = readdirSync(raw).filter(file => file.endsWith('.json')).map(file => {
    const data = JSON.parse(readFileSync(join(raw, file), 'utf8'));
    return { result: data.result.filter(script => selected.has(script.url)) };
  });
  const report = {};
  for (const coverage of inputs.length ? mergeProcessCovs(inputs).result : []) {
    const code = readFileSync(new URL(coverage.url), 'utf8');
    const ast = parse(code, { sourceType: 'unambiguous', plugins: ['estree'], ranges: true }).program;
    Object.assign(report, await convert({ code, ast, coverage }));
  }
  return { report, processes: inputs.length };
}

export async function convertNodeCoverage(raw, files, cwd, output) {
  const { report, processes } = await nodeCoverageReport(raw, files, cwd);
  if (!processes) throw new Error('Node produced no V8 coverage reports.');
  writeFileSync(output, JSON.stringify(report));
}

const location = ({ start, end }) => `${start.line}:${start.column}-${end.line}:${end.column}`;

// Sum the counters of one map ('statementMap' with 's', ...) by source location.
// A location only one report has keeps its own counter.
function mergeCounters(target, source, map, counts, add) {
  const ids = new Map(Object.entries(target[map]).map(([id, item]) => [location(item.loc ?? item), id]));
  let next = Object.keys(target[map]).length;
  for (const [id, item] of Object.entries(source[map])) {
    const match = ids.get(location(item.loc ?? item));
    if (match === undefined) {
      target[map][next] = item;
      target[counts][next++] = source[counts][id];
    } else target[counts][match] = add(target[counts][match], source[counts][id]);
  }
}

/** Add the counters of an Istanbul report to another, keeping one entry per file. */
export function mergeIstanbulReports(target, source) {
  const entries = new Map(Object.values(target).map(entry => [resolve(entry.path), entry]));
  for (const entry of Object.values(source)) {
    const current = entries.get(resolve(entry.path));
    if (!current) {
      target[entry.path] = entry;
      continue;
    }
    mergeCounters(current, entry, 'statementMap', 's', (a, b) => a + b);
    mergeCounters(current, entry, 'fnMap', 'f', (a, b) => a + b);
    mergeCounters(current, entry, 'branchMap', 'b', (a, b) => a.length === b.length ? a.map((n, i) => n + b[i]) : a);
  }
  return target;
}

// Node writes process coverage only for untransformed JavaScript the child loads itself;
// its offsets for transformed sources would not match the files on disk.
async function addChildCoverage(raw, files, cwd, output) {
  const children = files.filter(untransformed);
  if (!children.length || !existsSync(raw)) return;
  const { report } = await nodeCoverageReport(raw, children, cwd);
  // Compare locations as a written report holds them: an open end column is null there.
  const merged = mergeIstanbulReports(JSON.parse(readFileSync(output, 'utf8')), JSON.parse(JSON.stringify(report)));
  writeFileSync(output, JSON.stringify(merged));
}

/** One bounded test run covers all changed files. Test output stays on stderr. */
export async function collectCoverage(options, directory) {
  const { runner, files, tests, imports, testTimeout, cwd } = options;
  const output = join(directory, 'coverage-final.json');
  const raw = join(directory, 'raw');
  if (runner === 'vitest') {
    // Vitest empties its reports directory before the run, so process coverage stays outside it.
    const reports = join(directory, 'vitest');
    mkdirSync(reports);
    const argv = vitestCoverageArguments(options, reports, raw);
    execute(argv, options, process.env);
    renameSync(join(reports, 'coverage-final.json'), output);
    await addChildCoverage(raw, files, cwd, output);
    return { path: output, runner, command: [process.execPath, ...argv], childProcessCoverage: '<temporary-directory>/raw' };
  }
  const transformed = files.filter(file => !untransformed(file));
  if (transformed.length) {
    throw new Error(`Node coverage supports untransformed JavaScript only, not ${transformed.join(', ')}. Use --runner vitest with the --project that runs these tests, or supply --coverage with an Istanbul report from another runner.`);
  }
  mkdirSync(raw);
  const timeout = testTimeout ? [`--test-timeout=${testTimeout}`] : [];
  const argv = [...imports.flatMap(file => ['--import', file]), '--test', ...timeout, ...tests];
  execute(argv, options, { ...process.env, NODE_V8_COVERAGE: raw });
  await convertNodeCoverage(raw, files, cwd, output);
  return { path: output, runner, command: [process.execPath, ...argv], environment: { NODE_V8_COVERAGE: '<temporary-directory>/raw' } };
}
