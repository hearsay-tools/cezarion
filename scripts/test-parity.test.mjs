import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { detectDaemon, reportVerdicts, runParity, selectFiles } from './test-parity.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'test-parity-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const file of ['packages/cezar/src/core/a-parity.test.ts',
    'packages/new/nested/b-parity.test.ts', 'packages/new/other.test.ts',
    'scripts/ignored-parity.test.ts', 'packages/new/node_modules/ignored-parity.test.ts']) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), '');
  }
  writeFileSync(join(cwd, 'squeal.config.json'), JSON.stringify({ runner: { timeoutMs: 2345 } }));
  return cwd;
}
const result = data => ({ status: 0, stdout: JSON.stringify(data) });
const alive = cwd => result({ schemaVersion: 1, available: true,
  worktreeRoot: cwd, daemon: { state: 'alive' } });

test('selects every nested parity file across packages and excludes dependencies', t => {
  assert.deepEqual(selectFiles(fixture(t)), [
    'packages/cezar/src/core/a-parity.test.ts', 'packages/new/nested/b-parity.test.ts',
  ]);
});

test('distinguishes no registered daemon from a daemon for this worktree', () => {
  assert.equal(detectDaemon('/repo', () => alive('/repo')), 'squeal');
  assert.equal(detectDaemon('/repo', () => result({ schemaVersion: 1, worktreeRoot: '/repo', daemon: { state: 'down', since: null } })), null);
  assert.equal(detectDaemon('/repo', () => result({ available: false })), null);
  assert.throws(() => detectDaemon('/repo', () => alive('/other')), /this worktree/);
  assert.throws(() => detectDaemon('/repo', () => result({})), /unsupported/);
  assert.throws(() => detectDaemon('/repo', () => ({ stdout: 'broken' })), SyntaxError);
});

test('discovers the installed launcher without PATH and handles absent Squeal', () => {
  const calls = [];
  const run = command => {
    calls.push(command);
    return command === '/user/.local/bin/squeal' ? alive('/repo')
      : { error: { code: 'ENOENT' } };
  };
  assert.equal(detectDaemon('/repo', run, '/user', {}), '/user/.local/bin/squeal');
  assert.deepEqual(calls, ['squeal', '/user/.local/bin/squeal']);
  assert.equal(detectDaemon('/repo', () => ({ error: { code: 'ENOENT' } }), '/user'), null);
  assert.throws(() => detectDaemon('/repo', () => ({ error: new Error('permission') })), /permission/);
});

for (const [state, verdict, expected, label] of [
  ['current', 'pass', 0, 'PASS'], ['current', 'fail', 1, 'FAIL'], ['pending', 'pass', 1, 'PENDING'],
  ['unknown', undefined, 1, 'UNKNOWN'], ['stale', 'pass', 1, 'UNKNOWN'], ['current', 'skip', 1, 'UNKNOWN'],
]) {
  test(`reports ${state}/${verdict} by file`, () => {
    const lines = [];
    assert.equal(reportVerdicts(['a'], { selection: { testFiles: [{ path: 'a', state, verdict }] } }, line => lines.push(line)), expected);
    assert.ok(lines[0].startsWith(`${label} a:`), lines[0]);
  });
}

test('missing files and conflicting projects cannot silently pass', () => {
  assert.equal(reportVerdicts(['missing'], {}, () => {}), 1);
  assert.equal(reportVerdicts(['a'], { selection: { testFiles: [
    { path: 'a', state: 'current', verdict: 'pass' },
    { path: 'a', state: 'current', verdict: 'fail' },
  ] } }, () => {}), 1);
});

test('uses Squeal wait with every selected file and never starts npm', t => {
  const cwd = fixture(t);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return args.includes('--wait') ? result({ selection: { testFiles:
      selectFiles(cwd).map(path => ({ path, state: 'current', verdict: 'pass' })) } }) : alive(cwd);
  };
  assert.equal(runParity({ cwd, args: [], run, log() {} }), 0);
  assert.deepEqual(calls, [['squeal', ['status', '--json']],
    ['squeal', ['status', '--wait', '60000', '--json', ...selectFiles(cwd)]]]);
});

test('without a daemon invokes npm test with explicit files and propagates failure', t => {
  const cwd = fixture(t);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return command === 'squeal' ? result({ schemaVersion: 1, worktreeRoot: cwd, daemon: { state: 'down', since: null } }) : { status: 7 };
  };
  assert.equal(runParity({ cwd, args: [], run, log() {} }), 7);
  assert.deepEqual(calls[1][1], ['test', '--', ...selectFiles(cwd)]);
});

test('plan lists files and mode without running tests', t => {
  const cwd = fixture(t);
  const output = [];
  assert.equal(runParity({ cwd, args: ['--plan'], run: () => alive(cwd), log: line => output.push(line) }), 0);
  assert.deepEqual(JSON.parse(output[0]), { mode: 'squeal', files: selectFiles(cwd) });
  assert.throws(() => runParity({ cwd, args: ['--typo'] }), /only --plan/);
});

test('nonzero wait and pending or absent verdicts fail without starting another runner', t => {
  const cwd = fixture(t);
  for (const status of [0, 1, 3]) {
    const logs = [];
    const run = (command, args) => args.includes('--wait')
      ? { status, stdout: JSON.stringify({ selection: { testFiles: [] } }) } : alive(cwd);
    assert.equal(runParity({ cwd, args: [], run, log: line => logs.push(line) }), 1);
    for (const file of selectFiles(cwd)) assert.ok(logs.some(line => line.includes(file)));
  }
});

for (const daemon of [
  { state: 'down', since: 123, heartbeatLate: { ageMs: 18000 } },
  { state: 'down', since: 123 },
]) {
  test(`registered daemon uses Squeal even when down: ${JSON.stringify(daemon)}`, () => {
    assert.equal(detectDaemon('/repo', () => result({ schemaVersion: 1, worktreeRoot: '/repo', daemon })), 'squeal');
  });
}
for (const untilStart of [false, true]) {
  test(`explicit stop uses npm (untilStart=${untilStart})`, () => {
    assert.equal(detectDaemon('/repo', () => result({ schemaVersion: 1, worktreeRoot: '/repo',
      daemon: { state: 'down', since: 123, stopped: true, untilStart } })), null);
  });
}

test('discovers the documented SQUEAL_BIN_DIR launcher override', () => {
  const calls = [];
  const run = command => {
    calls.push(command);
    return command === '/custom/bin/squeal' ? alive('/repo') : { error: { code: 'ENOENT' } };
  };
  assert.equal(detectDaemon('/repo', run, '/user', { SQUEAL_BIN_DIR: '/custom/bin' }), '/custom/bin/squeal');
  assert.deepEqual(calls, ['squeal', '/custom/bin/squeal']);
});

test('repeats a pending round until all parity files pass', t => {
  const cwd = fixture(t);
  const files = selectFiles(cwd);
  let rounds = 0;
  let time = 0;
  const logs = [];
  const run = (command, args) => {
    if (!args.includes('--wait')) return alive(cwd);
    time += 1000;
    rounds++;
    return result({ selection: { testFiles: files.map(path => ({
      path, state: rounds === 1 ? 'pending' : 'current', verdict: rounds === 1 ? undefined : 'pass',
    })) } });
  };
  assert.equal(runParity({ cwd, args: [], run, now: () => time, log: line => logs.push(line) }), 0);
  assert.equal(rounds, 2);
  assert.ok(logs.some(line => line.includes('round 1: 0 pass, 2 pending')));
  assert.ok(logs.some(line => line.includes('round 2: 2 pass, 0 pending')));
});

test('stops pending rounds at the configured per-file cap plus five minutes', t => {
  const cwd = fixture(t);
  const files = selectFiles(cwd);
  let time = 0;
  const waits = [];
  const logs = [];
  const run = (command, args) => {
    if (!args.includes('--wait')) return alive(cwd);
    const wait = Number(args[2]);
    waits.push(wait);
    time += wait;
    return { status: 3, stdout: JSON.stringify({ selection: { testFiles:
      files.map(path => ({ path, state: 'pending' })) } }) };
  };
  assert.equal(runParity({ cwd, args: [], run, now: () => time, log: line => logs.push(line) }), 1);
  assert.deepEqual(waits, [60000, 60000, 60000, 60000, 60000, 2345]);
  assert.equal(time, 302345);
  for (const file of files) assert.ok(logs.some(line => line.startsWith(`PENDING ${file}:`)));
});

test('win32 no-daemon fallback launches npm.cmd with the same shell options as test:changed', t => {
  const cwd = fixture(t);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'where.exe') return { status: 0, stdout: 'C:\\bin\\squeal.cmd\r\n' };
    if (command === 'squeal') return result({ schemaVersion: 1, worktreeRoot: cwd, daemon: { state: 'down', since: null } });
    return { status: 0 };
  };
  assert.equal(runParity({ cwd, args: [], run, platform: 'win32', log() {} }), 0);
  const npm = calls.find(call => call.command === 'npm.cmd');
  assert.ok(npm, 'must select npm.cmd');
  assert.deepEqual(npm.options, { cwd, stdio: 'inherit', shell: true });
  assert.deepEqual(npm.args, ['test', '--', ...selectFiles(cwd)]);
});

test('win32 launches a Squeal cmd shim through a shell for detection and waits', t => {
  const cwd = fixture(t);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'where.exe') return { status: 0, stdout: 'C:\\bin\\squeal.cmd\r\n' };
    if (!args.includes('--wait')) return alive(cwd);
    return result({ selection: { testFiles: selectFiles(cwd).map(path => ({ path, state: 'current', verdict: 'pass' })) } });
  };
  assert.equal(runParity({ cwd, args: [], run, platform: 'win32', log() {} }), 0);
  const squeal = calls.filter(call => call.command === 'squeal');
  assert.equal(squeal.length, 2);
  for (const call of squeal) assert.equal(call.options.shell, true);
  assert.equal(calls[0].command, 'where.exe');
  assert.ok(!calls.some(call => call.command === 'npm.cmd'));
});

test('win32 absent Squeal uses npm instead of parsing shell not-found output', t => {
  const cwd = fixture(t);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    assert.ok(command === 'where.exe' || command === 'npm.cmd');
    return command === 'where.exe' ? { status: 1, stdout: '' } : { status: 0 };
  };
  assert.equal(runParity({ cwd, args: [], run, platform: 'win32', log() {} }), 0);
  assert.equal(calls.at(-1).command, 'npm.cmd');
  assert.equal(calls.at(-1).options.shell, true);
});
