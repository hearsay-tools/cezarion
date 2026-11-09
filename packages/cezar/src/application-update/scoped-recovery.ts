import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { productIdentity, type NpmLaunchPackage } from '../home/identity.js';
import { assertCanonicalPath, installationModules, originalRuntimeName, hoistedRuntime, installedRuntime } from './runtime-layout.js';

type AliasInstallation = { kind: 'global' | 'npx'; installRoot: string; packageRoot: string; outerRoot: string; outerPackage: NpmLaunchPackage };
export type RecoveryTree = { source: string | undefined; destination: string };

export function validateScopedRecovery(path: string, version: string): void {
  assertCanonicalPath(path);
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (pkg.name !== productIdentity(false).npmPackage || pkg.version !== version
    || pkg.dependencies?.[productIdentity(true).npmPackage] !== version
    || !existsSync(join(path, 'dist/index.js')) || !existsSync(join(path, 'web/dist/index.html'))) {
    throw new Error('invalid legacy scoped recovery');
  }
  const nested = join(path, 'node_modules', productIdentity(true).npmPackage);
  if (existsSync(nested)) validateBackupRuntime(nested, productIdentity(true).npmPackage, version);
}

/** The saved alias layout owns this fixed slot; records cannot choose its source or destination. */
export function scopedRecoveryTarget(installation: AliasInstallation, recovery: string): (RecoveryTree & { source: string; version: string }) | undefined {
  if (installation.kind !== 'global' || installation.outerPackage !== productIdentity(false).npmAlias) return;
  const pkg = JSON.parse(readFileSync(join(recovery, 'package.json'), 'utf8'));
  if (pkg.dependencies?.[productIdentity(true).npmPackage] === undefined) return;
  if (pkg.name !== installation.outerPackage || typeof pkg.version !== 'string'
    || pkg.dependencies[productIdentity(true).npmPackage] !== pkg.version
    || pkg.dependencies[productIdentity(false).npmPackage] !== pkg.version) throw new Error('invalid alias recovery');
  const nested = join(recovery, 'node_modules', productIdentity(false).npmPackage);
  if (existsSync(nested)) { validateScopedRecovery(nested, pkg.version); return; }
  return { source: join(dirname(recovery), 'recovery-scoped-package'),
    destination: join(installationModules(installation), productIdentity(false).npmPackage), version: pkg.version };
}

function validateBackupRuntime(path: string, name: string, version: string): void {
  assertCanonicalPath(path);
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (pkg.name !== name || pkg.version !== version || !existsSync(join(path, 'dist/index.js'))
    || !existsSync(join(path, 'web/dist/index.html'))) throw new Error('invalid runtime recovery');
}

/** Validate every saved package before any installed root is removed or replaced. */
export function validateRecoveryLayout(installation: AliasInstallation, recovery: string, runtimeBackup: string | undefined, version: string): void {
  const sourceRoot = installation.kind === 'npx' ? installation.installRoot : installation.outerRoot;
  const runtime = installation.kind === 'global' && hoistedRuntime(installation) ? runtimeBackup!
    : join(recovery, relative(sourceRoot, installation.packageRoot));
  validateBackupRuntime(runtime, originalRuntimeName(installation), version);
  if (installation.kind === 'npx') {
    const resolved = installedRuntime(join(recovery, 'node_modules'), installation.outerPackage);
    if (resolved.path !== runtime) throw new Error('invalid npx recovery layout');
  }
  if (installation.outerPackage !== productIdentity(false).npmAlias) return;
  const outer = join(recovery, relative(sourceRoot, installation.outerRoot));
  const pkg = JSON.parse(readFileSync(join(outer, 'package.json'), 'utf8'));
  if (pkg.name !== installation.outerPackage || typeof pkg.version !== 'string'
    || (pkg.dependencies?.[productIdentity(true).npmPackage] !== undefined && pkg.version !== version)) throw new Error('invalid alias recovery');
  const scoped = scopedRecoveryTarget(installation, recovery);
  if (scoped) validateScopedRecovery(scoped.source, version);
}

export const RECOVERY_FAILURE_MESSAGE = 'Update and recovery failed. Reinstall cezarion manually.';
const KEPT_ROOTS_PREFIX = 'Package recovery could not be reverted. Kept previous roots: ';

function recoveryDestinations(installation: AliasInstallation, recovery: string): string[] {
  if (installation.kind === 'npx') {
    // Promotion may add an entry absent from the saved root. Its retained private
    // slot still identifies the direct canonical child that rollback replaced.
    const entries = readdirSync(recovery);
    for (const name of readdirSync(installation.installRoot)) {
      const kept = /^\.(.+)-recovery-[A-Za-z0-9]{6}$/.exec(name);
      if (kept && kept[1] !== '.' && kept[1] !== '..') entries.push(kept[1]!);
    }
    return entries.filter(name => name !== 'concurrency.lock').map(name => join(installation.installRoot, name));
  }
  const destinations = [installation.outerRoot];
  if (hoistedRuntime(installation)) destinations.push(installation.packageRoot);
  const scoped = scopedRecoveryTarget(installation, recovery);
  if (scoped) destinations.push(scoped.destination);
  return destinations;
}

function validKeptRoot(entry: string, destinations: Set<string>): boolean {
  const parts = entry.split(' -> ');
  if (parts.length !== 2) return false;
  const [source, destination] = parts as [string, string];
  if (!destinations.delete(destination)) return false;
  const work = dirname(source), prefix = `.${basename(destination)}-recovery-`;
  if (dirname(work) !== dirname(destination) || basename(source) !== 'previous'
    || !basename(work).startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(basename(work).slice(prefix.length))) return false;
  if (source !== join(work, 'previous')) return false;
  assertCanonicalPath(source);
  assertCanonicalPath(destination);
  return existsSync(source);
}

/** Disk messages can name only the helper's private previous roots and canonical destinations. */
export function validRecoveryMessage(message: string, installation: AliasInstallation, recovery: string): boolean {
  const prefix = `${RECOVERY_FAILURE_MESSAGE} ${KEPT_ROOTS_PREFIX}`;
  if (!message.startsWith(prefix)) return false;
  try {
    assertCanonicalPath(recovery);
    const destinations = new Set(recoveryDestinations(installation, recovery));
    return message.slice(prefix.length).split('; ').every(entry => validKeptRoot(entry, destinations));
  } catch { return false; }
}

/** Kept roots are reported through the existing application-update status message. */
export class PackageRecoveryError extends Error {
  constructor(copies: RecoveryTree[]) {
    super(`${KEPT_ROOTS_PREFIX}${copies.map(copy => `${copy.source} -> ${copy.destination}`).join('; ')}`);
  }
}

type PreparedTree = RecoveryTree & { work: string; moved: boolean; installed: boolean };
async function undoTrees(trees: PreparedTree[], assertOwned: () => Promise<void>): Promise<void> {
  for (const tree of [...trees].reverse()) {
    if (tree.installed) { await assertOwned(); await rm(tree.destination, { recursive: true, force: true }); }
    if (tree.moved) { await assertOwned(); await rename(join(tree.work, 'previous'), tree.destination); }
  }
}

/** Finish every copy before replacing roots. A failed commit restores all pre-rollback roots. */
export async function restorePackageTrees(trees: RecoveryTree[], assertOwned: () => Promise<void>): Promise<void> {
  const prepared: PreparedTree[] = [];
  let cleanup = true;
  let ownershipLost = false;
  const checkOwned = async () => {
    try { await assertOwned(); }
    catch (error) { ownershipLost = true; throw error; }
  };
  try {
    for (const tree of trees) {
      await checkOwned();
      assertCanonicalPath(tree.destination);
      if (tree.source) assertCanonicalPath(tree.source);
      const work = await mkdtemp(join(dirname(tree.destination), `.${basename(tree.destination)}-recovery-`));
      prepared.push({ ...tree, work, moved: false, installed: false });
      if (tree.source) await cp(tree.source, join(work, 'next'), { recursive: true, dereference: false,
        filter: async () => { await checkOwned(); return true; } });
    }
    for (const tree of prepared) {
      await checkOwned();
      assertCanonicalPath(tree.destination);
      if (existsSync(tree.destination)) { await rename(tree.destination, join(tree.work, 'previous')); tree.moved = true; }
      if (tree.source) { await checkOwned(); await rename(join(tree.work, 'next'), tree.destination); tree.installed = true; }
    }
  } catch (error) {
    try {
      if (ownershipLost) throw error;
      await undoTrees(prepared, checkOwned);
    }
    catch {
      cleanup = false;
      const copies = prepared.map(tree => ({ source: join(tree.work, 'previous'), destination: tree.destination }))
        .filter(tree => existsSync(tree.source));
      throw new PackageRecoveryError(copies);
    }
    throw error;
  } finally {
    // Retain previous roots when ownership is lost or the filesystem refuses undo.
    if (cleanup) for (const tree of prepared) await rm(tree.work, { recursive: true, force: true });
  }
}
