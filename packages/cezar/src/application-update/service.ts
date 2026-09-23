import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { applicationUpdateStateSchema, type ApplicationUpdateState } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { isNewerVersion } from '../update-check.ts';
import { discoverInstallation, type Installation } from './discovery.ts';
import { LockBusyError, withDirectoryLock } from './lock.ts';
import { runOwnedNpm } from './npm-process.ts';
import { snapshotGlobalBins, windowsGlobalLayout } from './bin-recovery.ts';
import { globalBinDir } from '../install-as-command.ts';

const PACKAGE = '@wjarka/cezarion';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_MESSAGES = new Set([
  'Update this installation manually.', 'Update was interrupted. Retry Update.',
  'Prepared update is missing. Retry Update.', 'Preparation failed. Retry Update or update manually.',
  'Update failed; previous release was restored. Retry Update.',
  'Update and recovery failed. Reinstall cezarion manually.', 'Update state needs retry.',
]);

export class ApplicationUpdateConflictError extends Error {}
export class ApplicationUpdateFailureError extends Error {
  constructor(message: string, readonly status: 409 | 503 = 503) { super(message); }
}

export interface ApplicationUpdateServiceLike {
  snapshot(): ApplicationUpdateState;
  apply(): Promise<ApplicationUpdateState>;
  restart(): Promise<ApplicationUpdateState>;
  afterResponse?(): void;
  onStateChange?(listener: () => void): void;
}

export interface ApplicationUpdateOptions {
  packageRoot: string;
  launchEntry: string;
  npmPrefix: string;
  npmCache: string;
  npmBin?: string;
  home: string;
  targetVersion: () => string | undefined;
  runNpm?: (args: string[], signal?: AbortSignal) => Promise<void>;
  armRestart?: (plan: RestartPlan) => Promise<number | void>;
  handoff?: () => void;
  onChange?: () => void;
  dryRun?: boolean;
  /** Test-only bounded contention override; normal operation waits 15 seconds. */
  lockWaitMs?: number;
}

export interface RestartPlan {
  installation: Exclude<Installation, { kind: 'unsupported' }>;
  targetVersion: string;
  oldVersion: string;
  stage: string;
  recovery: string;
  binLinks?: string;
  recordPath: string;
  claimId: string;
}

const recordSchema = z.object({
  state: applicationUpdateStateSchema,
  stage: z.string().optional(), recovery: z.string().optional(), binLinks: z.string().optional(),
  ownerPid: z.number().int().positive().optional(), claimId: z.uuid().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  repairCommand: z.string().max(2048).optional(),
}).strict();
type RecordShape = z.infer<typeof recordSchema>;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function packageVersion(path: string): string {
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== PACKAGE || typeof manifest.version !== 'string') throw new Error('package identity mismatch');
  return manifest.version;
}

/** Validate the npm result, not merely its exit code. */
export function validateInstalledPackage(path: string, expectedVersion: string, installRoot: string = path): void {
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
    name?: unknown; version?: unknown; engines?: { node?: string }; dependencies?: Record<string, string>; bin?: Record<string, string>;
  };
  if (manifest.name !== PACKAGE || manifest.version !== expectedVersion) throw new Error('staged package version mismatch');
  if (!manifest.bin || !Object.values(manifest.bin).some((entry) => entry === 'dist/index.js')) throw new Error('staged CLI entry missing');
  if (!existsSync(join(path, 'dist/index.js')) || !existsSync(join(path, 'web/dist/index.html'))) throw new Error('staged package assets incomplete');
  const html = readFileSync(join(path, 'web/dist/index.html'), 'utf8');
  for (const [, asset] of html.matchAll(/(?:src|href)=["']\/assets\/([A-Za-z0-9._/-]+)["']/g)) {
    if (!asset || asset.includes('..') || !existsSync(join(path, 'web/dist/assets', asset))) {
      throw new Error('staged web assets incomplete');
    }
  }
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') throw new Error('staged dependencies missing');
  if (manifest.engines?.node && !/^>=?\s*\d+/.test(manifest.engines.node)) throw new Error('unsupported engine declaration');
  // npm's engine-strict flag verifies engine compatibility and installs the declared runtime tree.
  for (const name of Object.keys(manifest.dependencies)) {
    let cursor = path;
    let present = false;
    while (cursor.startsWith(installRoot)) {
      if (existsSync(join(cursor, 'node_modules', name))) { present = true; break; }
      if (cursor === installRoot) break;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!present) {
      throw new Error('staged runtime dependencies incomplete');
    }
  }
}

function stageScopedPath(stage: string, outer: string): string {
  const nested = join(stage, 'node_modules/cezarion/node_modules/@wjarka/cezarion');
  return outer === 'cezarion' && existsSync(nested) ? nested : join(stage, 'node_modules/@wjarka/cezarion');
}

export class ApplicationUpdateService implements ApplicationUpdateServiceLike {
  private readonly installation: Installation;
  private readonly recordPath: string;
  private readonly dir: string;
  private record: RecordShape;
  private applying?: Promise<ApplicationUpdateState>;
  private handoffArmed = false;
  private armingRestart = false;
  private listener?: () => void;
  private lockLost = false;

  constructor(private readonly options: ApplicationUpdateOptions) {
    this.installation = discoverInstallation({ prefix: options.npmPrefix, cache: options.npmCache, packageRoot: options.packageRoot, launchEntry: options.launchEntry });
    const identity = this.installation.kind === 'unsupported' ? resolve(options.packageRoot)
      : `${this.installation.kind}\0${this.installation.installRoot}\0${this.installation.outerPackage}`;
    this.dir = join(options.home, 'application-updates', createHash('sha256').update(identity).digest('hex'));
    this.recordPath = join(this.dir, 'state.json');
    this.record = { state: this.installation.kind === 'unsupported' && !options.dryRun
      ? { status: 'idle', supported: false, message: 'Update this installation manually.' }
      : { status: 'idle', supported: true } };
    this.refreshRecord();
  }

  private refreshRecord(): void {
    if (this.installation.kind === 'unsupported' && !this.options.dryRun) return;
    let unknownRecord: unknown;
    try { unknownRecord = JSON.parse(readFileSync(this.recordPath, 'utf8')) as unknown; }
    catch {
      if (existsSync(this.recordPath)) this.record = { state: { status: 'error', supported: true, message: 'Update state needs retry.' } };
      else if (!this.applying) this.record = { state: { status: 'idle', supported: true } };
      return;
    }
    const parsed = recordSchema.safeParse(unknownRecord);
    if (!parsed.success) { this.record = { state: { status: 'error', supported: true, message: 'Update state needs retry.' } }; return; }
    const loaded = parsed.data;
    const stage = join(this.dir, 'stage');
    const recovery = join(this.dir, 'recovery');
    const bad = loaded.state.supported !== true
      || (loaded.state.message !== undefined && !SAFE_MESSAGES.has(loaded.state.message))
      || (loaded.state.targetVersion !== undefined && !VERSION_RE.test(loaded.state.targetVersion))
      || (loaded.stage !== undefined && loaded.stage !== stage)
      || (loaded.recovery !== undefined && loaded.recovery !== recovery)
      || (loaded.binLinks !== undefined && loaded.binLinks !== join(this.dir, 'bin-links.json'))
      || (loaded.state.status === 'restarting' && !loaded.claimId && !this.options.dryRun)
      || (!this.options.dryRun && ['preparing', 'restarting'].includes(loaded.state.status)
        && (!loaded.startedAt || Date.now() - loaded.startedAt > (loaded.state.status === 'preparing' ? 180_000 : 360_000)));
    if (bad) { this.record = { state: { status: 'error', supported: true, message: 'Update state needs retry.' } }; return; }
    this.record = loaded;
    if (!this.options.dryRun && (loaded.state.status === 'preparing' || loaded.state.status === 'restarting')
      && (!loaded.ownerPid || !pidAlive(loaded.ownerPid))) {
      this.record.state = { status: 'error', supported: true, message: 'Update was interrupted. Retry Update.' };
    }
    if (!this.options.dryRun && loaded.state.status === 'ready') {
      try {
        if (!loaded.stage || !loaded.recovery || !loaded.state.targetVersion || !existsSync(stage) || !existsSync(recovery)) {
          throw new Error('prepared files missing');
        }
        const stagedScoped = stageScopedPath(stage, this.installation.kind === 'unsupported' ? PACKAGE : this.installation.outerPackage);
        validateInstalledPackage(stagedScoped, loaded.state.targetVersion, stage);
        if (this.installation.kind !== 'unsupported' && this.installation.outerPackage === 'cezarion') {
          const alias = JSON.parse(readFileSync(join(stage, 'node_modules/cezarion/package.json'), 'utf8')) as { version?: string };
          if (alias.version !== loaded.state.targetVersion) throw new Error('alias version mismatch');
        }
      } catch {
        this.record.state = { status: 'error', supported: true, message: 'Prepared update is missing. Retry Update.' };
      }
    }
  }

  snapshot(): ApplicationUpdateState {
    this.refreshRecord();
    if (this.lockLost && ['preparing', 'restarting'].includes(this.record.state.status)) {
      return { status: 'error', supported: true, message: 'Update was interrupted. Retry Update.' };
    }
    if (this.record.state.status !== 'preparing' && this.record.state.status !== 'restarting') this.lockLost = false;
    return this.record.state;
  }

  private async persist(state: ApplicationUpdateState, extra: Partial<RecordShape> = {}, assertOwned?: () => Promise<void>): Promise<void> {
    assertCezarHomeWriteIsSandboxed(this.recordPath);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.record = { ...this.record, ...extra, state };
    const temp = `${this.recordPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.record), { mode: 0o600 });
    await assertOwned?.();
    await rename(temp, this.recordPath);
    this.options.onChange?.();
    this.listener?.();
  }

  onStateChange(listener: () => void): void { this.listener = listener; }

  apply(): Promise<ApplicationUpdateState> {
    if (this.applying) return this.applying;
    this.refreshRecord();
    this.applying = this.prepare().finally(() => { this.applying = undefined; });
    return this.applying;
  }

  private async prepare(): Promise<ApplicationUpdateState> {
    if (this.options.dryRun) {
      const target = this.options.targetVersion();
      const old = packageVersion(this.options.packageRoot);
      if (!target || !VERSION_RE.test(target) || !isNewerVersion(target, old)) throw new ApplicationUpdateConflictError('No newer release is available.');
      await this.persist({ status: 'preparing', supported: true, targetVersion: target });
      await this.persist({ status: 'ready', supported: true, targetVersion: target });
      return this.record.state;
    }
    const installation = this.installation;
    if (installation.kind === 'unsupported') throw new ApplicationUpdateConflictError('Update this installation manually.');
    const target = this.options.targetVersion();
    const oldVersion = packageVersion(installation.packageRoot);
    if (!target || !VERSION_RE.test(target) || !isNewerVersion(target, oldVersion)) throw new ApplicationUpdateConflictError('No newer release is available.');
    this.refreshRecord();
    if (this.record.state.targetVersion === target && ['ready', 'restarting'].includes(this.record.state.status)) return this.record.state;
    const stage = join(this.dir, 'stage');
    const recovery = join(this.dir, 'recovery');
    const binLinks = join(this.dir, 'bin-links.json');
    let enteredLock = false;
    try {
      const originalPath = installation.kind === 'npx' ? installation.installRoot : installation.outerRoot;
      const writable = await stat(originalPath);
      if ((writable.mode & 0o222) === 0) throw new ApplicationUpdateFailureError('Original installation is not writable. Update manually.', 409);
      try { await access(originalPath, fsConstants.W_OK); }
      catch { throw new ApplicationUpdateFailureError('Original installation is not writable. Update manually.', 409); }
      assertCezarHomeWriteIsSandboxed(this.dir);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      return await withDirectoryLock(join(this.dir, 'operation.lock'), async (assertOwned, signal) => {
        enteredLock = true;
        try {
          this.refreshRecord();
          if (this.record.state.targetVersion === target && ['ready', 'restarting'].includes(this.record.state.status)) return this.record.state;
          if (this.record.state.status === 'restarting') throw new ApplicationUpdateConflictError('Restart is already in progress.');
          await this.persist({ status: 'preparing', supported: true, targetVersion: target }, { ownerPid: process.pid, startedAt: Date.now() }, assertOwned);
          await assertOwned();
          await rm(stage, { recursive: true, force: true });
          await rm(recovery, { recursive: true, force: true });
          await mkdir(stage, { recursive: true });
          const spec = `${installation.outerPackage}@${target}`;
          if (!this.options.dryRun) {
            const args = ['install', '--prefix', stage, '--engine-strict', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-online', '--fetch-retries=1', spec];
            await (this.options.runNpm ?? ((argv, abortSignal) => this.runNpm(argv, abortSignal)))(args, signal);
          } else {
            await cp(installation.installRoot, stage, { recursive: true });
          }
          await assertOwned();
          const stagedScoped = stageScopedPath(stage, installation.outerPackage);
          validateInstalledPackage(stagedScoped, target, stage);
          if (installation.outerPackage === 'cezarion') {
            const alias = JSON.parse(await readFile(join(stage, 'node_modules/cezarion/package.json'), 'utf8')) as { version?: string };
            if (alias.version !== target) throw new Error('alias release has not been published yet');
          }
          // The affected npm installation and command links survive until the new boot is proven.
          await cp(installation.kind === 'npx' ? installation.installRoot : installation.outerRoot,
            recovery, { recursive: true, dereference: false,
              filter: async () => { await assertOwned(); return true; } });
          if (installation.kind === 'global') {
            const outer = JSON.parse(await readFile(join(installation.outerRoot, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
            const windows = windowsGlobalLayout(installation.prefix, installation.outerRoot, installation.outerPackage);
            await snapshotGlobalBins(globalBinDir(installation.prefix, windows ? 'win32' : 'linux'),
              Object.keys(outer.bin ?? {}), windows, binLinks, assertOwned);
          }
          await assertOwned();
          await this.persist({ status: 'ready', supported: true, targetVersion: target }, { stage, recovery,
            binLinks: installation.kind === 'global' ? binLinks : undefined, ownerPid: undefined,
            claimId: undefined, startedAt: undefined }, assertOwned);
          return this.record.state;
        } catch (cause) {
          if (cause instanceof ApplicationUpdateConflictError) throw cause;
          await assertOwned();
          try {
            await this.persist({ status: 'error', supported: true, targetVersion: target,
              message: 'Preparation failed. Retry Update or update manually.' }, {}, assertOwned);
          } catch (failure) {
            if (failure instanceof Error && failure.message === 'update lock ownership changed') throw failure;
            throw new ApplicationUpdateFailureError('Update storage is not writable. Update manually.');
          }
          throw cause;
        }
      }, this.options.lockWaitMs);
    } catch (cause) {
      if (cause instanceof LockBusyError) {
        this.refreshRecord();
        throw new ApplicationUpdateConflictError('Another update is running. Retry shortly.');
      }
      if (cause instanceof Error && (cause.message === 'update lock ownership changed' || cause.name === 'AbortError')) {
        this.lockLost = true;
        this.listener?.();
        throw new ApplicationUpdateConflictError('Another update owns this installation. Retry shortly.');
      }
      if (cause instanceof ApplicationUpdateConflictError) throw cause;
      if (!enteredLock) {
        try {
          assertCezarHomeWriteIsSandboxed(this.dir);
          await mkdir(this.dir, { recursive: true, mode: 0o700 });
          await withDirectoryLock(join(this.dir, 'operation.lock'), async (assertOwned) => {
            this.refreshRecord();
            if (this.record.state.status === 'ready' || this.record.state.status === 'restarting'
              || this.record.state.status === 'preparing') return;
            await this.persist({ status: 'error', supported: true, targetVersion: target,
              message: 'Preparation failed. Retry Update or update manually.' }, {}, assertOwned);
          }, this.options.lockWaitMs);
        } catch (failure) {
          if (failure instanceof LockBusyError) throw new ApplicationUpdateConflictError('Another update is running. Retry shortly.');
          if (failure instanceof Error && failure.message === 'update lock ownership changed') {
            this.lockLost = true;
            throw new ApplicationUpdateConflictError('Another update owns this installation. Retry shortly.');
          }
          throw new ApplicationUpdateFailureError('Update storage is not writable. Update manually.');
        }
      }
      if (cause instanceof ApplicationUpdateFailureError) throw cause;
      throw new Error('Application update preparation failed. Retry Update.', { cause });
    }
  }

  async restart(): Promise<ApplicationUpdateState> {
    if (this.armingRestart) throw new ApplicationUpdateConflictError('Restart is already being armed.');
    if (this.options.dryRun) {
      if (this.record.state.status !== 'ready') throw new ApplicationUpdateConflictError('Prepare an update before restarting.');
      await this.persist({ ...this.record.state, status: 'restarting' });
      this.handoffArmed = true;
      return this.record.state;
    }
    if (this.installation.kind === 'unsupported') throw new ApplicationUpdateConflictError('Update this installation manually.');
    const installation = this.installation;
    this.refreshRecord();
    if (this.record.state.status !== 'ready') throw new ApplicationUpdateConflictError('Prepare an update before restarting.');
    this.armingRestart = true;
    try {
      const plan = await withDirectoryLock(join(this.dir, 'operation.lock'), async (assertOwned) => {
        this.refreshRecord();
        if (this.record.state.status !== 'ready' || !this.record.stage || !this.record.recovery || !existsSync(this.record.stage)) {
          throw new ApplicationUpdateConflictError('Prepare an update before restarting.');
        }
        const target = this.record.state.targetVersion!;
        const claimId = randomUUID();
        const plan: RestartPlan = { installation,
          targetVersion: target, oldVersion: packageVersion(installation.packageRoot), stage: this.record.stage,
          recovery: this.record.recovery, binLinks: this.record.binLinks, recordPath: this.recordPath, claimId };
        await this.persist({ status: 'restarting', supported: true, targetVersion: target }, { ownerPid: process.pid, claimId, startedAt: Date.now() });
        await assertOwned();
        return plan;
      });
      try {
        if (!this.options.armRestart) throw new ApplicationUpdateFailureError('Restart helper is unavailable. Retry Restart.');
        await this.options.armRestart(plan);
        const acknowledged = this.snapshot();
        if (this.record.claimId !== plan.claimId || acknowledged.status !== 'restarting') {
          throw new ApplicationUpdateConflictError('Restart claim changed before acknowledgement.');
        }
        this.handoffArmed = true;
        return this.record.state;
      } catch (error) {
        await withDirectoryLock(join(this.dir, 'operation.lock'), async (assertOwned) => {
          this.refreshRecord();
          if (this.record.claimId === plan.claimId && this.record.state.status === 'restarting') {
            await assertOwned();
            await this.persist({ status: 'ready', supported: true, targetVersion: plan.targetVersion },
              { ownerPid: undefined, claimId: undefined, startedAt: undefined });
          }
        });
        throw error;
      }
    } catch (error) {
      if (error instanceof LockBusyError) throw new ApplicationUpdateConflictError('Another update is running. Retry shortly.');
      throw error;
    } finally { this.armingRestart = false; }
  }

  afterResponse(): void {
    if (!this.handoffArmed) return;
    this.handoffArmed = false;
    if (this.options.dryRun) {
      this.record.state = { status: 'idle', supported: true };
      assertCezarHomeWriteIsSandboxed(this.recordPath);
      writeFileSync(this.recordPath, JSON.stringify(this.record), { mode: 0o600 });
      this.options.onChange?.(); this.listener?.();
      return;
    }
    this.options.handoff?.();
  }

  private async runNpm(args: string[], signal?: AbortSignal): Promise<void> {
    const env = { ...process.env, npm_config_cache: this.installation.kind === 'unsupported' ? '' : this.installation.cache };
    await runOwnedNpm(this.options.npmBin ?? 'npm', args, env, signal);
  }
}
