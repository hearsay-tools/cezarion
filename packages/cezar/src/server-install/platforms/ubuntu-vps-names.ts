import type { InstallContext, StepArtifact } from '../types.ts';

/**
 * Instance-scoped ubuntu-vps resource names. The `default` instance keeps the un-suffixed names; a
 * named (domain-keyed) instance suffixes the unit, site and htpasswd with its slug. A fresh install
 * gets the `hearsay-squawk*` names; `legacy` selects the `cezar*` names of an install made before
 * the rename. Recorded artifacts always win: such an install keeps acting on its recorded names.
 */
export interface UbuntuNames {
  unit: string;
  vhostAvailable: string;
  vhostEnabled: string;
  htpasswd: string;
  htpasswdDir: string;
}

export function ubuntuNames(instance: string | undefined, { legacy = false } = {}): UbuntuNames {
  const named = instance && instance !== 'default' ? instance : undefined;
  const base = legacy ? 'cezar' : 'hearsay-squawk';
  const site = named ? `${base}-${named}` : base;
  const htpasswdDir = legacy ? '/etc/cezar' : '/etc/hearsay-squawk';
  return {
    unit: `${site}.service`,
    vhostAvailable: `/etc/nginx/sites-available/${site}`,
    vhostEnabled: `/etc/nginx/sites-enabled/${site}`,
    htpasswd: named ? `${htpasswdDir}/htpasswd-${named}` : `${htpasswdDir}/htpasswd`,
    htpasswdDir,
  };
}

function ownedArtifact(ctx: InstallContext, step: string, type: string): StepArtifact | undefined {
  return ctx.state.steps[step]?.created?.artifacts.find((a) => a.kind === 'owned' && a.type === type);
}

/** The ledger's service artifact; a fresh install gets the new name. */
export function recordedUnit(ctx: InstallContext): StepArtifact & { name: string } {
  const recorded = ownedArtifact(ctx, 'autostart', 'service');
  const name = recorded?.name ?? ubuntuNames(ctx.instance).unit;
  return { kind: 'owned', type: 'service', ...recorded, name };
}

/** The unit as operators type it in hints (`cezar`, `cezar-shop`, `hearsay-squawk`). */
export function unitHint(ctx: InstallContext): string {
  return recordedUnit(ctx).name.replace(/\.service$/, '');
}

/** The ledger's site, symlink and htpasswd paths; the pre-switch names fill any gap. */
export function ledgerSite(ctx: InstallContext): Pick<UbuntuNames, 'vhostAvailable' | 'vhostEnabled' | 'htpasswd'> {
  const names = ubuntuNames(ctx.instance, { legacy: true });
  return {
    vhostAvailable: ownedArtifact(ctx, 'nginx-proxy', 'file')?.path ?? names.vhostAvailable,
    vhostEnabled: ownedArtifact(ctx, 'nginx-proxy', 'symlink')?.path ?? names.vhostEnabled,
    htpasswd: ownedArtifact(ctx, 'nginx-proxy', 'htpasswd')?.path ?? names.htpasswd,
  };
}

const recordedProxy = (ctx: InstallContext) => ctx.state.steps['nginx-proxy']?.created?.artifacts.some((a) => a.kind === 'owned') === true;

/** The ledger wins; a fresh install gets the new names. */
export function recordedSite(ctx: InstallContext): Pick<UbuntuNames, 'vhostAvailable' | 'vhostEnabled' | 'htpasswd'> {
  return recordedProxy(ctx) ? ledgerSite(ctx) : ubuntuNames(ctx.instance);
}

/** Undo removes recorded paths. Without a ledger, both name sets are ours. */
export function sitePathsToRemove(ctx: InstallContext): { files: string[]; dirs: string[] } {
  const sets = recordedProxy(ctx) ? [recordedSite(ctx)] : [ubuntuNames(ctx.instance), ubuntuNames(ctx.instance, { legacy: true })];
  const files = [...new Set(sets.flatMap((s) => [s.vhostEnabled, s.vhostAvailable, s.htpasswd]))];
  const dirs = [...new Set(sets.map((s) => s.htpasswd.slice(0, s.htpasswd.lastIndexOf('/'))))];
  return { files, dirs };
}
