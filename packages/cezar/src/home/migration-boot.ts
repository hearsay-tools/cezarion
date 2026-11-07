import type { Home } from './home.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from './resolve.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { assertNoMigration } from './migration-guard.ts';
import { migrationHolderLive } from './migration-claim.ts';
import { readInstallMarker } from './install-marker.ts';
import { migrateLegacyHome } from './migrate.ts';
import { finishDeferredAccounts } from './migration-accounts.ts';

export interface MigrationBootOptions { enabled?: boolean; legacy?: Home }

/** Return true for a P2c pending home: boot reads it without seeding, migrating or writing. */
export function prepareMigrationHome(home: Home, env: NodeJS.ProcessEnv, {
  enabled = REBRAND_SWITCH, legacy = enabled ? resolveHome({ purpose: 'cli', env, layout: 'legacy' }) : undefined,
}: MigrationBootOptions = {}): boolean {
  if (!enabled || !legacy) return false;
  if (migrationHolderLive(legacy.root)) assertNoMigration(legacy.root);
  if (migrationHolderLive(home.config)) assertNoMigration(home.config);
  // A staged server group has no claim. A crashed migration leaves a stale legacy claim;
  // resume that migration instead of treating its partial copy as a healthy staged home.
  if (readInstallMarker(home.config)?.state === 'pending' && !existsSync(join(legacy.root, '.migrating'))) return true;
  migrateLegacyHome(legacy, home, { env });
  finishDeferredAccounts(legacy, home);
  return false;
}
