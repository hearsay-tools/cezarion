const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const reporterUrl = pathToFileURL(join(__dirname, 'vitest-file-duration.mjs')).href;

async function reporter() {
  const { default: Reporter } = await import(reporterUrl);
  const instance = new Reporter();
  instance.onTestRunStart();
  return instance;
}

function moduleResult(duration, state = 'passed') {
  return { moduleId: '/repo/hooks.test.ts', state: () => state, diagnostic: () => ({ duration }) };
}

async function completed(duration) {
  const instance = await reporter();
  const module = moduleResult(duration);
  instance.onTestModuleCollected(module);
  instance.onTestModuleEnd(module);
  return instance;
}


function finish(instance) {
  const previous = process.exitCode;
  const output = [];
  const error = mock.method(console, 'error', message => output.push(message));
  try {
    process.exitCode = 0;
    instance.onTestRunEnd();
    return { exitCode: process.exitCode, output: output.join('\n') };
  } finally {
    error.mock.restore();
    process.exitCode = previous;
  }
}

function assertFailure(instance, pattern) {
  const result = finish(instance);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, pattern);
}

test('59,999 ms passes while exactly 60,000 ms fails', async () => {
  const below = await completed(59_999);
  assert.deepEqual(finish(below), { exitCode: 0, output: '' });
  const boundary = await completed(60_000);
  assertFailure(boundary, /hooks\.test\.ts: 60000 ms; limit 60000 ms/);
});

test('60,001 ms fails and identifies the file, measurement and limit', async () => {
  const instance = await completed(60_001);
  assertFailure(instance, /\/repo\/hooks\.test\.ts: 60001 ms; limit 60000 ms/);
});

test('a collected module without completion fails instead of passing with zero duration', async () => {
  const instance = await reporter();
  instance.onTestModuleCollected(moduleResult(0, 'pending'));
  assertFailure(instance, /hooks\.test\.ts: no completed result.*limit 60000 ms/);
});

test('an end event without a completed state or valid measurement fails', async () => {
  for (const [duration, state] of [[0, 'pending'], [NaN, 'passed'], [Infinity, 'passed'], [-1, 'passed']]) {
    const instance = await reporter();
    instance.onTestModuleEnd(moduleResult(duration, state));
    assertFailure(instance, /no completed result/);
  }
});

test('the cap fails a real coverage-enabled Vitest run after module teardown', () => {
  const root = resolve(__dirname, '../..');
  mkdirSync(join(root, '.ai/qa'), { recursive: true });
  const probe = mkdtempSync(join(root, '.ai/qa/vitest-cap-'));
  try {
    writeFileSync(join(probe, 'one.test.ts'), `import { test, afterAll, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
afterAll(() => writeFileSync(${JSON.stringify(join(probe, 'teardown'))}, 'done'))
test('passes', () => expect(1).toBe(1))
`);
    writeFileSync(join(probe, 'vitest.config.mjs'), `import { defineConfig } from 'vitest/config'
import { existsSync } from 'node:fs'
import Reporter from ${JSON.stringify(reporterUrl)}
// Set the completed module clock without making this regression take a minute.
const clock = { onTestModuleEnd(module) {
  if (!existsSync(${JSON.stringify(join(probe, 'teardown'))})) throw new Error('teardown did not run')
  module.task.result.duration = Number(process.env.PROBE_DURATION)
} }
export default defineConfig({ test: {
  include: ['one.test.ts'], maxWorkers: 1, reporters: ['default', clock, new Reporter()],
  coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: './coverage' },
} })
`);
    for (const [duration, expected] of [[59_999, 0], [60_000, 1]]) {
      rmSync(join(probe, 'teardown'), { force: true });
      rmSync(join(probe, 'coverage'), { recursive: true, force: true });
      const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(probe, 'vitest.config.mjs'), '--coverage.enabled'], {
        cwd: probe, encoding: 'utf8', env: { ...process.env, PROBE_DURATION: String(duration) },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, expected, output);
      if (expected) assert.match(output, /one\.test\.ts: 60000 ms; limit 60000 ms/);
      // The merge-group rerun reset reads this list to name the file in the flake report.
      const list = join(probe, 'node_modules/.vite/vitest/file-duration-cap.txt');
      assert.equal(existsSync(list) && readFileSync(list, 'utf8'), expected ? `${join(probe, 'one.test.ts')}\n` : false);
      assert.ok(existsSync(join(probe, 'coverage/coverage-final.json')), 'coverage artifact missing');
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});

test('only the CI shard step enables the cap and the root config appends it', () => {
  const yaml = require('yaml');
  const root = resolve(__dirname, '../..');
  const workflow = yaml.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const step = workflow.jobs.vitest.steps.find(step => step.name === 'Run server and cockpit unit suites');
  assert.equal(step.env.VITEST_FILE_DURATION_CAP, '1');
  assert.match(step.run, /--shard=.*matrix.shard/);
  const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  assert.match(config, /process\.env\.VITEST_FILE_DURATION_CAP === '1' \? \[new FileDurationReporter\(\)\] : \[\]/);
  assert.equal((config.match(/'github-actions'/g) ?? []).length, 1);
});
