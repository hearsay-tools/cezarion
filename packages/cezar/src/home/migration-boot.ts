import type { Home } from './home.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from './resolve.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { assertNoMigration } from './migration-guard.ts';
import { migrationHolderLive } from './migration-claim.ts';
import { readInstallMarker } from './install-marker.ts';
import { readMigrationRecord } from './migration-record.ts';
import { migrateLegacyHome } from './migrate.ts';
import { finishDeferredAccounts } from './migration-accounts.ts';
import { listServerInstances } from '../server-install/state.ts';

export interface MigrationBootOptions { enabled?: boolean; legacy?: Home }
export type MigrationBootResult = { kind: 'ready' } | { kind: 'staged' } | { kind: 'legacy'; home: Home };

/** A staged group reads the target without writes; a rolled-back server keeps its legacy home. */
export function prepareMigrationHome(home: Home, env: NodeJS.ProcessEnv, {
  enabled = REBRAND_SWITCH, legacy = enabled ? resolveHome({ purpose: 'cli', env, layout: 'legacy' }) : undefined,
}: MigrationBootOptions = {}): MigrationBootResult {
  if (!enabled || !legacy) return { kind: 'ready' };
  if (migrationHolderLive(legacy.root)) assertNoMigration(legacy.root);
  if (migrationHolderLive(home.config)) assertNoMigration(home.config);
  // The serve lifecycle prepares the selected home again. Never migrate a legacy fallback into itself.
  if (home.layout === 'legacy') return { kind: 'ready' };
  const marker = readInstallMarker(home.config);
  // Only a finished commit:false copy is a staged server group. A crashed or failed run leaves a
  // pending home without stagedAt, or a stale claim: restart it at step 4 (spec §4 step 3).
  if (marker?.state === 'pending' && !existsSync(join(legacy.root, '.migrating'))
    && readMigrationRecord(home)?.stagedAt !== undefined) return { kind: 'staged' };
  if (marker?.state !== 'committed' && existsSync(join(home.config, 'install.json.failed'))
    && listServerInstances(legacy).some(({ state }) => state.installed && !state.dryRun)) {
    console.warn(`[hsq] server migration was rolled back; serving legacy home ${legacy.root}. Run hsq server-migrate to retry.`);
    return { kind: 'legacy', home: legacy };
  }
  migrateLegacyHome(legacy, home, { env });
  finishDeferredAccounts(legacy, home);
  return { kind: 'ready' };
}
