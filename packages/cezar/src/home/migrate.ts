import { POWERSHELL, powershellEnv } from '../core/process-stat.ts';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import { homePaths, type Home } from './home.ts';
import { assertHomePath } from './boundary.ts';
import { createInstallMarker, readInstallMarker, underTestRunner, writeMigrationMarker, assertHomeReadable } from './install-marker.ts';
import { claimMigration, removeStaleMigrationClaim } from './migration-claim.ts';
import { copyMigrationAccounts } from './migration-accounts.ts';
import { insideDirectory, migrationFiles, migrationPrivacy, replacePrivateTree, writeLegacyArchive } from './migration-files.ts';
import { archiveExcludes, isSquawkMigrationJson, migrationRecordFor, planLegacyMigration, type MigrationPlan } from './migration-plan.ts';
import { migrationRecordSchema, movedHomeSchema, readMigrationRecord, writeMigrationRecord, type MigrationFile, type MigrationRecord } from './migration-record.ts';
import { registryFiles } from './entry-authorization.ts';
import { privateDirectory, protectPrivatePath, replacePrivate, syncDirectory } from './private-files.ts';
import { readCockpitLeases } from './leases.ts';
import { getHomeRecovery } from './recovery.ts';
import { LEGACY_RECOVERY_COMMAND } from './migration-cli.ts';
import { withHomeLock } from './write-lock.ts';
import { digest, readBytes, VersionLog } from './version-log.ts';
import { loadWorkspaceConfigSync, mergeWriteWorkspaceConfigSync } from '../workspace/config.ts';
import { pathHook, writeLaunchers } from '../managed-install/launcher.ts';
import { readManifest, PACKAGE_NAME } from '../managed-install/layout.ts';

export type MigrationStep = 'recovered' | 'claimed' | 'pending' | 'archived' | 'copied' | 'recheck' | 'accounts' | 'committed';
export interface MigrationOptions {
  commit?: boolean;
  /** Fault injection and progress observation. Synchronous: never yield while a lock is held. */
  onStep?: (step: MigrationStep, attempt: number) => void;
  env?: NodeJS.ProcessEnv;
}
export interface MigrationResult { status: 'fresh' | 'migrated' | 'unchanged' | 'pending'; record?: MigrationRecord | undefined }

const heldMigrations = new Set<string>();
function withMigration<T>(root: string, operation: () => T): T {
  const key = resolve(root);
  if (heldMigrations.has(key)) return operation();
  const release = claimMigration(root);
  heldMigrations.add(key);
  try { return withHomeLock(root, operation); }
  finally { heldMigrations.delete(key); release(); }
}

function recoverLegacyConfig(legacy: Home): void {
  const recovery: { base?: Buffer } = {};
  loadWorkspaceConfigSync(legacy.workspaceConfig, recovery, path => readFileSync(path, 'utf8'));
  if (!recovery.base) return;
  createInstallMarker(legacy.root, underTestRunner() ? 'test' : 'live');
  // The loader's writer refuses any .migrating. A crashed run's claim must not block recovery.
  withHomeLock(legacy.root, () => {
    removeStaleMigrationClaim(legacy.root);
    mergeWriteWorkspaceConfigSync(() => {}, legacy);
  });
}

function copyFile(legacy: Home, target: Home, file: MigrationFile): void {
  if (!file.target || file.target.path.startsWith('versions/') || file.target.path.startsWith('accounts/')) return;
  const root = target[file.target.kind], path = join(root, file.target.path);
  assertHomePath(root, path);
  const source = join(legacy.root, file.path);
  assertHomePath(legacy.root, source);
  const bytes = readBytes(source);
  if (bytes !== null && isSquawkMigrationJson(file.path)) JSON.parse(bytes.toString('utf8'));
  if (homeFileSchema.safeParse(file.target.path).success) {
    const log = new VersionLog(root, file.target.path, migrationPrivacy);
    log.replace(path, bytes);
    log.copyAcceptanceFrom(new VersionLog(legacy.root, file.path), bytes);
  }
  else if (bytes !== null) replacePrivate(path, bytes, migrationPrivacy);
  else rmSync(path, { force: true });
  if (digest(readBytes(path)) !== digest(bytes)) throw new Error(`Migration copy verification failed: ${file.path}`);
}

function copyManagedInstall(legacy: Home, target: Home, env: NodeJS.ProcessEnv): void {
  assertHomePath(target.data, target.versions);
  if (!existsSync(legacy.versions)) { rmSync(target.versions, { recursive: true, force: true }); return; }
  replacePrivateTree(legacy.versions, target.versions, (key, destination) => {
    const suffix = `/node_modules/${PACKAGE_NAME}`;
    if (!key.endsWith(suffix)) return false;
    const id = key.slice(0, -suffix.length);
    if (id.includes('/')) return false;
    const manifest = readManifest(id, env, legacy);
    return manifest?.source === 'link' && manifest.checkout !== undefined && realpathSync(manifest.checkout) === destination;
  });
  privateDirectory(target.bin, migrationPrivacy);
  writeLaunchers(env, target);
  // writeLaunchers keeps the shipped 0755. Every migration copy is private.
  for (const name of ['cezarion', 'cez']) {
    const path = join(target.bin, process.platform === 'win32' ? `${name}.cmd` : name);
    if (process.platform === 'win32') protectPrivatePath(path, false, migrationPrivacy);
    else chmodSync(path, 0o700);
  }
}

/** Replace the PATH line the removed `cez install` marked; never append one. */
function updateManagedPath(legacy: Home, target: Home, env: NodeJS.ProcessEnv): void {
  if (process.platform === 'win32' || !env.HOME) return;
  const { file: profile, line, marker } = pathHook(target.bin, { ...env, HOME: env.HOME });
  if (!existsSync(profile)) return;
  const path = realpathSync(profile), bytes = readBytes(path);
  if (!bytes) return;
  const text = bytes.toString('utf8');
  const next = text.replace(new RegExp(`^.*${marker}.*$`, 'm'), line);
  if (next === text) return;
  if (insideDirectory(legacy.root, path)) {
    console.warn(`Managed PATH profile stays unchanged inside the legacy home: ${path}. Add ${target.bin} to PATH.`);
    return;
  }
  replacePrivate(path, next, migrationPrivacy);
}

function changedFiles(previous: MigrationFile[], current: MigrationFile[]): MigrationFile[] {
  const before = new Map(previous.map(file => [file.path, file]));
  const after = new Map(current.map(file => [file.path, file]));
  const changed = current.filter(file => before.get(file.path)?.hash !== file.hash);
  for (const file of previous) if (file.hash !== null && !after.has(file.path)) changed.push({ ...file, hash: null, mtimeMs: null });
  return changed;
}

function writerDiagnostic(files: MigrationFile[]): Error {
  let processes = 'process list unavailable';
  try {
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | Format-List']
      : ['-axo', 'pid=,command='];
    const output = execFileSync(process.platform === 'win32' ? POWERSHELL : 'ps', args, { env: powershellEnv(), encoding: 'utf8', timeout: 5_000 });
    processes = output.split('\n').filter(line => /cezarion|\bcez\b|@wjarka\/cezarion/.test(line)).join('\n') || 'none found';
  } catch { /* The changed filename remains useful when process enumeration is unavailable. */ }
  return new Error(`Legacy files kept changing after three checks: ${files.map(file => file.path).join(', ')}. Stop older binaries and retry. Running processes (pid and command):\n${processes}`);
}

/** Pending copies are disposable. Remove only paths that the prior migration recorded. */
function discardPendingCopies(target: Home): void {
  const prior = readMigrationRecord(target);
  if (!prior) return;
  for (const directory of [target.versions, join(target.data, 'accounts')]) {
    assertHomePath(target.data, directory);
    rmSync(directory, { recursive: true, force: true });
  }
  // Step 7 can publish agent-accounts.json from a config.json import that has no recorded source.
  const copies = [...prior.files.flatMap(file => file.target ? [file.target] : []), { kind: 'config' as const, path: 'agent-accounts.json' }];
  for (const copy of copies) {
    if (copy.path.startsWith('versions/') || copy.path.startsWith('accounts/')) continue;
    const root = target[copy.kind], path = join(root, copy.path);
    assertHomePath(root, path);
    rmSync(path, { force: true });
    if (homeFileSchema.safeParse(copy.path).success) new VersionLog(root, copy.path, migrationPrivacy).replace(path, null);
  }
}

function migrateLocked(legacy: Home, target: Home, options: MigrationOptions): MigrationResult {
  const live = [...readCockpitLeases(legacy), ...(readInstallMarker(target.config) ? readCockpitLeases(target) : [])];
  if (live.length) throw new Error(`Stop every cockpit before migrating: ${live.map(lease => `pid ${lease.pid}, port ${lease.port}, instance ${lease.instance}`).join('; ')}`);
  const marker = readInstallMarker(target.config);
  if (marker?.migratedFrom && marker.state === 'committed') return { status: 'unchanged', record: readMigrationRecord(target) };
  // Step 5's refusal runs before the first target write: a refused run leaves no pending home.
  // The claim makes this a report-only recovery read with the normal journal interpretation.
  const recovery = getHomeRecovery(legacy);
  if (recovery.files.length) throw new Error(`Resolve home recovery before migration: ${recovery.files.map(file => `${file.file} (${file.reason})`).join(', ')}. Run ${LEGACY_RECOVERY_COMMAND}.`);
  const disposable = marker?.state === 'pending' || existsSync(join(target.config, 'install.json.failed'));
  if (!disposable && registryFiles(target).some(path => existsSync(path))) throw new Error(`Migration target already contains registry data: ${target.config}`);
  if (disposable) discardPendingCopies(target);
  writeMigrationMarker(target.config, resolve(legacy.root), 'pending');
  options.onStep?.('pending', 0);
  const plan = planLegacyMigration(legacy, target);
  const record = migrationRecordFor(plan);
  const archiveFiles = migrationFiles(legacy.root, key => archiveExcludes.test(key)
    || Object.values(record.roots).some(root => insideDirectory(legacy.root, root) && insideDirectory(root, join(legacy.root, key))), true);
  assertHomePath(target.state, record.backup);
  writeLegacyArchive(legacy.root, record.backup, archiveFiles);
  options.onStep?.('archived', 0);
  writeMigrationRecord(target, record);
  for (const file of plan.files) copyFile(legacy, target, file);
  if (plan.managedInstall) copyManagedInstall(legacy, target, options.env ?? process.env);
  options.onStep?.('copied', 0);
  return settleCopies(legacy, target, options, record);
}

function settleCopies(legacy: Home, target: Home, options: MigrationOptions, record: MigrationRecord): MigrationResult {
  for (let attempt = 0; attempt < 3; attempt++) {
    options.onStep?.('recheck', attempt);
    let next = planLegacyMigration(legacy, target);
    let changed = changedFiles(record.files, next.files);
    if (!changed.length) {
      record.notMoved = next.notMoved;
      copyMigrationAccounts(legacy, target, next.accounts, record);
      options.onStep?.('accounts', attempt);
      next = planLegacyMigration(legacy, target);
      changed = changedFiles(record.files, next.files);
    }
    if (!changed.length) {
      const present = new Set(next.files.map(file => file.path));
      record.files = [...next.files, ...record.files.filter(file => file.hash === null && !present.has(file.path))];
      // Only a complete commit:false copy is a staged home. Any other pending home is a crash.
      if (options.commit === false) record.stagedAt = new Date().toISOString();
      writeMigrationRecord(target, record);
      if (options.commit === false) return { status: 'pending', record };
      commitLegacyMigration(target, options.env);
      options.onStep?.('committed', attempt);
      return { status: 'migrated', record };
    }
    if (attempt === 2) throw writerDiagnostic(changed);
    // Persist the new inventory before copying: a crash can always discard every attempted copy.
    record.files = [...next.files, ...changed.filter(file => file.hash === null)];
    writeMigrationRecord(target, record);
    for (const file of changed) copyFile(legacy, target, file);
    if (changed.some(file => file.path.startsWith('versions/'))) copyManagedInstall(legacy, target, options.env ?? process.env);
  }
  throw new Error('Unreachable migration state');
}

/** A pending or rolled-back copy may be the only copy left once the legacy registry is gone.
 *  Never commit it as a fresh home, and keep its record and backup reference for recovery. */
function assertNoAbandonedCopy(target: Home): void {
  const pending = readInstallMarker(target.config)?.state === 'pending';
  if (!pending && !existsSync(join(target.config, 'install.json.failed'))) return;
  const backup = readMigrationRecord(target)?.backup;
  throw new Error(`The legacy home is empty, but ${target.config} holds a ${pending ? 'pending' : 'rolled-back'} migration copy`
    + ` (backup ${backup || 'none recorded'}). Restore the legacy home from that backup and retry, or move the copy aside to start a fresh home.`);
}

/** An empty legacy home commits an explicit decision with an empty inventory. Later legacy
 *  writes by older binaries then belong to the canary (P2b-2), never to another migration. */
function recordFreshDecision(legacy: Home, target: Home, plan: MigrationPlan, env: NodeJS.ProcessEnv | undefined): MigrationRecord {
  assertNoAbandonedCopy(target);
  const legacyExisted = existsSync(legacy.root);
  createInstallMarker(target.config, underTestRunner() ? 'test' : 'live');
  const record: MigrationRecord = { ...migrationRecordFor(plan), files: [], backup: '', deferredAccounts: [], notMoved: [] };
  // The record publishes before the committed marker: a committed home always has a record.
  withHomeLock(target.config, () => withHomeLock(target.state, () => {
    writeMigrationRecord(target, record);
    writeMigrationMarker(target.config, resolve(legacy.root), 'committed');
  }));
  if (legacyExisted) commitLegacyMigration(target, env);
  return record;
}

/** Explicit split-layout API. No async lock holds. */
export function migrateLegacyHome(legacy: Home, target: Home, options: MigrationOptions = {}): MigrationResult {
  if (heldMigrations.has(resolve(legacy.root))) throw new Error(`Home migration already running: ${legacy.root}`);
  const marker = readInstallMarker(target.config);
  if (marker?.migratedFrom && marker.state === 'committed') {
    if (resolve(marker.migratedFrom) !== resolve(legacy.root)) throw new Error(`Home already migrated from ${marker.migratedFrom}`);
    if (existsSync(join(legacy.root, '.migrating'))) withMigration(legacy.root, () => {});
    // A fresh decision over an absent legacy home never creates that home to publish MOVED.json.
    if (!existsSync(join(legacy.root, 'MOVED.json'))) { if (existsSync(legacy.root)) commitLegacyMigration(target, options.env); }
    else if (existsSync(target.versions)) updateManagedPath(legacy, target, options.env ?? process.env);
    return { status: 'unchanged', record: readMigrationRecord(target) };
  }
  recoverLegacyConfig(legacy);
  options.onStep?.('recovered', 0);
  const plan = planLegacyMigration(legacy, target);
  if (plan.empty) return { status: 'fresh', record: recordFreshDecision(legacy, target, plan, options.env) };
  createInstallMarker(legacy.root, underTestRunner() ? 'test' : 'live');
  assertHomeReadable(legacy.root);
  return withMigration(legacy.root, () => {
    options.onStep?.('claimed', 0);
    return withHomeLock(target.config, () => withHomeLock(target.state, () => migrateLocked(legacy, target, options)));
  });
}

/** P2c calls this only after every migrated instance passes its health check. Idempotent. */
export function commitLegacyMigration(target: Home, env: NodeJS.ProcessEnv = process.env): void {
  const record = migrationRecordSchema.parse(readMigrationRecord(target));
  const legacy = homePaths(record.legacyRoot, join(record.legacyRoot, '.cache'), record.legacyRoot);
  withMigration(legacy.root, () => withHomeLock(target.config, () => withHomeLock(target.state, () => {
    const committed = readInstallMarker(target.config)?.state === 'committed';
    if (!committed) {
      const changed = changedFiles(record.files, planLegacyMigration(legacy, target).files);
      if (changed.length) throw writerDiagnostic(changed);
      writeMigrationMarker(target.config, record.legacyRoot, 'committed');
    }
    const moved = join(record.legacyRoot, 'MOVED.json');
    assertHomePath(record.legacyRoot, moved);
    const value = movedHomeSchema.parse({ version: 1, roots: record.roots, migratedAt: record.createdAt });
    if (!existsSync(moved)) replacePrivate(moved, `${JSON.stringify(value, null, 2)}\n`, migrationPrivacy);
    if (existsSync(target.versions)) updateManagedPath(legacy, target, env);
  })));
}

/** Keep failed copies for diagnosis. A later migration overwrites the recorded destinations. */
export function rollbackLegacyMigration(target: Home): void {
  if (assertHomeReadable(target.config).state !== 'pending') throw new Error('Only a pending migration can be rolled back');
  withHomeLock(target.config, () => {
    const path = join(target.config, 'install.json'), failed = `${path}.failed`;
    assertHomePath(target.config, failed);
    renameSync(path, failed); syncDirectory(target.config);
  });
}
