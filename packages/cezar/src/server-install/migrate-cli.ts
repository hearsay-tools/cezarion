import { parseArgs } from 'node:util';
import type { Home } from '../home/home.ts';
import { prepareHome } from '../home/entry.ts';
import { runServerMigrate, type ServerMigrateOptions } from './group-migrate.ts';
import type { Runner, Ui } from './types.ts';

const USAGE = `Usage: cez server-migrate [--dry-run] [--yes]
Move every server install recorded in the legacy home to the new unit, site and home names, as one group.
  --dry-run   list every unit, site, file and environment line it would change; change nothing
  --yes       accept safe defaults (privileged commands still need passwordless sudo or your paste)`;

export interface ServerMigrateHomes {
  legacy: Home;
  target: Home;
  ui?: Ui;
  runner?: Runner;
  strategy?: ServerMigrateOptions['strategy'];
}

/** `cez server-migrate`, registered only while the release switch is on. Exit 0 means no change is pending. */
export async function runServerMigrateCommand(argv: string[], env: NodeJS.ProcessEnv, homes: ServerMigrateHomes): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: {
      'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log(USAGE); return 0; }
    const dryRun = values['dry-run'] === true;
    const assumeYes = values.yes === true;
    // The legacy home is the writer until the group commits. Never auto-migrate it at entry.
    prepareHome(homes.legacy, 'server-migrate', env);
    const { createAutoUi, createClackUi } = await import('./ui.ts');
    const ui = homes.ui ?? (dryRun || assumeYes ? createAutoUi({}, (m) => console.log(m), { strictValidate: !dryRun }) : createClackUi());
    const strategy = homes.strategy ?? (await import('./strategies.ts')).getStrategy;
    const result = await runServerMigrate({
      legacy: homes.legacy, target: homes.target, strategy, dryRun, assumeYes, repoRoot: process.cwd(),
      now: new Date().toISOString(), ui, env, ...(homes.runner ? { runner: homes.runner } : {}),
    });
    return ['migrated', 'unchanged', 'planned'].includes(result.status) ? 0 : 1;
  } catch (error) {
    console.error(`[cez] server-migrate failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
