import { commandText } from '../home/command.ts';
import { BINARY_NAMES, NPM_LAUNCH_PACKAGES, productIdentity } from '../home/identity.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StepAborted } from './steps.ts';
import type { InstallContext } from './types.ts';

const OFFICIAL_CLI_PKG = productIdentity().npmAlias ?? productIdentity().npmPackage;

const DEFAULT_RECONFIGURE_HINT = commandText(`  cez server-install --platform ubuntu-vps --reconfigure autostart`);

/** The npx package cache root for the user the service runs as (this is the
 *  same user that runs `server-deploy`). Honors an `npm_config_cache` override,
 *  else npm's default `~/.npm`. */
function npxCacheDir(): string {
  const base = process.env.npm_config_cache?.trim() || join(homedir(), '.npm');
  return join(base, '_npx');
}

/** The npx arguments a service unit runs. npm refuses the unscoped name `hsq`, so the
 *  new package runs its `hsq` binary through `-p`. */
export function npxLaunchArgs(rebrand = REBRAND_SWITCH): string[] {
  const identity = productIdentity(rebrand);
  return identity.rebrand ? ['--yes', '-p', identity.npmPackage, identity.command] : ['--yes', identity.npmAlias];
}

/** The exact npx executable and requested package, including systemctl's argv[] form.
 *  `npx [--yes] <package>` and `npx [--yes] -p <package> <binary>` name a package. */
export function npxLaunchPackage(execStart: string): string | undefined {
  const command = execStart.match(/^\s*ExecStart=\{[^;]*;\s*argv\[\]=([^;]*)/)?.[1] ?? execStart;
  const words = [...command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s]+)/g)]
    .map(match => match[1] ?? match[2] ?? match[3]!);
  const executable = words.shift()?.split(/[\\/]/).pop();
  if (!/^npx(?:\.cmd|\.exe)?$/.test(executable ?? '')) return;
  if (words[0] === '--yes' || words[0] === '-y') words.shift();
  if (words[0] !== '-p' && words[0] !== '--package') return words[0];
  // Without one of our binaries the launch is not ours: return the whole form, which names no package.
  return BINARY_NAMES.some(name => name === words[2]) ? words[1] : words.slice(0, 3).join(' ');
}

function ownedPackageRequest(request: string | undefined): string | undefined {
  return NPM_LAUNCH_PACKAGES.find(pkg => request === pkg || (request?.startsWith(`${pkg}@`) && /^[\w~^<>=*.+|-]+$/.test(request.slice(pkg.length + 1))));
}

export function ownedNpxPackage(execStart: string): string | undefined {
  return ownedPackageRequest(npxLaunchPackage(execStart));
}

/** A hoisted dependency does not make the surrounding npx install ours. */
function cacheRequestsPackage(root: string, name: string): boolean {
  const manifestPath = join(root, 'package.json');
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !('dependencies' in manifest)) return false;
    const dependencies = manifest.dependencies;
    if (!dependencies || typeof dependencies !== 'object' || Object.keys(dependencies).length !== 1) return false;
    const spec = (dependencies as Record<string, unknown>)[name];
    return typeof spec === 'string' && ownedPackageRequest(`${name}@${spec}`) === name;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new StepAborted(`cannot inspect the npx cache entry at ${manifestPath}: ${message} — the service was not restarted`);
  }
}

export function isNpxExecStart(execStart: string): boolean {
  return ownedNpxPackage(execStart) !== undefined;
}

/** True when the unit is an npx launch of a package that is NOT ours — in practice a unit
 *  installed by upstream cezar as `npx --yes cezar-cli`, before this clone took its own npm
 *  identity (#23).
 *
 *  Deliberately not treated as ours to refresh: clearing another package's npx cache would make
 *  the next restart fetch THAT package's `latest`, silently moving the box onto upstream's newest
 *  release — the shadowing the rename exists to prevent. But saying nothing is worse, because
 *  `server-deploy` then reports a green restart while the running version is unchanged. So the
 *  caller warns and names the remedy.
 *
 *  Checkout and global-bin units do not execute npx, including an entry below `_npx`.
 *  Their restart picks up the new build or global install directly. */
export function isForeignNpxExecStart(execStart: string): boolean {
  return npxLaunchPackage(execStart) !== undefined && ownedNpxPackage(execStart) === undefined;
}

/**
 * The npx trap (#696 / #32): `npx --yes cezarion` caches the resolved package under
 * `~/.npm/_npx/<hash>` and reuses it forever — a service restart re-execs the
 * SAME cached build, so `server-deploy` would never actually update. Before
 * restarting an npx-based unit we delete cache entries whose root manifest requests
 * only the launched package, so the next launch re-resolves `latest`. Other npx
 * packages' caches are left untouched. A checkout / global-bin unit has no
 * npx cache to clear and is skipped (its restart picks up the new build/global
 * directly).
 *
 * `execStart` is the live launch command: systemd `ExecStart` on ubuntu-vps,
 * launchd `ProgramArguments` joined on macosx-ngrok.
 */
export function refreshNpxCacheForRedeploy(
  ctx: InstallContext,
  execStart: string,
  opts: { reconfigureHint?: string } = {},
): void {
  const launchPackage = ownedNpxPackage(execStart);
  if (!launchPackage) {
    if (isForeignNpxExecStart(execStart)) {
      ctx.ui.warn(
        `This service is launched by npx from a package other than ${OFFICIAL_CLI_PKG} — most likely a unit ` +
          `installed by upstream cezar as \`npx --yes cezar-cli\`. Restarting it re-execs that package's cached ` +
          `build, so this deploy will NOT change the running version, and clearing that cache would move the box ` +
          `onto upstream's latest instead. Rewrite the unit for ${OFFICIAL_CLI_PKG} first:\n` +
          (opts.reconfigureHint ?? DEFAULT_RECONFIGURE_HINT),
      );
    }
    return;
  }
  const dir = npxCacheDir();
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would clear cached ${launchPackage} builds under ${dir} so npx refetches the latest.`);
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ctx.ui.info(`No cached ${launchPackage} npx build found — the restart will fetch the latest published version.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new StepAborted(`cannot inspect the npx cache at ${dir}: ${message} — the service was not restarted`);
  }

  let cleared = 0;
  for (const entry of entries) {
    const pkgDir = join(dir, entry);
    if (!cacheRequestsPackage(pkgDir, launchPackage)) continue;
    const packageDir = join(pkgDir, 'node_modules', launchPackage);
    try {
      statSync(packageDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new StepAborted(`cannot inspect the npx cache entry at ${packageDir}: ${message} — the service was not restarted`);
    }
    try {
      rmSync(pkgDir, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StepAborted(`cannot remove the cached ${launchPackage} build at ${pkgDir}: ${message} — the service was not restarted`);
    }
    cleared++;
  }
  ctx.ui.info(
    cleared > 0
      ? `Cleared ${cleared} cached ${launchPackage} npx build(s) — the restart will fetch the latest published version.`
      : `No cached ${launchPackage} npx build found — the restart will fetch the latest published version.`,
  );
}
