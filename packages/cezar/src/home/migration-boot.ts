import { logPrefix } from './display.ts';
import { commandText } from './command.ts';
import type { Home } from './home.ts';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveHome } from './resolve.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { assertNoMigration } from './migration-guard.ts';
import { migrationHolderLive } from './migration-claim.ts';
import { readInstallMarker, type InstallMarker } from './install-marker.ts';
import { readMigrationRecord } from './migration-record.ts';
import { migrateLegacyHome } from './migrate.ts';
import { finishDeferredAccounts } from './migration-accounts.ts';
import { listServerInstances } from '../server-install/state.ts';
import { MIGRATABLE_PLATFORM_IDS } from '../server-install/types.ts';

export interface MigrationBootOptions { enabled?: boolean; legacy?: Home; deferFresh?: boolean }
export type MigrationBootResult = { kind: 'ready' } | { kind: 'staged' } | { kind: 'fresh'; prepare: () => void } | { kind: 'legacy'; home: Home };

/**
 * A staged group reads the target without writes. A legacy home that records an installed server with group migration support
 * keeps serving until `hsq server-migrate` commits the target: only that command stops the group,
 * stages the home and rolls every instance back on failure (spec §4 "Server installs").
 */
export function prepareMigrationHome(home: Home, env: NodeJS.ProcessEnv, {
  deferFresh = false, enabled = REBRAND_SWITCH, legacy = enabled ? resolveHome({ purpose: 'cli', env, layout: 'legacy' }) : undefined,
}: MigrationBootOptions = {}): MigrationBootResult {
  if (!enabled || !legacy) return { kind: 'ready' };
  if (migrationHolderLive(legacy.root)) assertNoMigration(legacy.root);
  if (migrationHolderLive(home.config)) assertNoMigration(home.config);
  // The serve lifecycle prepares the selected home again. Never migrate a legacy fallback into itself.
  if (home.layout === 'legacy') return { kind: 'ready' };
  const marker = readInstallMarker(home.config);
  legacy = recordedSource(legacy, marker);
  // Only a finished commit:false copy is a staged server group. A crashed or failed run leaves a
  // pending home without stagedAt, or a stale claim: restart it at step 4 (spec §4 step 3).
  if (isStagedHome(home, legacy, marker)) return { kind: 'staged' };
  if (marker?.state !== 'committed' && hasInstalledServer(legacy)) {
    console.warn(commandText(existsSync(join(home.config, 'install.json.failed'))
      ? `[hsq] server migration was rolled back; serving legacy home ${legacy.root}. Run hsq server-migrate to retry.`
      : `[hsq] ${legacy.root} records a server install; using it until hsq server-migrate moves every instance and the home as one group. Run hsq server-migrate.`));
    return { kind: 'legacy', home: legacy };
  }
  if (deferFresh && !marker && !existsSync(legacy.root)) {
    return { kind: 'fresh', prepare: () => {
      // A legacy server install or a staged group can appear before the first write. Never write the split home then.
      if (prepareMigrationHome(home, env, { enabled, legacy }).kind === 'ready') return;
      throw new Error(commandText(`[hsq] refusing to write home ${home.root}: a server install in ${legacy.root} must move first. Run hsq server-migrate.`));
    } };
  }
  return migrateAtBoot(home, legacy, env);
}

/** A committed home names its source. A later launch may name only HSQ_HOME, so the env no longer selects it. */
function recordedSource(legacy: Home, marker: InstallMarker | undefined): Home {
  if (marker?.state !== 'committed' || !marker.migratedFrom || resolve(marker.migratedFrom) === resolve(legacy.root)) return legacy;
  return resolveHome({ purpose: 'cli', env: { CEZ_HOME: marker.migratedFrom }, layout: 'legacy' });
}

const UNWRITABLE = new Set(['EROFS', 'EACCES', 'EPERM']);

/** Zero config: a read-only home degrades the cockpit, never fails the boot. */
function migrateAtBoot(home: Home, legacy: Home, env: NodeJS.ProcessEnv): MigrationBootResult {
  try {
    migrateLegacyHome(legacy, home, { env });
    finishDeferredAccounts(legacy, home);
    return { kind: 'ready' };
  } catch (error) {
    if (!UNWRITABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const committed = readInstallMarker(home.config)?.state === 'committed';
    console.warn(`${logPrefix()} cannot finish the home migration from ${legacy.root} to ${home.root} (${(error as Error).message}); `
      + (committed ? 'serving the migrated home.' : `serving ${legacy.root} until both homes are writable.`));
    return committed ? { kind: 'ready' } : { kind: 'legacy', home: legacy };
  }
}

/** Only a completed server install needs the explicit group migration command. */
function hasInstalledServer(legacy: Home): boolean {
  return listServerInstances(legacy).some(({ state }) =>
    state.installed && !state.dryRun && MIGRATABLE_PLATFORM_IDS.some((id) => id === state.platform));
}

/** A crash without stagedAt must restart migration instead of serving partial copies. */
function isStagedHome(home: Home, legacy: Home, marker: InstallMarker | undefined): boolean {
  return marker?.state === 'pending' && !existsSync(join(legacy.root, '.migrating'))
    && readMigrationRecord(home)?.stagedAt !== undefined;
}
