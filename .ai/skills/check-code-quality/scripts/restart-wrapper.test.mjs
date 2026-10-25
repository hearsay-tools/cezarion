import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

function wrapper() {
  const markdown = readFileSync(new URL('../references/pre-pr.md', import.meta.url), 'utf8');
  const block = markdown.match(/```sh\n(\(\n[\s\S]*?\n\))\n```/);
  assert.ok(block, 'the documented measurement wrapper must exist');
  return block[1].replace(/  node \.ai\/skills\/check-code-quality\/scripts\/check\.mjs[\s\S]*?(?=\n\)$)/,
    '  node "$PWD/measurement.mjs"');
}

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'squeal-wrapper-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'options.json'), JSON.stringify(options));
  writeFileSync(join(root, 'calls'), '');
  writeFileSync(join(root, 'measurement.mjs'), `
    import { readFileSync } from 'node:fs';
    const options = JSON.parse(readFileSync('options.json', 'utf8'));
    if (options.signal) process.kill(process.ppid, options.signal);
    process.exit(options.measurementStatus ?? 0);
  `);
  writeFileSync(join(root, 'squeal'), `#!${process.execPath}
    import { appendFileSync, readFileSync } from 'node:fs';
    const options = JSON.parse(readFileSync('options.json', 'utf8'));
    const command = process.argv[2];
    appendFileSync('calls', command + '\\n');
    if (command === 'stop') process.exit(0);
    if (command === 'start') process.exit(options.startStatus ?? 1);
    if (command !== 'status') process.exit(2);
    if (options.hung) {
      // Ignore TERM so the probe must enforce its timeout with KILL.
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    } else {
      const count = readFileSync('calls', 'utf8').split('status').length - 1;
      const answer = options.answers?.[Math.min(count - 1, options.answers.length - 1)] ?? 'alive';
      if (answer === 'malformed') console.log('not JSON');
      else console.log(JSON.stringify({
        available: answer !== 'unavailable',
        worktreeRoot: answer === 'wrong-root' ? '/another/worktree' : process.cwd(),
        daemon: { state: answer === 'down' ? 'down' : 'alive' },
        knownFailures: [{ name: 'unrelated failed test' }],
      }));
      process.exit(options.statusExit ?? 0);
    }
  `, { mode: 0o755 });
  // Move only the polling clock forward; child-process startup and signal
  // delivery use real time. A deadline test need not spend 30 real seconds.
  const clock = join(root, 'clock.mjs');
  writeFileSync(clock, `
    import timers from 'node:timers/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const now = performance.now.bind(performance);
    let advanced = 0;
    globalThis.performance = { now: () => now() + advanced };
    timers.setTimeout = async delay => { advanced += delay; };
    syncBuiltinESMExports();
  `);
  return { root, clock };
}

function run(f) {
  const result = spawnSync('sh', ['-c', wrapper()], {
    cwd: f.root,
    env: {
      PATH: `${f.root}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PWD: f.root,
      NODE_OPTIONS: `--import=${pathToFileURL(f.clock).href}`,
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    },
    encoding: 'utf8',
    // bound: hang guard for the whole fixture; the recipe owns probe deadlines.
    timeout: 60000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined, result.stderr);
  return { ...result, calls: readFileSync(join(f.root, 'calls'), 'utf8').trim().split('\n') };
}

test('a successful start preserves measurement success without status polling', t => {
  const result = run(fixture(t, { startStatus: 0 }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['stop', 'start']);
});

test('a daemon that answers late preserves a passing measurement despite unrelated test failures', t => {
  const result = run(fixture(t, { answers: ['down', 'down', 'alive'], statusExit: 1 }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['stop', 'start', 'status', 'status', 'status']);
  assert.doesNotMatch(result.stderr, /Squeal restart failed/);
});

for (const answer of ['down', 'unavailable', 'wrong-root', 'malformed']) {
  test(`a daemon whose status stays ${answer} fails restoration after the bound`, t => {
    const result = run(fixture(t, { answers: [answer] }));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Squeal restart failed/);
    assert.deepEqual(result.calls.slice(0, 2), ['stop', 'start']);
    assert.ok(result.calls.length > 3, 'must check again before declaring failure');
    assert.ok(result.calls.length <= 32, 'the 30-second deadline must bound polling');
  });
}

test('a hung status probe cannot hold the restart open forever', t => {
  const started = performance.now();
  const result = run(fixture(t, { hung: true }));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Squeal restart failed/);
  assert.ok(result.calls.includes('status'));
  // bound: the documented 30-second fallback plus loaded-host startup margin;
  // the fake polling clock cannot shorten a hung real subprocess timeout.
  assert.ok(performance.now() - started < 50000);
});

for (const measurementStatus of [2, 7]) {
  for (const answer of ['alive', 'down']) {
    test(`measurement exit ${measurementStatus} survives a ${answer} daemon`, t => {
      const result = run(fixture(t, { measurementStatus, answers: [answer] }));
      assert.equal(result.status, measurementStatus, result.stderr);
      assert.ok(result.calls.includes('start'));
    });
  }
}

for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} still restarts validation and preserves exit ${expected}`, t => {
    const result = run(fixture(t, { signal, answers: ['down', 'alive'] }));
    assert.equal(result.status, expected, result.stderr);
    assert.deepEqual(result.calls, ['stop', 'start', 'status', 'status']);
  });
}
