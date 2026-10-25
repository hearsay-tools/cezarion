import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestEnvLease } from '../../.ai/scripts/test-env-lease.mjs';

async function until(check, label = 'native Windows operation') {
  const end = Date.now() + 60_000;
  while (!check()) { assert.ok(Date.now() < end, `${label} must finish`); await delay(100); }
}
test('Windows wrapper serializes callers, preserves arguments, and kills mutators after supervisor death', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-lease-windows-'));
  const scripts = join(root, '.ai/scripts');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['test-env-lease.mjs', 'test-env-windows.ps1']) copyFileSync(resolve('.ai/scripts', file), join(scripts, file));
  // The lease imports the process-group helper from source; the marker makes it an ES module.
  mkdirSync(join(root, 'packages/cezar/src'), { recursive: true });
  copyFileSync(resolve('packages/cezar/src/detached-process.ts'), join(root, 'packages/cezar/src/detached-process.ts'));
  writeFileSync(join(root, 'packages/cezar/src/package.json'), '{"type":"module"}\n');
  const helper = join(scripts, 'test-env-lease.mjs');
  if (process.env.TEST_ENV_PROOF_BASE) {
    const old = spawnSync('git', ['show', `${process.env.TEST_ENV_PROOF_BASE}:.ai/scripts/test-env-lease.mjs`], { encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr);
    writeFileSync(helper, old.stdout);
    const oldPs = spawnSync('git', ['show', `${process.env.TEST_ENV_PROOF_BASE}:.ai/scripts/test-env-windows.ps1`], { encoding: 'utf8' });
    // The identity-only proof predates this helper; the containment proof has it.
    if (oldPs.status === 0) writeFileSync(join(scripts, 'test-env-windows.ps1'), oldPs.stdout);
  }
  // Native children and the escaped cached server run the exact production launcher.
  writeFileSync(join(root, 'mutator.cjs'), `require('node:fs').writeFileSync('mutator.pid', String(process.pid)); require('node:fs').writeFileSync('job.txt', process.env.TEST_ENV_LEASE_JOB); setInterval(() => {}, 1000)`);
  writeFileSync(join(root, 'cached.cjs'), `require('node:fs').writeFileSync('cached-env.json', JSON.stringify({ dryRun: process.env.CEZ_DRY_RUN, home: process.env.CEZ_HOME, preview: process.env.CEZ_PREVIEW, leaseKeys: Object.keys(process.env).filter(key => key.startsWith('TEST_ENV_LEASE_')) })); setInterval(() => {}, 1000)`);
  const script = join(root, 'mutation.sh');
  writeFileSync(script, `node .ai/scripts/test-env-lease.mjs join "$$"\nexport CEZ_DRY_RUN=1 CEZ_HOME=isolated-bootstrap-home CEZ_PREVIEW=1\nnode .ai/scripts/test-env-lease.mjs detach-app cached.log cached.cjs > cached.pid\nprintf '%s\\n' "$@" > args.txt\nnode mutator.cjs\n`);
  const outer = join(root, 'outer.sh');
  writeFileSync(outer, `node .ai/scripts/test-env-lease.mjs run sh mutation.sh "$@"\n`);
  const env = { ...process.env, PATH: `C:\\Program Files\\Git\\bin;${process.env.PATH}` };
  for (const key of Object.keys(env)) if (key.startsWith('TEST_ENV_LEASE_')) delete env[key];
  const supervisor = spawn(process.execPath, [helper, 'run', 'sh', outer, 'space value', '', 'trailing\\', 'quote"value'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stage = message => console.log(`Windows lease: ${message}`);
  let log = '';
  supervisor.stdout.on('data', data => { log += data; });
  supervisor.stderr.on('data', data => { log += data; });
  const exited = new Promise(resolveExit => supervisor.once('exit', resolveExit));
  const closed = new Promise(resolveClose => supervisor.once('close', resolveClose));
  stage(`supervisor started pid=${supervisor.pid}`);
  let cached;
  let mutator;
  try {
    await until(() => { assert.equal(supervisor.exitCode, null, log); return existsSync(join(root, 'mutator.pid')); });
    stage('mutator started');
    const mutatorText = readFileSync(join(root, 'mutator.pid'), 'utf8').trim();
    assert.match(mutatorText, /^\d+$/);
    mutator = Number(mutatorText);
    cached = Number(readFileSync(join(root, 'cached.pid'), 'utf8').trim());
    assert.ok(Number.isSafeInteger(cached) && cached > 0);
    assert.deepEqual(readFileSync(join(root, 'args.txt'), 'utf8').trimEnd().split('\n'), ['space value', '', 'trailing\\', 'quote"value']);
    const jobName = readFileSync(join(root, 'job.txt'), 'utf8');
    const membership = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Membership { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr OpenJobObject(uint a,bool i,string n); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a,bool i,int p); [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r); }'; $j=[Membership]::OpenJobObject(4,$false,'${jobName}'); $p=[Membership]::OpenProcess(0x1000,$false,${mutator}); $r=$false; $ok=[Membership]::IsProcessInJob($p,$j,[ref]$r); Write-Output "job=$j process=$p queried=$ok member=$r"`], { encoding: 'utf8', timeout: 10_000 });
    stage(`mutator job membership: ${membership.stdout}; ${membership.stderr}`);
    assert.match(membership.stdout, /queried=True member=True/, 'mutator must belong to the lifetime job');
    stage('arguments verified; testing exclusion');
    await assert.rejects(acquireTestEnvLease(root, { timeoutMs: 50 }), /timed out/);
    stage('exclusion verified; killing supervisor');
    supervisor.kill('SIGKILL');
    await exited;
    stage('supervisor exited; checking mutator cleanup');
    // Start recovery immediately: it must never grant while a mutator is live.
    const next = await acquireTestEnvLease(root, { timeoutMs: 30_000 });
    try {
      assert.throws(() => process.kill(mutator, 0), { code: 'ESRCH' });
      stage('lease reclaimed with mutator stopped; checking cached server');
      assert.doesNotThrow(() => process.kill(cached, 0), 'cached server must survive every enclosing job');
      await until(() => existsSync(join(root, 'cached-env.json')), 'cached-app environment receipt');
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'cached-env.json'), 'utf8')), { dryRun: '1', home: 'isolated-bootstrap-home', preview: '1', leaseKeys: [] }, 'cached app must inherit bootstrap environment without lease secrets');
    } finally { next.release(); }
    console.log('PASS: native wrapper, shell identity, argv, exclusive lease, job cleanup, cached server survival');
  } finally {
    supervisor.kill('SIGKILL');
    if (cached) { try { process.kill(cached, 'SIGKILL'); } catch {} }
    // A descendant can retain the inherited pipes after the supervisor exits.
    // Bound cleanup so a failed assertion remains visible in the native log.
    await Promise.race([closed, delay(2000)]);
    supervisor.stdout.destroy();
    supervisor.stderr.destroy();
    stage(`cleanup; captured output: ${log}`);
    const snapshot = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${mutator || 0} -or $_.ParentProcessId -eq ${supervisor.pid} } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json`], { encoding: 'utf8', timeout: 10_000 });
    stage(`native process snapshot: ${snapshot.stdout}; ${snapshot.stderr}`);
    if (mutator) { try { process.kill(mutator, 'SIGKILL'); } catch {} }
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { stage(`fixture cleanup: ${error.message}`); }
  }
});
