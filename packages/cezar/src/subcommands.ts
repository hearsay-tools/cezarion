/**
 * The CLI subcommands that take flags of their own, so `index.ts` runs them before its global
 * parseArgs: their flags are not cockpit flags (#504, #774, #1576). Each module loads only when
 * its command runs.
 */

import type { Home } from './home/home.ts';
import { resolveHome } from './home/resolve.ts';
import { REBRAND_SWITCH } from './home/switch.ts';
export type SubcommandRunner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export const SUBCOMMAND_NAMES = ['backup', 'discover', 'artifact', 'task', 'automation', 'webhook', 'worker', 'message', 'remote-settings', ...(REBRAND_SWITCH ? ['migrate', 'server-migrate', 'migrate-project'] : [])] as const;

/** The runner for `name`, or nothing when `name` is not a subcommand. */
export async function loadSubcommand(name: string | undefined, home: (env: NodeJS.ProcessEnv) => Home = env => resolveHome({ purpose: 'cli', env }), rebrand = REBRAND_SWITCH): Promise<SubcommandRunner | undefined> {
  if (rebrand && name === 'migrate') return (await import('./home/migration-cli.ts')).runMigrationCommand;
  if (rebrand && name === 'migrate-project') return (await import('./project-migration/cli.ts')).migrateProjectRunner(env => [
    resolveHome({ purpose: 'cli', env, layout: 'legacy' }), resolveHome({ purpose: 'cli', env, layout: 'split' })]);
  if (rebrand && name === 'server-migrate') return async (argv, env) => {
    const legacy = resolveHome({ purpose: 'cli', env, layout: 'legacy' }), target = resolveHome({ purpose: 'cli', env, layout: 'split' });
    return (await import('./server-install/migrate-cli.ts')).runServerMigrateCommand(argv, env, { legacy, target });
  };
  switch (name) {
    case 'backup': return async (argv, env) => {
      return (await import('./workspace/backup-cli.ts')).runBackupCommand(argv, env, home(env));
    };
    case 'discover': return (await import('./discovery/cli.ts')).runDiscoverCommand;
    case 'artifact': return (await import('./artifacts/cli.ts')).runArtifactCommand;
    case 'task': return (await import('./task-cli/cli.ts')).runTaskCommand;
    case 'automation': return (await import('./automations/automation-cli.ts')).runAutomationCommand;
    case 'webhook': return (await import('./webhooks/cli.ts')).runWebhookCommand;
    case 'message': return (await import('./delegation/cli.ts')).runMessageCommand;
    case 'worker': return (await import('./delegation/cli.ts')).runWorkerCommand;
    case 'remote-settings': return async (argv, env) => {
      return (await import('./remote-settings-cli.ts')).runRemoteSettingsCommand(argv, env, undefined, home(env));
    };
    default: return undefined;
  }
}

/** Run `argv[0]` when it names a subcommand and answer its exit code; anything else is not ours. */
export async function runSubcommand(argv: string[], env: NodeJS.ProcessEnv, home = () => resolveHome({ purpose: 'cli', env })): Promise<number | undefined> {
  // Only operator runners call the lazy Home factory. Task runners keep two arguments.
  const run = await loadSubcommand(argv[0], () => home());
  return run ? run(argv.slice(1), env) : undefined;
}
