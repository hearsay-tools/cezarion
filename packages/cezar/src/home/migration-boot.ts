import type { Home } from './home.ts';
import { resolveHome } from './resolve.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { assertNoMigration } from './migration-guard.ts';
import { readInstallMarker } from './install-marker.ts';
import { migrateLegacyHome } from './migrate.ts';
import { finishDeferredAccounts } from './migration-accounts.ts';

export interface MigrationBootOptions { enabled?: boolean; legacy?: Home }

/** Return true for a P2c pending home: boot reads it without seeding, migrating or writing. */
export function prepareMigrationHome(home: Home, env: NodeJS.ProcessEnv, {
  enabled = REBRAND_SWITCH, legacy = enabled ? resolveHome({ purpose: 'cli', env, layout: 'legacy' }) : undefined,
}: MigrationBootOptions = {}): boolean {
  if (!enabled || !legacy) return false;
  assertNoMigration(legacy.root);
  assertNoMigration(home.config);
  if (readInstallMarker(home.config)?.state === 'pending') return true;
  migrateLegacyHome(legacy, home, { env });
  finishDeferredAccounts(legacy, home);
  return false;
}
