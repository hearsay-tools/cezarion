import { commandText } from './command.ts';
import type { Home } from './home.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from './resolve.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { assertNoMigration } from './migration-guard.ts';
import { migrationHolderLive } from './migration-claim.ts';
import { readInstallMarker, type InstallMarker } from './install-marker.ts';
import { readMigrationRecord } from './migration-record.ts';
import { migrateLegacyHome } from './migrate.ts';
import { finishDeferredAccounts } from './migration-accounts.ts';
import { listServerInstances } from '../server-install/state.ts';
import { getStrategy, supportsServerMigration } from '../server-install/strategies.ts';

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
    return { kind: 'fresh', prepare: () => { prepareMigrationHome(home, env, { enabled, legacy }); } };
  }
  migrateLegacyHome(legacy, home, { env });
  finishDeferredAccounts(legacy, home);
  return { kind: 'ready' };
}

/** Only a completed server install needs the explicit group migration command. */
function hasInstalledServer(legacy: Home): boolean {
  return listServerInstances(legacy).some(({ state }) =>
    state.installed && !state.dryRun && supportsServerMigration(getStrategy(state.platform ?? '')));
}

/** A crash without stagedAt must restart migration instead of serving partial copies. */
function isStagedHome(home: Home, legacy: Home, marker: InstallMarker | undefined): boolean {
  return marker?.state === 'pending' && !existsSync(join(legacy.root, '.migrating'))
    && readMigrationRecord(home)?.stagedAt !== undefined;
}
