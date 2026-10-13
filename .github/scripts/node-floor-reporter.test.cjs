const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../..');
const reporter = path.join(__dirname, 'node-floor-reporter.mjs');

test('floor measurements retain native test durations, timeout budgets and failures across projects', () => {
  const dir = fs.mkdtempSync(path.join(root, '.tmp-vitest-ga-floor-'));
  const outputFile = path.join(dir, 'floor.json');
  try {
    fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), `
      export default { test: {
        maxWorkers: 1,
        reporters: [[${JSON.stringify(reporter)}, { outputFile: ${JSON.stringify(outputFile)}, sampleIntervalMs: 10 }]],
        projects: [
          { test: { name: 'fast', include: ['fast.test.mjs'], testTimeout: 1234 } },
          { test: { name: 'slow', include: ['slow.test.mjs'], testTimeout: 4321 } },
        ],
      } };
    `);
    fs.writeFileSync(path.join(dir, 'fast.test.mjs'), `
      import { test, expect } from 'vitest';
      test('passes', () => expect(1).toBe(1));
      test.skip('skips', () => {});
      test('fails', () => expect('actual').toBe('expected'));
    `);
    fs.writeFileSync(path.join(dir, 'slow.test.mjs'), `
      import { test } from 'vitest';
      test('waits with explicit budget', async () => { await new Promise(r => setTimeout(r, 30)); }, 6789);
    `);
    const result = spawnSync(path.join(root, 'node_modules/.bin/vitest'), ['run', '--config', path.join(dir, 'vitest.config.mjs')], {
      cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: 'false' },
    });
    assert.equal(result.status, 1, `the failing fixture must stay red: ${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(outputFile), `a failed run must retain evidence: ${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(report.reason, 'failed');
    assert.equal(report.maxWorkers, 1);
    assert.equal(report.peakActiveModules, 1);
    assert.equal(report.nodeVersion, process.version);
    assert.ok(report.availableParallelism > 0);
    assert.ok(report.durationMs > 0);
    assert.ok(report.samples.length >= 2);
    assert.ok(report.samples.every(sample => sample.loadAverage.length === 3 && sample.elapsedMs >= 0));
    assert.deepEqual(report.tests.map(t => [t.project, t.file, t.name, t.state, t.timeoutMs]).sort(), [
      ['fast', 'fast.test.mjs', 'fails', 'failed', 1234],
      ['fast', 'fast.test.mjs', 'passes', 'passed', 1234],
      ['fast', 'fast.test.mjs', 'skips', 'skipped', 1234],
      ['slow', 'slow.test.mjs', 'waits with explicit budget', 'passed', 6789],
    ]);
    assert.ok(report.tests.find(t => t.name === 'waits with explicit budget').durationMs >= 25);
    assert.ok(report.tests.every(t => t.retryCount === 0));
    assert.ok(report.tests.find(t => t.name === 'fails').errorMessages.some(message => message.includes('expected')));
    assert.deepEqual(report.tests.find(t => t.name === 'passes').errorMessages, []);
    assert.equal(report.modules.length, 2);
    assert.ok(report.modules.every(m => m.durationMs >= 0));
    assert.match(result.stdout, /\[node-floor\].*workers=1/);
    assert.match(result.stdout, /fast.test.mjs.*fails/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('floor CI keeps its failure exit and uploads timing evidence even when Vitest fails', () => {
  const ci = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const job = ci.jobs['node-floor'];
  const step = job.steps.find(s => s.name === 'Run server and cockpit unit suites');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cez-floor-workflow-'));
  try {
    const argsFile = path.join(dir, 'args');
    fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGS_FILE"\nexit 7\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-c', step.run.replaceAll('${{ matrix.shard }}', '2')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARGS_FILE: argsFile },
    });
    assert.equal(result.status, 7, 'measurement must not turn a failed suite green');
    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.ok(args.includes('--shard=2/2'));
    assert.ok(args.includes('--maxWorkers=4'));
    assert.ok(args.includes('--reporter=./.github/scripts/node-floor-reporter.mjs'));
    assert.equal(args.filter(a => a === '--reporter=github-actions').length, 1);
    const upload = job.steps.find(s => s.name === 'Upload floor measurements');
    assert.equal(upload.if, 'always()');
    assert.equal(upload.with.path, '${{ runner.temp }}/node-floor-shard-${{ matrix.shard }}.json');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
