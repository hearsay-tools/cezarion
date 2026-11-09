import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeCoverageReport } from './node-coverage.mjs';
import { mergeIstanbulReports } from './istanbul-merge.mjs';
import { vitestCoverageArguments } from './vitest-coverage.mjs';

export { mergeIstanbulReports };

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

export async function convertNodeCoverage(raw, files, cwd, output) {
  const { report, processes } = await nodeCoverageReport(raw, files, cwd);
  if (!processes) throw new Error('Node produced no V8 coverage reports.');
  writeFileSync(output, JSON.stringify(report));
}

async function addChildCoverage(raw, files, cwd, output) {
  const { report } = await nodeCoverageReport(raw, files, cwd);
  if (!Object.keys(report).length) return;
  const merged = mergeIstanbulReports(JSON.parse(readFileSync(output, 'utf8')), report);
  writeFileSync(output, JSON.stringify(merged));
}

function prepareRaw(raw, files, cwd) {
  mkdirSync(raw);
  writeFileSync(join(raw, 'quality-inputs.json'), JSON.stringify(files.map(file => resolve(cwd, file))));
}

export function inspectorNodeOptions(existing = '') {
  const preload = pathToFileURL(fileURLToPath(new URL('./inspector-preload.mjs', import.meta.url))).href;
  return `${existing} --import=${preload}`.trim();
}

async function collectGroup(options, directory) {
  const { runner, files, tests, imports = [], testTimeout, cwd } = options;
  const output = join(directory, 'coverage-final.json');
  const raw = join(directory, 'raw');
  prepareRaw(raw, files, cwd);
  if (runner === 'vitest') {
    const reports = join(directory, 'vitest');
    mkdirSync(reports);
    const argv = vitestCoverageArguments(options, reports, raw);
    execute(argv, options, process.env);
    renameSync(join(reports, 'coverage-final.json'), output);
    await addChildCoverage(raw, files, cwd, output);
    return { path: output, runner, command: [process.execPath, ...argv], childProcessCoverage: '<temporary-directory>/raw' };
  }
  const timeout = testTimeout ? [`--test-timeout=${testTimeout}`] : [];
  const argv = [...imports.flatMap(file => ['--import', file]), '--test', ...timeout, ...tests];
  execute(argv, options, { ...process.env, NODE_V8_COVERAGE: raw, NODE_OPTIONS: inspectorNodeOptions(process.env.NODE_OPTIONS) });
  await convertNodeCoverage(raw, files, cwd, output);
  return { path: output, runner, command: [process.execPath, ...argv], environment: { NODE_V8_COVERAGE: '<temporary-directory>/raw' } };
}

/** Groups run once each; only their merged report is measured against the inventory. */
export async function collectCoverage(options, directory) {
  if (!options.collections?.length) return collectGroup(options, directory);
  let report = {};
  const collections = [];
  const files = options.files.map(file => resolve(options.cwd, file));
  for (const [index, group] of options.collections.entries()) {
    const target = join(directory, `collection-${index}`);
    mkdirSync(target);
    const result = await collectGroup({ ...options, ...group, files }, target);
    const { path, ...provenance } = result;
    collections.push(provenance);
    report = mergeIstanbulReports(report, JSON.parse(readFileSync(path, 'utf8')));
  }
  const path = join(directory, 'coverage-final.json');
  writeFileSync(path, JSON.stringify(report));
  return { path, runner: 'mixed', collections };
}
