import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestEnvLease } from '../../../../.ai/scripts/test-env-lease.mjs';
import * as leaseDiagnostics from '../../../../.ai/scripts/test-env-lease.mjs';
import { requirePid } from '../../src/pid-file.testkit.ts';
import { checkZombieGroupChurn } from './test-env-lease-churn.testkit.mjs';

// A temporary checkout cannot join the daemon caller's lease in another checkout.
const fixtureEnv = { ...process.env };
for (const key of Object.keys(fixtureEnv)) if (key.startsWith('TEST_ENV_LEASE_')) delete fixtureEnv[key];

const helper = resolve(import.meta.dirname, '../../../../.ai/scripts/test-env-lease.mjs');

for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
  test(`a mutating child remains protected after its supervisor and shell receive ${signal}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-env-orphan-'));
    mkdirSync(join(root, '.ai/scripts'), { recursive: true });
    const localHelper = join(root, '.ai/scripts/test-env-lease.mjs');
    copyFileSync(helper, localHelper);
    writeFileSync(join(root, 'mutator.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync('mutator.pid', String(process.pid));
      process.on('SIGTERM', () => writeFileSync('term-received', 'yes'));
      setInterval(() => {}, 1000);
    `);
    const script = join(root, 'mutation.sh');
    writeFileSync(script, `node '${localHelper}' join "$$"\necho $$ > shell.pid\nnode mutator.mjs\n`);
    const supervisor = spawn(process.execPath, [localHelper, 'run', 'sh', script], { cwd: root, env: fixtureEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    supervisor.stderr!.on('data', data => { stderr += data; });
    // The surviving mutator can retain stderr after the supervisor exits.
    const closed = once(supervisor, 'exit');
    let mutator: number | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(root, 'mutator.pid'))) {
        assert.equal(supervisor.exitCode, null, `supervisor exited before mutator started: ${stderr}`);
        assert.ok(Date.now() < deadline, `mutator must start: ${stderr}`);
        await delay(20);
      }
      mutator = requirePid(join(root, 'mutator.pid'));
      supervisor.kill(signal);
      if (signal === 'SIGKILL') process.kill(requirePid(join(root, 'shell.pid')), 'SIGKILL');
      await closed;
      await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 50 }), /timed out/i);
      if (signal === 'SIGTERM') assert.equal(existsSync(join(root, 'term-received')), true, 'signal must reach descendants');
      process.kill(mutator, 'SIGKILL');
      const next = await acquireTestEnvLease(root, { timeoutMs: 1000 });
      next.release();
    } finally {
      supervisor.kill('SIGKILL');
      if (mutator) { try { process.kill(mutator, 'SIGKILL'); } catch {} }
      await closed;
      supervisor.stderr!.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a live holder blocks a different run, a valid child joins, and release removes only its own holder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-env-lease-'));
  try {
    const owner = await acquireTestEnvLease(root);
    const child = await acquireTestEnvLease(root, { token: owner.token });
    owner.release();
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 20 }), /timed out.*pid/i);
    child.release();
    const next = await acquireTestEnvLease(root, { timeoutMs: 20 });
    assert.notEqual(next.token, owner.token);
    owner.release(); // A repeated release cannot remove the new owner's row.
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 20 }), /timed out/i);
    next.release();
    await assert.rejects(acquireTestEnvLease(root, { token: owner.token }), /invalid.*lease/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a killed holder is reclaimed, without granting its old token to a later caller', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-env-lease-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireTestEnvLease } from ${JSON.stringify(helper)};
    const lease = await acquireTestEnvLease(process.argv[1]);
    console.log(lease.token);
    setInterval(() => {}, 1000);
  `, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  try {
    const token = String((await once(child.stdout!, 'data'))[0]).trim();
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 20 }), /timed out/i);
    child.kill('SIGKILL');
    await exited;
    const next = await acquireTestEnvLease(root, { timeoutMs: 500 });
    assert.notEqual(next.token, token);
    next.release();
  } finally {
    child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a reused PID is reclaimed but a live PID with unknown start identity stays protected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-env-lease-'));
  try {
    const initial = await acquireTestEnvLease(root);
    initial.release();
    const db = new DatabaseSync(join(root, '.ai/qa/test-env-lease.sqlite'));
    try {
      db.prepare('INSERT INTO holders (id, token, pid, start) VALUES (?, ?, ?, ?)')
        .run('reused', 'old-token', process.pid, 'a-different-process-start');
      const next = await acquireTestEnvLease(root, { timeoutMs: 20 });
      next.release();
      db.prepare('INSERT INTO holders (id, token, pid, start) VALUES (?, ?, ?, ?)')
        .run('unknown', 'unknown-token', process.pid, null);
      await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 20 }), /timed out/i);
      await assert.rejects(acquireTestEnvLease(root, { token: 'unknown-token' }), /invalid.*lease/i);
      assert.equal(db.prepare('SELECT count(*) AS n FROM holders').get()!.n, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Isolate the built-in fs scheduling hook from all other tests in this process.
test('a same-group fork and exit during process enumeration retains the lease', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'test-env-lease-fork.testkit.mjs'), helper], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"unrelatedLeaseGranted":false/);
});


// Keep fs scheduling hooks and stopped child ownership out of the test runner.
test('zombie-only groups under churn retain unknown leases and reclaim stable snapshots', { skip: process.platform !== 'linux' }, checkZombieGroupChurn);

test('lease diagnostics name every holder command in both wait and timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-env-diagnostics-'));
  let owner;
  let participant;
  try {
    owner = await acquireTestEnvLease(root);
    participant = await acquireTestEnvLease(root, { token: owner.token });
    const messages: string[] = [];
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: process.platform === 'win32' ? 15_000 : process.platform === 'darwin' ? 2000 : 200, onWait: message => messages.push(message) }), error => {
      assert.match((error as Error).message, /the active environment was left unchanged/);
      assert.equal(((error as Error).message.match(new RegExp(`pid ${process.pid} [(]`, 'g')) ?? []).length, 2);
      return true;
    });
    assert.equal(messages.length, 1);
    assert.equal((messages[0]!.match(new RegExp(`pid ${process.pid} [(]`, 'g')) ?? []).length, 2);
    assert.match(messages[0]!, /node/);
  } finally {
    participant?.release();
    owner?.release();
    rmSync(root, { recursive: true, force: true });
  }
});


test('holder diagnostics fall back to PID when command or verified identity is absent', () => {
  const holder = { pid: 1234, start: 'same-start' };
  const fallback = { owners: 'pid 1234', guidance: '' };
  for (const command of [() => undefined, () => [], () => { throw new Error('access denied'); }]) {
    assert.deepEqual(leaseDiagnostics.describeTestEnvHolders([holder], {
      identify: () => ({ start: holder.start }), command,
    }), fallback);
  }
  for (const current of [{}, { dead: true }, { start: 'reused-start' }]) {
    assert.deepEqual(leaseDiagnostics.describeTestEnvHolders([holder], {
      identify: () => current, command: () => { assert.fail('must not read an unverified command'); },
    }), fallback);
  }
  assert.deepEqual(leaseDiagnostics.describeTestEnvHolders([{ ...holder, start: null }], {
    identify: () => ({ start: holder.start }), command: () => { assert.fail('must not read an unverified command'); },
  }), fallback);
  let probes = 0;
  assert.deepEqual(leaseDiagnostics.describeTestEnvHolders([holder], {
    identify: () => ({ start: ++probes === 1 ? holder.start : 'reused-during-read' }),
    command: () => ['node', 'other.mjs'],
  }), fallback);
});

test('holder command summaries are bounded and single-line without changing stored holder rows', () => {
  const holder = Object.freeze({ pid: 1234, start: 'same-start' });
  const result = leaseDiagnostics.describeTestEnvHolders([holder], {
    identify: () => ({ start: holder.start }), command: () => ['node', 'x'.repeat(300) + '.mjs', 'test\n\r\t\x1b\x7f\x85'],
  });
  assert.equal(result.owners.length, 'pid 1234 ()'.length + 200);
  assert.ok(result.owners.endsWith('…)'));
  assert.doesNotMatch(result.owners, /[\x00-\x1f\x7f-\x9f]/);
  assert.deepEqual(holder, { pid: 1234, start: 'same-start' });
});

test('Squeal guidance requires the daemon entrypoint and checks before display truncation', () => {
  const holder = { pid: 1234, start: 'same-start' };
  const daemon = '/plugin/' + 'long-path/'.repeat(30) + 'dist/cli/squeal.mjs';
  const describe = (command: string[] | { text: string }) => leaseDiagnostics.describeTestEnvHolders([holder], {
    identify: () => ({ start: holder.start }), command: () => command,
  });
  for (const command of [
    ['node', daemon, 'daemon', '/repo'],
    ['/bin/node', '--disable-warning=ExperimentalWarning', daemon, 'daemon', '/repo'],
    { text: '"C:\\Program Files\\nodejs\\node.exe" "C:\\squeal\\dist\\cli\\squeal.mjs" daemon "C:\\my repo"' },
    { text: '/bin/node --no-warnings "/plugin with spaces/dist/cli/squeal.mjs" daemon /repo' },
  ]) {
    assert.match(describe(command).guidance, /If Squeal covers this spec.*squeal status --wait 60000/);
  }
  for (const command of [
    ['node', 'other.mjs', daemon, 'daemon'],
    ['node', '-e', 'squeal daemon', daemon, 'daemon'],
    ['node', daemon, 'status'],
    ['echo', daemon, 'daemon'],
    ['node', '/other/squeal.mjs', 'daemon'],
    { text: 'echo "node /plugin/dist/cli/squeal.mjs daemon"' },
  ]) assert.equal(describe(command).guidance, '');
});

test('Squeal daemon contention includes conditional result guidance in wait and timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-env-squeal-diagnostics-'));
  const cli = join(root, 'dist/cli/squeal.mjs');
  mkdirSync(join(root, 'dist/cli'), { recursive: true });
  writeFileSync(cli, `
    import { acquireTestEnvLease } from ${JSON.stringify(helper)};
    await acquireTestEnvLease(process.argv[3]);
    console.log('ready');
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [cli, 'daemon', root], { env: fixtureEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  try {
    await once(child.stdout!, 'data');
    const messages: string[] = [];
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 5000, onWait: message => messages.push(message) }), error => {
      assert.match((error as Error).message, /squeal\.mjs/);
      assert.match((error as Error).message, /If Squeal covers this spec.*squeal status --wait 60000/);
      return true;
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /squeal status --wait 60000/);
  } finally {
    child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic probes share the remaining deadline and stop after it expires', () => {
  let clock = 0;
  const calls: { kind: string; remaining: number | undefined }[] = [];
  const result = leaseDiagnostics.describeTestEnvHolders([{ pid: 1, start: 'start' }, { pid: 2, start: 'start' }], {
    now: () => clock, deadline: 15,
    identify: (_pid, remaining) => { calls.push({ kind: 'identity', remaining }); clock += 5; return { start: 'start' }; },
    command: (_pid, remaining) => { calls.push({ kind: 'command', remaining }); clock += 20; return ['node', 'worker.mjs']; },
  });
  assert.deepEqual(calls, [{ kind: 'identity', remaining: 15 }, { kind: 'command', remaining: 10 }]);
  assert.deepEqual(result, { owners: 'pid 1, pid 2', guidance: '' });
});

test('an expired diagnostic deadline performs no process probes', () => {
  let probes = 0;
  const result = leaseDiagnostics.describeTestEnvHolders([{ pid: 1, start: 'start' }], {
    now: () => 10, deadline: 10,
    identify: () => { probes++; return { start: 'start' }; },
    command: () => { probes++; return ['node', 'worker.mjs']; },
  });
  assert.equal(probes, 0);
  assert.deepEqual(result, { owners: 'pid 1', guidance: '' });
});

test('lease diagnostics omit credential-bearing arguments and inline code', () => {
  for (const command of [
    ['node', '/repo/worker.mjs', '--token', 'credential-value', 'https://user:password@example.test/?key=secret'],
    ['sh', '-c', 'echo inline-credential'],
    ['node', '-e', 'console.log("inline-credential")'],
    { text: 'node /repo/worker.mjs --token=credential-value AUTH=secret' },
    { text: '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\worker.mjs" --token credential-value' },
  ]) {
    const result = leaseDiagnostics.describeTestEnvHolders([{ pid: 1, start: 'start' }], {
      identify: () => ({ start: 'start' }), command: () => command,
    });
    assert.doesNotMatch(result.owners, /credential|password|secret|console\.log|https:/);
    assert.match(result.owners, /pid 1 \((node(?:\.exe)?|sh).*arguments omitted/);
  }
});

test('lease timeout reuses the initial command snapshot without another process query', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'test-env-lease-diagnostics.testkit.mjs'), helper], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
