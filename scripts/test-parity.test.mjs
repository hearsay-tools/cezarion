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

test('requires an alive daemon for the same worktree; a store is insufficient', () => {
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
  assert.equal(detectDaemon('/repo', run, '/user'), '/user/.local/bin/squeal');
  assert.deepEqual(calls, ['squeal', '/user/.local/bin/squeal']);
  assert.equal(detectDaemon('/repo', () => ({ error: { code: 'ENOENT' } }), '/user'), null);
  assert.throws(() => detectDaemon('/repo', () => ({ error: new Error('permission') })), /permission/);
});

for (const [state, verdict, expected] of [
  ['current', 'pass', 0], ['current', 'fail', 1], ['pending', 'pass', 1],
  ['unknown', undefined, 1], ['stale', 'pass', 1], ['current', 'skip', 1],
]) {
  test(`reports ${state}/${verdict} by file`, () => {
    const lines = [];
    assert.equal(reportVerdicts(['a'], { selection: { testFiles: [{ path: 'a', state, verdict }] } }, line => lines.push(line)), expected);
    assert.match(lines[0], /a:/);
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
