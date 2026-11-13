import { commandText } from './command.ts';
import { parseArgs } from 'node:util';
import { homeFileSchema } from '@open-mercato/cezar-contract/home-recovery';
import type { Home } from './home.ts';
import { resolveHome } from './resolve.ts';
import { planLegacyMigration } from './migration-plan.ts';
import { HomeStore } from './store.ts';
import { homeFileLocation } from './file-location.ts';
import { restorePinnedRecovery } from '../workspace/backup-cli.ts';

export const LEGACY_RECOVERY_COMMAND = commandText('hsq migrate --resolve-legacy <file> restore|accept');
const HELP = commandText(`Usage: hsq migrate [--dry-run]
       ${LEGACY_RECOVERY_COMMAND}
Inspect or migrate the legacy home into the split layout.
Resolve a legacy recovery incident before migration: restore its pinned version,
or accept its current bytes. Use a supported home-relative file, such as config.json.
Recovery does not migrate the home. Run hsq migrate again after recovery.
--resolve-legacy cannot be combined with --dry-run.`);

function recoveryAction(file: string | undefined, positionals: string[], dryRun: boolean | undefined): 'restore' | 'accept' | undefined {
  if (file === undefined) {
    if (positionals.length) throw new Error(HELP);
    return;
  }
  if (!homeFileSchema.safeParse(file).success) throw new Error('File must be a supported home-relative HomeStore file');
  const [action] = positionals;
  if (dryRun || positionals.length !== 1 || (action !== 'restore' && action !== 'accept')) throw new Error(HELP);
  return action;
}

export async function runMigrationCommand(argv: string[], env: NodeJS.ProcessEnv, target?: Home, legacy?: Home): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      'dry-run': { type: 'boolean' }, 'resolve-legacy': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log(HELP); return 0; }
    const file = values['resolve-legacy'];
    const action = recoveryAction(file, positionals, values['dry-run']);
    legacy ??= resolveHome({ purpose: 'cli', env, layout: 'legacy' });
    if (file !== undefined && action) {
      // Migration inspections are report-only. Persist backup-derived resets before resolving them.
      const store = new HomeStore(legacy), path = homeFileLocation(legacy, file).path;
      store.recovery(path);
      // The legacy home has no older home of its own: accept its live-file incident only.
      if (action === 'restore') restorePinnedRecovery(file, legacy);
      else store.acceptRecovery(path);
      console.log(JSON.stringify({ file, action }, null, 2));
      return 0;
    }
    target ??= resolveHome({ purpose: 'cli', env, layout: 'split' });
    const { migrateLegacyHome } = await import('./migrate.ts');
    console.log(JSON.stringify(values['dry-run'] ? { dryRun: true, plan: planLegacyMigration(legacy, target) }
      : migrateLegacyHome(legacy, target, { env }), null, 2));
    return 0;
  } catch (error) { console.error(`${commandText('[hsq] migration failed:')} ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
