import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import convert from 'ast-v8-to-istanbul';

function vitestArguments({ cwd, files, tests, projects }, directory) {
  const require = createRequire(join(cwd, 'package.json'));
  const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  return [cli, 'run', ...projects.flatMap(name => ['--project', name]),
    '--maxWorkers', '2', '--passWithNoTests=false',
    '--coverage.enabled', '--coverage.provider', 'v8',
    ...files.flatMap(file => ['--coverage.include', file]),
    '--coverage.reporter', 'json', '--coverage.reportsDirectory', directory, ...tests];
}

function execute(argv, { cwd, stderr }, env) {
  // A collector invoked by node:test must start a new test coordinator.
  env = { ...env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, argv, {
    cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000, killSignal: 'SIGTERM',
  });
  if (result.stdout) stderr.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  if (result.error) throw new Error(`Coverage run failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Coverage tests failed (exit ${result.status ?? result.signal}).`);
}

export async function convertNodeCoverage(raw, files, cwd, output) {
  const selected = new Set(files.map(file => pathToFileURL(resolve(cwd, file)).href));
  const inputs = readdirSync(raw).filter(file => file.endsWith('.json')).map(file => {
    const data = JSON.parse(readFileSync(join(raw, file), 'utf8'));
    return { result: data.result.filter(script => selected.has(script.url)) };
  });
  if (!inputs.length) throw new Error('Node produced no V8 coverage reports.');
  const report = {};
  for (const coverage of mergeProcessCovs(inputs).result) {
    const code = readFileSync(new URL(coverage.url), 'utf8');
    const ast = parse(code, { sourceType: 'unambiguous', plugins: ['estree'], ranges: true }).program;
    Object.assign(report, await convert({ code, ast, coverage }));
  }
  writeFileSync(output, JSON.stringify(report));
}

/** One bounded test run covers all changed files. Test output stays on stderr. */
export async function collectCoverage(options, directory) {
  const { runner, files, tests, imports, cwd } = options;
  const output = join(directory, 'coverage-final.json');
  if (runner === 'vitest') {
    const argv = vitestArguments(options, directory);
    execute(argv, options, process.env);
    return { path: output, runner, command: [process.execPath, ...argv] };
  }
  if (files.some(file => !/\.[cm]?js$/i.test(file))) {
    throw new Error('Node coverage supports untransformed JavaScript. Use Vitest or --coverage for TypeScript/JSX.');
  }
  const raw = join(directory, 'raw');
  mkdirSync(raw);
  const argv = [...imports.flatMap(file => ['--import', file]), '--test', ...tests];
  execute(argv, options, { ...process.env, NODE_V8_COVERAGE: raw });
  await convertNodeCoverage(raw, files, cwd, output);
  return { path: output, runner, command: [process.execPath, ...argv], environment: { NODE_V8_COVERAGE: '<temporary-directory>/raw' } };
}
