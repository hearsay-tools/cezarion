import { spawn } from 'node:child_process';
import { cp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIP, type AddressInfo } from 'node:net';
import { withDirectoryLock } from './lock.js';
import { runOwnedNpm } from './npm-process.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HelperPlan {
  installation: {
    kind: 'global' | 'npx'; prefix: string; cache: string; installRoot: string;
    packageRoot: string; outerRoot: string; launchEntry: string; outerPackage: '@wjarka/cezarion' | 'cezarion'; request: string;
  };
  targetVersion: string;
  oldVersion: string;
  recovery: string;
  binLinks?: string;
  recordPath: string;
  oldPid: number;
  nodeExecutable: string;
  nodeArgs: string[];
  cliArgs: string[];
  cwd: string;
  repoRoot: string;
  host: string;
  port: number;
  npmBin: string;
  claimId: string;
}

/** Only a listening TCP server can supply the private restart destination. */
export function restartEndpoint(address: AddressInfo | string | null): Pick<HelperPlan, 'host' | 'port'> {
  if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535
    || !(isIP(address.address) === 4 && address.address.split('.')[0] === '127' || address.address === '::1')) {
    throw new Error('restart requires a bound loopback endpoint');
  }
  return { host: address.address, port: address.port };
}

export function restartHealthUrl(endpoint: Pick<HelperPlan, 'host' | 'port'>): string {
  const { host, port } = restartEndpoint({ address: endpoint.host, port: endpoint.port, family: '' });
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/v1/health`;
}

export interface RestartIO {
  waitForOldExit(): Promise<void>;
  promote(): Promise<void>;
  validateOriginal(): Promise<void>;
  launch(): Promise<void>;
  verifyHealth(): Promise<void>;
  reapReplacement(): Promise<void>;
  restore(): Promise<void>;
  launchPrevious(): Promise<void>;
  reportSuccess(): Promise<void>;
  reportFailure(rollbackFailed: boolean): Promise<void>;
  assertOwned?(): Promise<void>;
}

/** Only the helper owns the promotion transaction. Rollback waits for its child to exit. */
export async function runRestartWorkflow(io: RestartIO): Promise<void> {
  await io.waitForOldExit();
  await io.assertOwned?.();
  let replacementLaunched = false;
  try {
    await io.assertOwned?.();
    await io.promote();
    await io.assertOwned?.();
    await io.validateOriginal();
    await io.assertOwned?.();
    await io.launch();
    replacementLaunched = true;
    await io.assertOwned?.();
    await io.verifyHealth();
    await io.assertOwned?.();
    await io.reportSuccess();
  } catch {
    if (replacementLaunched) {
      try { await io.reapReplacement(); }
      catch {
        // Never mutate the installation or launch another process until the
        // helper has confirmed its replacement is gone.
        await io.assertOwned?.();
        await io.reportFailure(true);
        return;
      }
    }
    // A foreign owner may now be installing into the same tree. Preserve the
    // recovery copy and leave the stale claim for the next boot to salvage.
    await io.assertOwned?.();
    let rollbackFailed = false;
    try {
      await io.assertOwned?.();
      await io.restore();
      await io.assertOwned?.();
      await io.launchPrevious();
      await io.assertOwned?.();
    } catch {
      await io.reapReplacement().catch(() => undefined);
      await io.assertOwned?.();
      rollbackFailed = true;
    }
    await io.assertOwned?.();
    await io.reportFailure(rollbackFailed);
  }
}

function scopedPath(plan: HelperPlan): string {
  if (plan.installation.outerPackage === '@wjarka/cezarion') return plan.installation.packageRoot;
  const nested = join(plan.installation.outerRoot, 'node_modules/@wjarka/cezarion');
  if (existsSync(nested)) return nested;
  const modules = plan.installation.kind === 'npx' ? join(plan.installation.installRoot, 'node_modules')
    : dirname(plan.installation.outerRoot);
  return join(modules, '@wjarka/cezarion');
}

function validateOriginal(plan: HelperPlan, expected: string): void {
  const pkg = JSON.parse(readFileSync(join(scopedPath(plan), 'package.json'), 'utf8')) as { name?: string; version?: string; bin?: Record<string, string> };
  if (pkg.name !== '@wjarka/cezarion' || pkg.version !== expected || !existsSync(join(scopedPath(plan), 'dist/index.js')) || !existsSync(join(scopedPath(plan), 'web/dist/index.html'))) {
    throw new Error('promoted installation did not validate');
  }
  if (!existsSync(plan.installation.launchEntry)) throw new Error('original launch entry missing');
  if (plan.installation.kind === 'npx') {
    const root = JSON.parse(readFileSync(join(plan.installation.installRoot, 'package.json'), 'utf8')) as { _npx?: { packages?: string[] } };
    if (root._npx?.packages?.[0] !== plan.installation.request || root._npx.packages.length !== 1) throw new Error('npx request metadata changed');
  }
}

export function manualRepairCommand(installation: Pick<HelperPlan['installation'], 'kind' | 'prefix' | 'installRoot' | 'outerPackage'>, version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid repair version');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const prefix = installation.kind === 'global' ? installation.prefix : installation.installRoot;
  return `npm install ${installation.kind === 'global' ? '--global ' : ''}--prefix ${quote(prefix)} ${installation.outerPackage}@${version}`;
}

async function writeState(plan: HelperPlan, state: { status: string; supported: boolean; targetVersion?: string; message?: string }, repairCommand?: string): Promise<void> {
  const current = JSON.parse(await readFile(plan.recordPath, 'utf8')) as Record<string, unknown>;
  const temp = `${plan.recordPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ ...current, state, ownerPid: undefined, claimId: undefined,
    startedAt: undefined, repairCommand }), { mode: 0o600 });
  await rename(temp, plan.recordPath);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitExit(pid: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < until) await delay(100);
  if (alive(pid)) throw new Error('old server did not exit');
}

export async function promoteOriginal(plan: HelperPlan, npxLockAlreadyHeld = false, signal?: AbortSignal): Promise<void> {
  const { installation } = plan;
  const args = installation.kind === 'global'
    ? ['install', '--global', '--prefix', installation.prefix]
    : ['install', '--prefix', installation.installRoot];
  args.push('--engine-strict', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-online', '--fetch-retries=1', `${installation.outerPackage}@${plan.targetVersion}`);
  const run = async () => {
    await runOwnedNpm(plan.npmBin, args, { ...process.env, npm_config_cache: installation.cache }, signal);
  };
  if (installation.kind === 'npx' && !npxLockAlreadyHeld) {
    await withDirectoryLock(join(installation.installRoot, 'concurrency.lock'), async (assertOwned, lockSignal) => { await promoteOriginal(plan, true, lockSignal); await assertOwned(); }, 30_000);
  } else await run();
}

function launch(plan: HelperPlan): ReturnType<typeof spawn> {
  const args = [...plan.nodeArgs, plan.installation.launchEntry, ...plan.cliArgs,
    '--bind-host', plan.host, '--port', String(plan.port), '--repo', plan.repoRoot, '--no-open', '--restart-exact'];
  return spawn(plan.nodeExecutable, args, { cwd: plan.cwd, env: process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true });
}

async function verifyHealth(plan: HelperPlan, expectedVersion: string, child: ReturnType<typeof spawn>, signal?: AbortSignal): Promise<void> {
  // The private IPC channel belongs to this exact child. An unrelated healthy
  // server on the port cannot send this acknowledgement.
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => finish(new Error('replacement listener acknowledgement timed out')), 20_000);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off('message', onMessage); child.off('exit', onExit); child.off('error', onExit);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish(new Error('replacement exited before listener acknowledgement'));
    const onAbort = () => finish(new Error('update lock ownership changed'));
    const onMessage = (value: unknown) => {
      const message = value as { type?: string; host?: string; port?: number; repoRoot?: string; version?: string };
      if (message?.type !== 'application-update-listening') return;
      if (message.host !== plan.host || message.port !== plan.port || message.repoRoot !== plan.repoRoot || message.version !== expectedVersion) {
        finish(new Error('replacement listener identity mismatch')); return;
      }
      finish();
    };
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (child.exitCode !== null) onExit();
  });
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error('update lock ownership changed');
    if (child.exitCode !== null) throw new Error('replacement exited before health');
    try {
      const response = await fetch(restartHealthUrl(plan), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json() as { version?: string; repoRoot?: string };
        if (health.version === expectedVersion && health.repoRoot === plan.repoRoot) {
          if (child.connected) child.disconnect();
          child.unref(); return;
        }
        throw new Error('health identity mismatch');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'health identity mismatch') throw error;
    }
    await delay(150);
  }
  throw new Error('replacement health timed out');
}

async function reap(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  process.kill(child.pid, 'SIGTERM');
  try { await waitExit(child.pid, 3000); }
  catch { process.kill(child.pid, 'SIGKILL'); await waitExit(child.pid, 3000); }
}

export async function restoreOriginal(plan: HelperPlan, assertOwned: () => Promise<void> = async () => {}): Promise<void> {
  const { installation } = plan;
  const copy = async (from: string, to: string) => cp(from, to, { recursive: true, dereference: false,
    filter: async () => { await assertOwned(); return true; } });
  await assertOwned();
  if (installation.kind === 'npx') {
    // Preserve the live concurrency.lock directory while restoring the rest of
    // the npx root. Removing the root would compromise our own npm lock.
    for (const name of await readdir(installation.installRoot)) {
      await assertOwned();
      if (name !== 'concurrency.lock') await rm(join(installation.installRoot, name), { recursive: true, force: true });
    }
    for (const name of await readdir(plan.recovery)) {
      await assertOwned();
      if (name !== 'concurrency.lock') await copy(join(plan.recovery, name), join(installation.installRoot, name));
    }
  } else {
    const outer = installation.outerRoot;
    await assertOwned();
    await rm(outer, { recursive: true, force: true });
    await assertOwned();
    await copy(plan.recovery, outer);
    if (plan.binLinks) {
      const links = JSON.parse(await readFile(plan.binLinks, 'utf8')) as Array<{ name: string; target: string }>;
      for (const link of links) {
        await assertOwned();
        if (!/^[a-zA-Z0-9-]+$/.test(link.name)) throw new Error('invalid recovery bin name');
        const path = join(installation.prefix, 'bin', link.name);
        await rm(path, { force: true });
        await symlink(link.target, path);
      }
    }
  }
  await assertOwned();
  validateOriginal(plan, plan.oldVersion);
}

export async function runHelper(plan: HelperPlan, onArmed?: () => void): Promise<void> {
  restartHealthUrl(plan); // Reject an invalid destination before claiming or mutating the installation.
  let replacement: ReturnType<typeof spawn> | undefined;
  let transactionSignal: AbortSignal | undefined;
  const assertClaim = async (): Promise<void> => {
    const record = JSON.parse(await readFile(plan.recordPath, 'utf8')) as { state?: { status?: string; targetVersion?: string }; claimId?: string };
    if (record?.state?.status !== 'restarting' || record.state.targetVersion !== plan.targetVersion || record.claimId !== plan.claimId) {
      throw new Error('stale application update claim');
    }
  };
  const io: RestartIO = {
    waitForOldExit: () => waitExit(plan.oldPid, 20_000),
    promote: () => promoteOriginal(plan, plan.installation.kind === 'npx', transactionSignal),
    validateOriginal: async () => validateOriginal(plan, plan.targetVersion),
    launch: async () => { replacement = launch(plan); },
    verifyHealth: () => verifyHealth(plan, plan.targetVersion, replacement!, transactionSignal),
    reapReplacement: () => reap(replacement),
    restore: () => restoreOriginal(plan, io.assertOwned),
    launchPrevious: async () => { replacement = launch(plan); await verifyHealth(plan, plan.oldVersion, replacement, transactionSignal); },
    reportSuccess: async () => {
      await writeState(plan, { status: 'idle', supported: true });
      // Keep the recovery copy until a later preparation has the lock. This
      // avoids a crash gap between committing success and deleting recovery.
    },
    reportFailure: (rollbackFailed) => writeState(plan, {
      status: 'error', supported: true, targetVersion: plan.targetVersion,
      message: rollbackFailed ? 'Update and recovery failed. Reinstall cezarion manually.' : 'Update failed; previous release was restored. Retry Update.',
    }, rollbackFailed ? manualRepairCommand(plan.installation, plan.oldVersion) : undefined),
  };
  await withDirectoryLock(join(dirname(plan.recordPath), 'operation.lock'), async (assertInstallationOwned, installationSignal) => {
    const run = async (assertNpxOwned?: () => Promise<void>, npxSignal?: AbortSignal) => {
      transactionSignal = npxSignal ? AbortSignal.any([installationSignal, npxSignal]) : installationSignal;
      io.assertOwned = async () => {
        await assertInstallationOwned();
        await assertNpxOwned?.();
        if (transactionSignal?.aborted) throw new Error('update lock ownership changed');
        await assertClaim();
      };
      await io.assertOwned();
      const record = JSON.parse(await readFile(plan.recordPath, 'utf8')) as Record<string, unknown>;
      const ownerTemp = `${plan.recordPath}.${process.pid}.owner.tmp`;
      await writeFile(ownerTemp, JSON.stringify({ ...record, ownerPid: process.pid }), { mode: 0o600 });
      await io.assertOwned();
      await rename(ownerTemp, plan.recordPath);
      await io.assertOwned();
      onArmed?.();
      await runRestartWorkflow(io);
    };
    if (plan.installation.kind === 'npx') {
      await withDirectoryLock(join(plan.installation.installRoot, 'concurrency.lock'), run, 30_000);
    } else await run();
  }, 30_000);
}

if (process.send && process.argv[2] === '--application-update-helper') {
  process.once('message', (message) => {
    const plan = message as HelperPlan;
    void runHelper(plan, () => process.send?.({ type: 'armed' }, () => process.disconnect?.()))
      .catch(() => process.exit(1));
  });
}
