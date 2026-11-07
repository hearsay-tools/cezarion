import { realpathSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type Installation =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'global' | 'npx'; prefix: string; cache: string; installRoot: string; packageRoot: string; outerRoot: string; launchEntry: string; outerPackage: '@wjarka/cezarion' | 'cezarion'; request: string };

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

function discoverInstallLayout(input: DiscoveryInput): UnsupportedInstall | InstallLayout {
  let prefix: string;
  try { prefix = realpathSync(input.prefix); } catch { prefix = resolve(input.prefix); }
  // A fresh global npm install need not have created its cache yet.
  let cache: string;
  try { cache = realpathSync(input.cache); } catch { cache = resolve(input.cache); }
  const packageRoot = realpathSync(input.packageRoot);
  const launchEntry = realpathSync(input.launchEntry);
  const manifest = json(join(packageRoot, 'package.json'));
  if (manifest.name !== '@wjarka/cezarion' || typeof manifest.version !== 'string') {
    return unsupported('running package is not @wjarka/cezarion');
  }
  if (inside(packageRoot, join(prefix, 'lib/node_modules')) || inside(packageRoot, join(prefix, 'node_modules'))) {
    return {
      kind: 'global', prefix, cache, packageRoot, launchEntry, installRoot: prefix,
      modules: inside(packageRoot, join(prefix, 'lib/node_modules')) ? join(prefix, 'lib/node_modules') : join(prefix, 'node_modules'),
    };
  }
  const parts = relative(cache, packageRoot).split(sep);
  if (parts[0] !== '_npx' || !/^[a-z0-9]+$/i.test(parts[1] ?? '') || parts[2] !== 'node_modules') {
    return unsupported('not an npm global or npx cache installation');
  }
  const installRoot = join(cache, '_npx', parts[1]!);
  return { kind: 'npx', prefix, cache, packageRoot, launchEntry, installRoot, modules: join(installRoot, 'node_modules') };
}

function discoverNpxRequest(installRoot: string): string | UnsupportedInstall {
  const root = json(join(installRoot, 'package.json'));
  const requests = (root._npx as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(requests) || requests.length !== 1 ||
    !['cezarion', '@wjarka/cezarion'].includes(requests[0] as string)) {
    return unsupported('pinned or mixed npx request');
  }
  return requests[0] as string;
}

function discoverOuterPackage(layout: InstallLayout, launchPath: string): Installation {
  const { prefix, cache, packageRoot, launchEntry, kind, installRoot, modules } = layout;
  const direct = join(modules, '@wjarka/cezarion');
  const alias = join(modules, 'cezarion');
  if (packageRoot !== direct && packageRoot !== join(alias, 'node_modules/@wjarka/cezarion')) {
    return unsupported('linked or mixed package layout');
  }
  let outerPackage: '@wjarka/cezarion' | 'cezarion' = inside(launchEntry, alias) ? 'cezarion' : '@wjarka/cezarion';
  let request: string = outerPackage;
  if (kind === 'npx') {
    const npxRequest = discoverNpxRequest(installRoot);
    if (typeof npxRequest !== 'string') return npxRequest;
    request = npxRequest;
    // npm may link .bin/cezarion to the scoped dependency even when the _npx
    // request and root dependency are the alias. Metadata owns this choice.
    outerPackage = request as typeof outerPackage;
  }
  if (outerPackage === '@wjarka/cezarion' && packageRoot !== direct) return unsupported('mixed launch layout');
  const outerPath = outerPackage === 'cezarion' ? alias : direct;
  if (!inside(launchEntry, outerPath) && !(kind === 'npx' && inside(launchEntry, packageRoot))) {
    return unsupported('launch entry does not belong to installation');
  }
  if (outerPackage === 'cezarion') {
    const outer = json(join(alias, 'package.json'));
    const deps = outer.dependencies as Record<string, unknown> | undefined;
    if (outer.name !== 'cezarion' || typeof deps?.['@wjarka/cezarion'] !== 'string') return unsupported('alias is not linked to scoped package');
  }
  return { kind, prefix, cache, installRoot, packageRoot, outerRoot: outerPath,
    launchEntry: resolve(launchPath), outerPackage, request };
}

/** Match only npm-owned, canonical layouts. A matched but unsafe layout is explicit. */
export function discoverInstallation(input: DiscoveryInput): Installation {
  try {
    const layout = discoverInstallLayout(input);
    if (layout.kind === 'unsupported') return layout;
    return discoverOuterPackage(layout, input.launchEntry);
  } catch {
    return unsupported('installation metadata is unavailable');
  }
}
