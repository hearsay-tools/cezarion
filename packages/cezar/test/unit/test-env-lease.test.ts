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
import { requirePid } from '../../src/pid-file.testkit.ts';

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
