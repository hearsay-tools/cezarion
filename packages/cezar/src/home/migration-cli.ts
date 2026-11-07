import { parseArgs } from 'node:util';
import type { Home } from './home.ts';
import { resolveHome } from './resolve.ts';
import { migrateLegacyHome } from './migrate.ts';
import { planLegacyMigration } from './migration-plan.ts';

export async function runMigrationCommand(argv: string[], env: NodeJS.ProcessEnv, target?: Home, legacy?: Home): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) { console.log('Usage: cez migrate [--dry-run]\nInspect or migrate the legacy home into the split layout.'); return 0; }
    target ??= resolveHome({ purpose: 'cli', env, layout: 'split' });
    legacy ??= resolveHome({ purpose: 'cli', env, layout: 'legacy' });
    console.log(JSON.stringify(values['dry-run'] ? { dryRun: true, plan: planLegacyMigration(legacy, target) }
      : migrateLegacyHome(legacy, target, { env }), null, 2));
    return 0;
  } catch (error) { console.error(`[cez] migration failed: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
