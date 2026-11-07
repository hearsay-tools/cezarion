import type { InstallContext, StepArtifact } from '../types.ts';

/**
 * Instance-scoped ubuntu-vps resource names. The `default` instance keeps the un-suffixed names; a
 * named (domain-keyed) instance suffixes the unit, site and htpasswd with its slug. `rebrand`
 * selects the names a fresh install gets after the release switch. Recorded artifacts always win:
 * an install made before the switch keeps acting on its recorded `cezar*` names.
 */
export interface UbuntuNames {
  unit: string;
  vhostAvailable: string;
  vhostEnabled: string;
  htpasswd: string;
  htpasswdDir: string;
}

export function ubuntuNames(instance: string | undefined, rebrand: boolean): UbuntuNames {
  const named = instance && instance !== 'default' ? instance : undefined;
  const base = rebrand ? 'hearsay-squawk' : 'cezar';
  const site = named ? `${base}-${named}` : base;
  const htpasswdDir = rebrand ? '/etc/hearsay-squawk' : '/etc/cezar';
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

/** The ledger's service artifact. Before the switch, the name stays derived from the instance. */
export function recordedUnit(ctx: InstallContext, rebrand: boolean): StepArtifact & { name: string } {
  const recorded = ownedArtifact(ctx, 'autostart', 'service');
  const name = rebrand ? recorded?.name ?? ubuntuNames(ctx.instance, true).unit : ubuntuNames(ctx.instance, false).unit;
  return { kind: 'owned', type: 'service', ...recorded, name };
}

/** The ledger's site, symlink and htpasswd paths; the pre-switch names fill any gap. */
export function ledgerSite(ctx: InstallContext): Pick<UbuntuNames, 'vhostAvailable' | 'vhostEnabled' | 'htpasswd'> {
  const names = ubuntuNames(ctx.instance, false);
  return {
    vhostAvailable: ownedArtifact(ctx, 'nginx-proxy', 'file')?.path ?? names.vhostAvailable,
    vhostEnabled: ownedArtifact(ctx, 'nginx-proxy', 'symlink')?.path ?? names.vhostEnabled,
    htpasswd: ownedArtifact(ctx, 'nginx-proxy', 'htpasswd')?.path ?? names.htpasswd,
  };
}

const recordedProxy = (ctx: InstallContext) => ctx.state.steps['nginx-proxy']?.created?.artifacts.some((a) => a.kind === 'owned') === true;

/** After the switch the ledger wins and a fresh install gets the new names. Before it, the constants. */
export function recordedSite(ctx: InstallContext, rebrand: boolean): Pick<UbuntuNames, 'vhostAvailable' | 'vhostEnabled' | 'htpasswd'> {
  if (!rebrand) return ubuntuNames(ctx.instance, false);
  return recordedProxy(ctx) ? ledgerSite(ctx) : ubuntuNames(ctx.instance, true);
}

/** Undo removes recorded paths. Without a ledger after the switch, both name sets are cezar-owned. */
export function sitePathsToRemove(ctx: InstallContext, rebrand: boolean): { files: string[]; dirs: string[] } {
  const sets = !rebrand || recordedProxy(ctx) ? [recordedSite(ctx, rebrand)] : [ubuntuNames(ctx.instance, true), ubuntuNames(ctx.instance, false)];
  const files = [...new Set(sets.flatMap((s) => [s.vhostEnabled, s.vhostAvailable, s.htpasswd]))];
  const dirs = [...new Set(sets.map((s) => s.htpasswd.slice(0, s.htpasswd.lastIndexOf('/'))))];
  return { files, dirs };
}
