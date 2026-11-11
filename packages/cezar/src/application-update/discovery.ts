import { npmPackageIdentity, productIdentity, type NpmLaunchPackage } from '../home/identity.ts';
import { installedRuntime } from './runtime-layout.ts';
import { realpathSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type Installation =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'global' | 'npx'; prefix: string; cache: string; installRoot: string; packageRoot: string; outerRoot: string; launchEntry: string; outerPackage: NpmLaunchPackage; request: string };

export interface DiscoveryInput {
  prefix: string;
  cache: string;
  packageRoot: string;
  launchEntry: string;
}

type UnsupportedInstall = { kind: 'unsupported'; reason: string };

type InstallLayout = {
  kind: 'global' | 'npx';
  prefix: string;
  cache: string;
  packageRoot: string;
  launchEntry: string;
  installRoot: string;
  modules: string;
  identity: ReturnType<typeof productIdentity>;
};

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function unsupported(reason: string): UnsupportedInstall {
  return { kind: 'unsupported', reason };
}

function discoverInstallLayout(input: DiscoveryInput, rebrand: boolean): UnsupportedInstall | InstallLayout {
  let prefix: string;
  try { prefix = realpathSync(input.prefix); } catch { prefix = resolve(input.prefix); }
  // A fresh global npm install need not have created its cache yet.
  let cache: string;
  try { cache = realpathSync(input.cache); } catch { cache = resolve(input.cache); }
  const packageRoot = realpathSync(input.packageRoot);
  const launchEntry = realpathSync(input.launchEntry);
  const manifest = json(join(packageRoot, 'package.json'));
  const identity = typeof manifest.name === 'string' ? npmPackageIdentity(manifest.name) : undefined;
  if (!identity || identity.npmPackage !== manifest.name || (identity.rebrand && !rebrand) || typeof manifest.version !== 'string') {
    return unsupported('running package is not @wjarka/cezarion');
  }
  if (inside(packageRoot, join(prefix, 'lib/node_modules')) || inside(packageRoot, join(prefix, 'node_modules'))) {
    return {
      kind: 'global', prefix, cache, packageRoot, launchEntry, installRoot: prefix, identity,
      modules: inside(packageRoot, join(prefix, 'lib/node_modules')) ? join(prefix, 'lib/node_modules') : join(prefix, 'node_modules'),
    };
  }
  const parts = relative(cache, packageRoot).split(sep);
  if (parts[0] !== '_npx' || !/^[a-z0-9]+$/i.test(parts[1] ?? '') || parts[2] !== 'node_modules') {
    return unsupported('not an npm global or npx cache installation');
  }
  const installRoot = join(cache, '_npx', parts[1]!);
  return { kind: 'npx', prefix, cache, packageRoot, launchEntry, installRoot, identity, modules: join(installRoot, 'node_modules') };
}

function discoverNpxRequest(installRoot: string, identity: ReturnType<typeof productIdentity>): string | UnsupportedInstall {
  const root = json(join(installRoot, 'package.json'));
  const requests = (root._npx as { packages?: unknown } | undefined)?.packages;
  // The new identity has no unscoped alias: npm refuses the name `hsq`.
  if (!Array.isArray(requests) || requests.length !== 1 ||
    ![identity.npmAlias, identity.npmPackage].some(name => name !== null && name === requests[0])) {
    return unsupported('pinned or mixed npx request');
  }
  return requests[0] as string;
}

type AliasRoot = { name: NpmLaunchPackage; path: string };

/** The rebranded identity has no unscoped alias: npm refuses the name `hsq`. */
function aliasRoot(modules: string, identity: ReturnType<typeof productIdentity>): AliasRoot | undefined {
  return identity.npmAlias === null ? undefined : { name: identity.npmAlias, path: join(modules, identity.npmAlias) };
}

function aliasLinkError(alias: AliasRoot, scoped: string): UnsupportedInstall | undefined {
  const outer = json(join(alias.path, 'package.json'));
  const deps = outer.dependencies as Record<string, unknown> | undefined;
  return outer.name !== alias.name || typeof deps?.[scoped] !== 'string' ? unsupported('alias is not linked to scoped package') : undefined;
}

function discoverOuterPackage(layout: InstallLayout, launchPath: string): Installation {
  const { prefix, cache, packageRoot, launchEntry, kind, installRoot, modules, identity } = layout;
  const direct = join(modules, identity.npmPackage);
  const alias = aliasRoot(modules, identity);
  if (packageRoot !== direct && packageRoot !== (alias && join(alias.path, 'node_modules', identity.npmPackage))) {
    return unsupported('linked or mixed package layout');
  }
  let outerPackage: NpmLaunchPackage = alias && inside(launchEntry, alias.path) ? alias.name : identity.npmPackage;
  let request: string = outerPackage;
  if (kind === 'npx') {
    const npxRequest = discoverNpxRequest(installRoot, identity);
    if (typeof npxRequest !== 'string') return npxRequest;
    request = npxRequest;
    // npm may link .bin/cezarion to the scoped dependency even when the _npx
    // request and root dependency are the alias. Metadata owns this choice.
    outerPackage = request as typeof outerPackage;
  }
  if (outerPackage === identity.npmPackage && packageRoot !== direct) return unsupported('mixed launch layout');
  const viaAlias = alias !== undefined && outerPackage === alias.name ? alias : undefined;
  const outerPath = viaAlias?.path ?? direct;
  if (!inside(launchEntry, outerPath) && !(kind === 'npx' && inside(launchEntry, packageRoot))) {
    return unsupported('launch entry does not belong to installation');
  }
  const linkError = viaAlias && aliasLinkError(viaAlias, identity.npmPackage);
  if (linkError) return linkError;
  return { kind, prefix, cache, installRoot, packageRoot, outerRoot: outerPath,
    launchEntry: resolve(launchPath), outerPackage, request };
}

function discoverForwardingPackage(layout: InstallLayout, launchPath: string): Installation | undefined {
  if (!layout.identity.rebrand) return undefined;
  const legacy = productIdentity(false);
  let outerPackage: NpmLaunchPackage | undefined;
  if (layout.kind === 'npx') {
    const request = discoverNpxRequest(layout.installRoot, legacy);
    if (typeof request === 'string') outerPackage = request as NpmLaunchPackage;
  } else {
    outerPackage = [legacy.npmPackage, legacy.npmAlias]
      .find(name => inside(layout.launchEntry, join(layout.modules, name)));
  }
  if (!outerPackage) return undefined;
  const runtime = installedRuntime(layout.modules, outerPackage);
  const outerRoot = join(layout.modules, outerPackage);
  if (runtime.path !== layout.packageRoot || (!inside(layout.launchEntry, outerRoot)
    && !(layout.kind === 'npx' && inside(layout.launchEntry, runtime.path)))) {
    return unsupported('mixed forwarding layout');
  }
  return { kind: layout.kind, prefix: layout.prefix, cache: layout.cache, installRoot: layout.installRoot,
    packageRoot: layout.packageRoot, outerRoot, outerPackage, request: outerPackage, launchEntry: resolve(launchPath) };
}

/** Match only npm-owned, canonical layouts. A matched but unsafe layout is explicit. */
export function discoverInstallation(input: DiscoveryInput, rebrand = productIdentity().rebrand): Installation {
  try {
    const layout = discoverInstallLayout(input, rebrand);
    if (layout.kind === 'unsupported') return layout;
    return (rebrand ? discoverForwardingPackage(layout, input.launchEntry) : undefined)
      ?? discoverOuterPackage(layout, input.launchEntry);
  } catch {
    return unsupported('installation metadata is unavailable');
  }
}
