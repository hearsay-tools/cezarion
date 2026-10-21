import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestEnvLease } from '../../.ai/scripts/test-env-lease.mjs';

async function until(check) {
  const end = Date.now() + 60_000;
  while (!check()) { assert.ok(Date.now() < end, 'native Windows operation must finish'); await delay(100); }
}
test('Windows wrapper serializes callers, preserves arguments, and kills mutators after supervisor death', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-lease-windows-'));
  const scripts = join(root, '.ai/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['test-env-lease.mjs', 'test-env-windows.ps1']) copyFileSync(resolve('.ai/scripts', file), join(scripts, file));
  const helper = join(scripts, 'test-env-lease.mjs');
  if (process.env.TEST_ENV_PROOF_BASE) {
    const old = spawnSync('git', ['show', `${process.env.TEST_ENV_PROOF_BASE}:.ai/scripts/test-env-lease.mjs`], { encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr);
    writeFileSync(helper, old.stdout);
  }
  // Native children and the escaped cached server run the exact production launcher.
  writeFileSync(join(root, 'mutator.cjs'), `require('node:fs').writeFileSync('mutator.pid', String(process.pid)); setInterval(() => {}, 1000)`);
  writeFileSync(join(root, 'cached.cjs'), 'setInterval(() => {}, 1000)');
  const script = join(root, 'mutation.sh');
  writeFileSync(script, `node .ai/scripts/test-env-lease.mjs join "$$"\nnode .ai/scripts/test-env-lease.mjs detach-app cached.log cached.cjs > cached.pid\nprintf '%s\\n' "$@" > args.txt\nnode mutator.cjs\n`);
  const env = { ...process.env, PATH: `C:\\Program Files\\Git\\bin;${process.env.PATH}` };
  for (const key of Object.keys(env)) if (key.startsWith('TEST_ENV_LEASE_')) delete env[key];
  const supervisor = spawn(process.execPath, [helper, 'run', 'sh', script, 'space value', '', 'trailing\\', 'quote"value'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  supervisor.stderr.on('data', data => { log += data; });
  const closed = once(supervisor, 'close');
  let cached;
  try {
    await until(() => { assert.equal(supervisor.exitCode, null, log); return existsSync(join(root, 'mutator.pid')); });
    const mutatorText = readFileSync(join(root, 'mutator.pid'), 'utf8').trim();
    assert.match(mutatorText, /^\d+$/);
    const mutator = Number(mutatorText);
    cached = Number(readFileSync(join(root, 'cached.pid'), 'utf8').trim());
    assert.ok(Number.isSafeInteger(cached) && cached > 0);
    assert.deepEqual(readFileSync(join(root, 'args.txt'), 'utf8').trimEnd().split('\n'), ['space value', '', 'trailing\\', 'quote"value']);
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 50 }), /timed out/);
    supervisor.kill('SIGKILL');
    await closed;
    await until(() => { try { process.kill(mutator, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
    process.kill(cached, 0);
    const next = await acquireTestEnvLease(root, { timeoutMs: 30_000 });
    next.release();
    console.log('PASS: native wrapper, shell identity, argv, exclusive lease, job cleanup, cached server survival');
  } finally {
    supervisor.kill('SIGKILL');
    if (cached) { try { process.kill(cached, 'SIGKILL'); } catch {} }
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
