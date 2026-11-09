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

/** Resolve only npm's canonical nested or hoisted dependency, never arbitrary package paths. */
export function installedRuntime(modules: string, outerPackage: NpmLaunchPackage, rebrand: boolean): { path: string; name: string } {
  const identity = npmPackageIdentity(outerPackage)!;
  const outer = join(modules, outerPackage);
  assertCanonicalPath(outer);
  const pkg = manifest(outer);
  if (pkg.name !== outerPackage) throw new Error('outer package identity mismatch');
  const active = productIdentity(true);
  const forwarding = !identity.rebrand && pkg.dependencies?.[active.npmPackage] !== undefined;
  if (forwarding && (!rebrand || pkg.dependencies![active.npmPackage] !== pkg.version)) throw new Error('invalid forwarding pin');
  const name = forwarding ? active.npmPackage : identity.npmPackage;
  if (outerPackage === name) return { path: outer, name };
  if (typeof pkg.dependencies?.[name] !== 'string') throw new Error('outer package has no runtime dependency');
  const nested = join(outer, 'node_modules', name);
  const path = existsSync(nested) ? nested : join(modules, name);
  assertCanonicalPath(path);
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
