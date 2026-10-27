'use strict';

// Guards the coverage settings of the root vitest.config.ts: a run without --coverage must stay
// exactly what it was before coverage existed, and a run with it must keep test files in the report.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');
const vitestBin = path.join(repoRoot, 'node_modules', '.bin', 'vitest');
const moduleUrl = pathToFileURL(path.join(__dirname, 'vitest-coverage-tests.mjs')).href;
// One small test file keeps the real runs fast and their output stable.
const SPEC = 'packages/contract/src/attention.test.ts';

// The reporters list the root config resolved to before coverage settings existed.
const MAIN_LOCAL = [['default', {}]];
const MAIN_ACTIONS = [['default', {}], ['github-actions', { jobSummary: { title: 'Vitest Test Report' } }]];

function resolvedReporters({ env = {}, argv = [], overrides = {} }) {
  const code = `
    process.argv.push(...${JSON.stringify(argv)});
    const { resolveConfig } = await import('vitest/node');
    const { vitestConfig } = await resolveConfig({ root: process.cwd(), watch: false, run: true, project: ['contract'], ...${JSON.stringify(overrides)} });
    console.log(JSON.stringify(vitestConfig.reporters.map((r) => (Array.isArray(r) ? r : r.constructor.name))));`;
  const childEnv = { ...process.env, ...env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete childEnv[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repoRoot, env: childEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

function vitest(args, { config, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  for (const key of ['GITHUB_ACTIONS', 'CI', 'FORCE_COLOR']) if (!(key in env)) delete childEnv[key];
  childEnv.NO_COLOR = '1';
  const result = spawnSync(vitestBin, ['run', ...(config ? ['--config', config] : []), '--project', 'contract', SPEC, ...args],
    { cwd: repoRoot, env: childEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}

// CI printed colour codes here once: they split a number from its unit and hide a line's first word.
// The child runs with NO_COLOR, and this strips any that remain.
const stable = (output) => output
  .replace(/\u001B\[[0-9;]*m/g, '')
  .replace(/^\s*(Start at|Duration)\b.*$/gm, '')
  .replace(/\d+(\.\d+)?\s?m?s\b/g, '<time>')
  .replace(/\n{2,}/g, '\n');

test('coverageRequested recognises Vitest coverage flags and nothing else', async () => {
  const { coverageRequested } = await import(moduleUrl);
  for (const flag of ['--coverage', '--coverage.enabled', '--coverage.reporter=json', '--coverage=true']) {
    assert.equal(coverageRequested(['node', 'vitest', 'run', flag]), true, flag);
  }
  for (const argv of [[], ['node', 'vitest', 'run', '--reporter=json'], ['node', 'vitest', 'run', '--project', 'coverage']]) {
    assert.equal(coverageRequested(argv), false, argv.join(' '));
  }
});

test('the reporter removes the test globs of every project from coverage.exclude and nothing else', async () => {
  const { default: KeepTestFilesInCoverage } = await import(moduleUrl);
  const kept = ['**/node_modules/**', '**/dist/**'];
  const exclude = [...kept, '**/*.{test,spec}.?(c|m)[jt]s?(x)', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.test.ts'];
  const vitest = {
    config: { include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'], coverage: { exclude } },
    projects: [{ config: { include: ['src/**/*.test.ts'] } }, { config: { include: ['src/**/*.test.tsx'] } }, { config: {} }],
    coverageProvider: { options: { exclude } },
  };
  new KeepTestFilesInCoverage().onInit(vitest);
  assert.deepEqual(vitest.config.coverage.exclude, kept);
  assert.deepEqual(vitest.coverageProvider.options.exclude, kept, 'the provider copied its options before the hook ran');
  assert.deepEqual(exclude.length, 6, 'the original list is not changed in place');
});

test('the reporter does nothing harmful when Vitest has no coverage provider', async () => {
  const { default: KeepTestFilesInCoverage } = await import(moduleUrl);
  const vitest = { config: { coverage: { exclude: ['a', 'src/**/*.test.ts'] } }, projects: [{ config: { include: ['src/**/*.test.ts'] } }] };
  new KeepTestFilesInCoverage().onInit(vitest);
  assert.deepEqual(vitest.config.coverage.exclude, ['a']);
});

test('without --coverage the resolved reporter list is the one main resolves', () => {
  assert.deepEqual(resolvedReporters({ env: { GITHUB_ACTIONS: undefined } }), MAIN_LOCAL);
  assert.deepEqual(resolvedReporters({ env: { GITHUB_ACTIONS: 'true' } }), MAIN_ACTIONS);
});

test('with --coverage the configured reporters are kept and one coverage-only reporter is added', () => {
  for (const [env, main] of [[{ GITHUB_ACTIONS: undefined }, MAIN_LOCAL], [{ GITHUB_ACTIONS: 'true' }, MAIN_ACTIONS]]) {
    const list = resolvedReporters({ env, argv: ['--coverage.enabled'] });
    assert.deepEqual(list.slice(0, main.length), main);
    assert.deepEqual(list.slice(main.length), ['KeepTestFilesInCoverage']);
  }
});

test('a reporter passed on the command line replaces the list exactly as before, with or without --coverage', () => {
  for (const argv of [[], ['--coverage.enabled']]) {
    assert.deepEqual(resolvedReporters({ env: { GITHUB_ACTIONS: undefined }, argv, overrides: { reporters: ['json'] } }), [['json', {}]]);
  }
});

test('a run without --coverage prints what a run under main\'s reporters config prints', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-main-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mainConfig = path.join(directory, 'vitest.main.config.mjs');
  // Main's root config, minus what does not reach the output: the projects, the reporters and nothing else.
  fs.writeFileSync(mainConfig, `export default ${JSON.stringify({ root: repoRoot, test: { passWithNoTests: true,
    reporters: ['default'], projects: ['./packages/contract/vitest.config.ts'] } })};\n`);
  assert.equal(stable(vitest([])), stable(vitest([], { config: mainConfig })));
});

test('a run with --coverage reports the test files it ran next to the sources they load', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  vitest(['--coverage.enabled', `--coverage.reportsDirectory=${directory}`]);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'coverage-final.json'), 'utf8'));
  const files = Object.keys(report).map((file) => path.relative(repoRoot, file));
  assert.ok(files.includes(SPEC), `${SPEC} must be in the report, got ${files.join(', ')}`);
  assert.ok(files.some((file) => file.startsWith('packages/contract/src/') && !file.endsWith('.test.ts')), 'sources must be in the report');
  assert.equal(files.some((file) => file.startsWith('node_modules/')), false);
});

for (const stage of ['generateCoverage', 'reportCoverage']) {
  test(`coverage ${stage} errors warn only in CI without hiding test failures`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-optional-report-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const provider = path.join(directory, 'provider.mjs');
    const native = pathToFileURL(require.resolve('@vitest/coverage-v8')).href;
    fs.writeFileSync(provider, `import native from ${JSON.stringify(native)};
      export default { ...native, async getProvider() {
        const provider = await native.getProvider();
        provider.${stage} = async () => { throw new Error('injected coverage report failure'); };
        return provider;
      } };`);
    for (const [ci, fails] of [['true', false], ['true', true], ['false', false]]) {
      const spec = path.join(directory, 'verdict.test.js');
      fs.writeFileSync(spec, `test('verdict', () => expect(${fails}).toBe(false));`);
      const config = path.join(directory, 'vitest.config.mjs');
      const reporter = pathToFileURL(path.join(__dirname, 'vitest-coverage-tests.mjs')).href;
      fs.writeFileSync(config, `import Reporter from ${JSON.stringify(reporter)};
        export default { root: ${JSON.stringify(repoRoot)}, test: {
          include: [${JSON.stringify(spec)}], globals: true, reporters: ['default', new Reporter()],
          coverage: { enabled: true, provider: 'custom', customProviderModule: ${JSON.stringify(provider)},
            reportsDirectory: ${JSON.stringify(path.join(directory, 'coverage'))}, reporter: ['json'], reportOnFailure: true }
        } };`);
      const result = spawnSync(vitestBin, ['run', '--config', config], {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: ci, NO_COLOR: '1' },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, ci === 'true' && !fails ? 0 : 1, output);
      if (ci === 'true') {
        assert.match(output, /::warning title=Vitest coverage report failed::/);
        assert.match(output, fails ? /1 failed/ : /1 passed/);
      } else {
        assert.doesNotMatch(output, /::warning title=Vitest coverage report failed::/);
        assert.match(output, /injected coverage report failure/);
      }
    }
  });
}

test('optional coverage reports preserve receivers, arguments and results', async (t) => {
  const { optionalCoverageReports } = await import(moduleUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = {
    options: { reportsDirectory: directory },
    async generateCoverage(options) { assert.equal(this, provider); return options; },
    async reportCoverage(report, options) { assert.equal(this, provider); return [report, options]; },
  };
  optionalCoverageReports(provider);
  const report = await provider.generateCoverage({ allTestsRun: true });
  assert.deepEqual(report, { allTestsRun: true });
  assert.deepEqual(await provider.reportCoverage(report, 'options'), [report, 'options']);
});

test('a report failure deletes partial output and skips further reporting without changing an exit code', async (t) => {
  const { optionalCoverageReports } = await import(moduleUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'coverage-final.json');
  fs.writeFileSync(report, 'partial');
  const warning = t.mock.method(console, 'warn', () => {});
  const exitCode = process.exitCode;
  let writes = 0;
  const provider = { options: { reportsDirectory: directory },
    generateCoverage() { throw new Error('conversion failed'); },
    reportCoverage() { writes++; },
  };
  optionalCoverageReports(provider);
  assert.equal(await provider.generateCoverage(), undefined);
  assert.equal(await provider.reportCoverage(), undefined);
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(report), false);
  assert.equal(process.exitCode, exitCode);
  assert.equal(warning.mock.callCount(), 1);
});

test('failed report cleanup stays optional, and a provider without report hooks stays usable', async (t) => {
  const { optionalCoverageReports } = await import(moduleUrl);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'file');
  fs.writeFileSync(file, 'not a directory');
  const warning = t.mock.method(console, 'warn', () => {});
  const provider = { options: { reportsDirectory: file }, reportCoverage() { throw new Error('write failed'); } };
  optionalCoverageReports(provider);
  assert.equal(await provider.reportCoverage(), undefined);
  assert.equal(warning.mock.callCount(), 2);
  const noHooks = {};
  optionalCoverageReports(noHooks);
  assert.deepEqual(noHooks, {});
});
