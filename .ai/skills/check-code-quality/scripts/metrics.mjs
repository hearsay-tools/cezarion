#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeSource, functionResults, measureCoverage, selectFunctions } from './code-metrics.mjs';

const hash = source => createHash('sha256').update(source).digest('hex');
const HELP = `Usage: node <skill>/scripts/metrics.mjs <file> [options]

Calculate cyclomatic complexity for JavaScript or TypeScript functions.
CRAP uses per-function body line coverage: C² × (1 − coverage)³ + C.

Options:
  --function <name>  Select a function or method (Class.method also works)
  --line <number>    Select the innermost function at a source line
  --coverage <path> Read an Istanbul coverage-final.json report
  --test <path>     Run a Vitest test file to collect fresh coverage; repeatable
  --project <name>  Select a Vitest project for --test; repeatable
  --json            Print a JSON report; test output goes to stderr
  -h, --help        Show this help

Without --test, no tests run. An existing coverage/coverage-final.json is
discovered from the source directory up to the checkout root, then cwd.
Missing or older coverage leaves CRAP unavailable. No dependencies are downloaded.
`;

function collectCoverage(file, tests, directory, stderr, { cwd, projects }) {
  const require = createRequire(join(cwd, 'package.json'));
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const args = [
    vitest, 'run', ...projects.flatMap(name => ['--project', name]),
    '--maxWorkers', '2', '--passWithNoTests=false',
    '--coverage.enabled', '--coverage.provider', 'v8', '--coverage.include', file,
    '--coverage.reporter', 'json', '--coverage.reportsDirectory', directory, ...tests,
  ];
  // No shell: paths and test filters are arguments, never commands. Keep stdout valid JSON.
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout: 600_000, killSignal: 'SIGTERM',
  });
  if (result.stdout) stderr.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  if (result.error) throw new Error(`Coverage run failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Coverage tests failed (exit ${result.status ?? result.signal}). No CRAP scores were calculated.`);
  return join(directory, 'coverage-final.json');
}

function findCoverage(file, cwd) {
  let directory = dirname(file);
  while (true) {
    const candidate = join(directory, 'coverage/coverage-final.json');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(directory, '.git')) || dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  const candidate = join(cwd, 'coverage/coverage-final.json');
  return existsSync(candidate) ? candidate : undefined;
}

function coverageEntry(report, file, cwd) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Expected an Istanbul coverage-final.json object.');
  const matches = Object.entries(report).filter(([key, entry]) => {
    const paths = [key, entry?.path].filter(value => typeof value === 'string');
    return paths.some(value => {
      const candidate = resolve(cwd, value);
      return candidate === file || (existsSync(candidate) && realpathSync(candidate) === file);
    });
  });
  if (matches.length > 1) throw new Error('Several coverage entries match this file. Supply one unmerged report.');
  return matches[0]?.[1];
}

function textReport(report) {
  const rows = report.functions.map(fn => [
    fn.name, String(fn.line), String(fn.complexity),
    fn.coverage.status === 'available' ? `${fn.coverage.percent.toFixed(2)}%` : 'unavailable',
    fn.crap === null ? 'unavailable' : fn.crap.toFixed(2),
  ]);
  const headers = ['Function', 'Line', 'Complexity', 'Coverage', 'CRAP'];
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => row[i].length)));
  const table = [headers, ...rows].map(row => row.map((value, i) => value.padEnd(widths[i])).join('  ').trimEnd());
  const reasons = [...new Set(report.functions.filter(fn => fn.coverage.status !== 'available').map(fn => fn.coverage.reason))];
  return [report.file, ...table, ...(rows.length ? [] : ['No implemented functions found.']),
    '', 'Complexity: classic. Coverage: function body lines.', ...reasons].join('\n') + '\n';
}

function parseInput(args, cwd) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    function: { type: 'string' }, line: { type: 'string' }, coverage: { type: 'string' },
    test: { type: 'string', multiple: true }, json: { type: 'boolean' },
    project: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { values };
  if (positionals.length !== 1) throw new Error('Supply exactly one source file. See metrics.mjs --help.');
  if (values.coverage !== undefined && values.test) throw new Error('Use either --test for fresh coverage or --coverage for an existing report.');
  if (values.project && !values.test) throw new Error('--project requires --test.');
  if (values.project?.some(name => !name.trim())) throw new Error('--project must be a nonempty project name.');
  if (values.function !== undefined && !values.function.trim()) throw new Error('--function must be a nonempty name.');
  const line = values.line === undefined ? undefined : Number(values.line);
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error('--line must be a positive integer.');
  const file = realpathSync(resolve(cwd, positionals[0]));
  if (!/\.[cm]?[jt]sx?$/i.test(file)) throw new Error('Choose a JavaScript or TypeScript source file.');
  return { values, file, line };
}

function testPaths(tests, cwd) {
  return tests.map(test => {
    const path = realpathSync(resolve(cwd, test));
    if (!statSync(path).isFile() || !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)) {
      throw new Error('--test must name a Vitest test file, not a directory or source file.');
    }
    return path;
  });
}

function readMeasurements(coveragePath, { file, cwd, source, functions, fresh }) {
  if (!coveragePath) return {};
  const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const entry = coverageEntry(coverage, file, cwd);
  if (!entry) return { reason: 'File is absent from the coverage report. Use --test to collect coverage.' };
  if (!fresh && statSync(file).mtimeMs > statSync(coveragePath).mtimeMs) {
    return { reason: 'Source is newer than the coverage report. Use --test to collect fresh coverage.' };
  }
  return { measurements: measureCoverage(source, functions, entry) };
}

function removeTemporary(directory, stderr) {
  if (!directory) return;
  try { rmSync(directory, { recursive: true, force: true }); }
  catch (error) { stderr.write(`metrics: Could not remove temporary coverage at ${directory}: ${error.message}\n`); }
}

export async function runMetrics(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, runTests = collectCoverage, projects = [] } = {}) {
  let temporary;
  let json = args.includes('--json');
  try {
    const { values, file, line } = parseInput(args, cwd);
    json = Boolean(values.json);
    if (values.help) { stdout.write(HELP); return 0; }
    const source = readFileSync(file, 'utf8');
    const functions = analyzeSource(source, file);
    const selected = selectFunctions(functions, { name: values.function, line });
    let coveragePath;
    if (values.test) {
      const tests = testPaths(values.test, cwd);
      temporary = mkdtempSync(join(tmpdir(), 'cezar-metrics-'));
      coveragePath = await runTests(file, tests, temporary, stderr, { cwd, projects: values.project ?? projects });
      if (hash(readFileSync(file, 'utf8')) !== hash(source)) throw new Error('Source changed during the coverage run. Run the command again.');
    } else {
      coveragePath = values.coverage !== undefined ? resolve(cwd, values.coverage) : findCoverage(file, cwd);
    }
    const { measurements, reason } = readMeasurements(coveragePath, { file, cwd, source, functions, fresh: Boolean(values.test) });
    const report = {
      schemaVersion: 1, file, sourceHash: hash(source), complexityVariant: 'classic',
      coverageMetric: 'function-body-lines', coverageSource: values.test ? 'test-run' : coveragePath ? 'report' : null,
      coverageReport: values.test ? null : coveragePath ?? null,
      functions: functionResults(selected, measurements, reason),
    };
    stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : textReport(report));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) stdout.write(JSON.stringify({ error: message }) + '\n');
    else stderr.write(`metrics: ${message}\n`);
    return 1;
  } finally {
    removeTemporary(temporary, stderr);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runMetrics(process.argv.slice(2));
}
