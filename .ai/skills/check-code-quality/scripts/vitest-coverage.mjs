#!/usr/bin/env node
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Test files the collector accepts, including browser specs named `*.e2e.ts`. */
export const testFilePattern = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/i;

/** Resolve Vitest's Node API from the target project, never from this skill. */
export function resolveVitest(cwd) {
  const require = createRequire(join(cwd, 'package.json'));
  const find = name => { try { return require.resolve(name); } catch { return null; } };
  const node = find('vitest/node');
  if (!node) {
    throw new Error(`Vitest is not installed for ${cwd}. Install vitest and @vitest/coverage-v8 with the project's package manager, or use --runner node for untransformed JavaScript.`);
  }
  if (!find('@vitest/coverage-v8')) {
    throw new Error(`@vitest/coverage-v8 is not installed for ${cwd}. Install the version that matches vitest with the project's package manager.`);
  }
  return node;
}

/** The argv for one coverage run in a child process. */
export function vitestCoverageArguments({ cwd, files, tests, projects }, directory, processCoverage) {
  resolveVitest(cwd);
  return [fileURLToPath(import.meta.url), JSON.stringify({ files, tests, projects, directory, processCoverage })];
}

// Vitest appends every test.include glob to coverage.exclude after it resolves the
// config, and no option turns that off. The quality policy measures changed test
// functions too, so remove those globs. coverage.include still selects only changed files.
export function includeTestFiles(vitest) {
  const configs = [vitest.config, ...vitest.projects.map(project => project.config)];
  const globs = new Set(configs.flatMap(config => config.include ?? []));
  for (const config of configs) config.coverage.exclude = config.coverage.exclude.filter(glob => !globs.has(glob));
}

// Vitest copies test.env into each worker's process.env after the worker starts, so the
// workers record no process coverage. The Node processes a test spawns inherit the variable
// and write V8 coverage there, which coverage.mjs merges into Vitest's report.
export function recordChildCoverage(vitest, directory) {
  for (const config of [vitest.config, ...vitest.projects.map(project => project.config)]) {
    config.env = { ...config.env, NODE_V8_COVERAGE: directory };
  }
}

async function main([request]) {
  const { files, tests, projects, directory, processCoverage } = JSON.parse(request);
  const { createVitest } = await import(pathToFileURL(resolveVitest(process.cwd())).href);
  // The Vitest CLI sets these before it loads the config.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const vitest = await createVitest('test', {
    run: true, watch: false, ...(projects.length ? { project: projects } : {}),
    maxWorkers: 2, passWithNoTests: false,
    coverage: { enabled: true, provider: 'v8', include: files, reporter: ['json'], reportsDirectory: directory },
  });
  try {
    includeTestFiles(vitest);
    recordChildCoverage(vitest, processCoverage);
    await vitest.start(tests);
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
  } finally {
    await vitest.exit();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
