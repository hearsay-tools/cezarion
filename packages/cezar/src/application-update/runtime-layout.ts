import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { npmPackageIdentity, productIdentity, type NpmLaunchPackage } from '../home/identity.js';

type OuterInstallation = { kind: 'global' | 'npx'; installRoot: string; outerRoot: string; outerPackage: NpmLaunchPackage; packageRoot: string };
type PackageManifest = { name: string; version: string; dependencies?: Record<string, string> };
const manifest = (path: string): PackageManifest => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as PackageManifest;

export function installationModules(installation: Pick<OuterInstallation, 'outerRoot' | 'outerPackage'>): string {
  return resolve(installation.outerRoot, ...installation.outerPackage.split('/').map(() => '..'));
}

/** Reject symlink escapes even when npm has removed the destination during a failed install. */
export function assertCanonicalPath(path: string): void {
  let cursor = path;
  while (!existsSync(cursor)) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('unowned package path'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('unowned package path');
    cursor = parent;
  }
  if (realpathSync(cursor) !== cursor) throw new Error('unowned package path');
}

function dependencyPath(modules: string, outer: string, name: string): string {
  const nested = join(outer, 'node_modules', name);
  const path = existsSync(nested) ? nested : join(modules, name);
  assertCanonicalPath(path);
  return path;
}

/** Shipped alias updaters still locate and validate this scoped forwarding wrapper. */
function validateLegacyScoped(modules: string, outer: string, pkg: PackageManifest): void {
  const old = productIdentity(false), active = productIdentity(true);
  if (pkg.dependencies?.[old.npmPackage] !== pkg.version) throw new Error('invalid legacy scoped pin');
  const scopedPath = dependencyPath(modules, outer, old.npmPackage);
  const scoped = manifest(scopedPath);
  if (scoped.name !== old.npmPackage || scoped.version !== pkg.version
    || scoped.dependencies?.[active.npmPackage] !== pkg.version) throw new Error('legacy scoped identity mismatch');
  const candidates = [join(scopedPath, 'node_modules', active.npmPackage), join(outer, 'node_modules', active.npmPackage), join(modules, active.npmPackage)];
  const runtimePath = candidates.find(path => existsSync(path)) ?? candidates[2]!;
  assertCanonicalPath(runtimePath);
  const runtime = manifest(runtimePath);
  if (runtime.name !== active.npmPackage || runtime.version !== pkg.version) throw new Error('legacy scoped runtime mismatch');
}

/** Validate target shape independently of the running build's switch. Current-install discovery owns name gating. */
export function installedRuntime(modules: string, outerPackage: NpmLaunchPackage): { path: string; name: string } {
  const identity = npmPackageIdentity(outerPackage)!;
  const outer = join(modules, outerPackage);
  assertCanonicalPath(outer);
  const pkg = manifest(outer);
  if (pkg.name !== outerPackage) throw new Error('outer package identity mismatch');
  const active = productIdentity(true);
  const forwarding = !identity.rebrand && pkg.dependencies?.[active.npmPackage] !== undefined;
  if (forwarding && pkg.dependencies![active.npmPackage] !== pkg.version) throw new Error('invalid forwarding pin');
  if (forwarding && outerPackage === productIdentity(false).npmAlias) validateLegacyScoped(modules, outer, pkg);
  const name = forwarding ? active.npmPackage : identity.npmPackage;
  if (outerPackage === name) return { path: outer, name };
  if (typeof pkg.dependencies?.[name] !== 'string') throw new Error('outer package has no runtime dependency');
  const path = dependencyPath(modules, outer, name);
  const runtime = manifest(path);
  if (runtime.name !== name || (forwarding && runtime.version !== pkg.version)) throw new Error('runtime identity mismatch');
  return { path, name };
}

/** Original runtime identity comes from discovery-owned paths, not mutable promotion metadata. */
export function originalRuntimeName(installation: OuterInstallation): string {
  const identity = npmPackageIdentity(installation.outerPackage)!;
  const names = [identity.npmPackage, productIdentity(true).npmPackage];
  const modules = installationModules(installation);
  const name = names.find(name => installation.packageRoot === join(modules, name)
    || installation.packageRoot === join(installation.outerRoot, 'node_modules', name));
  if (!name) throw new Error('unowned runtime path');
  return name;
}

export function hoistedRuntime(installation: OuterInstallation): boolean {
  return installation.kind === 'global' && installation.packageRoot !== installation.outerRoot
    && installation.packageRoot === join(installationModules(installation), originalRuntimeName(installation));
}
