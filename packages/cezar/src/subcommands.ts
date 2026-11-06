/**
 * The CLI subcommands that take flags of their own, so `index.ts` runs them before its global
 * parseArgs: their flags are not cockpit flags (#504, #774, #1576). Each module loads only when
 * its command runs.
 */

import { resolveHome } from './home/resolve.ts';
export type SubcommandRunner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export const SUBCOMMAND_NAMES = ['backup', 'discover', 'artifact', 'task', 'automation', 'webhook', 'worker', 'message', 'remote-settings'] as const;

/** The runner for `name`, or nothing when `name` is not a subcommand. */
export async function loadSubcommand(name: string | undefined): Promise<SubcommandRunner | undefined> {
  switch (name) {
    case 'backup': return (await import('./workspace/backup-cli.ts')).runBackupCommand;
    case 'discover': return (await import('./discovery/cli.ts')).runDiscoverCommand;
    case 'artifact': return (await import('./artifacts/cli.ts')).runArtifactCommand;
    case 'task': return (await import('./task-cli/cli.ts')).runTaskCommand;
    case 'automation': return (await import('./automations/automation-cli.ts')).runAutomationCommand;
    case 'webhook': return (await import('./webhooks/cli.ts')).runWebhookCommand;
    case 'message': return (await import('./delegation/cli.ts')).runMessageCommand;
    case 'worker': return (await import('./delegation/cli.ts')).runWorkerCommand;
    case 'remote-settings': return (await import('./remote-settings-cli.ts')).runRemoteSettingsCommand;
    default: return undefined;
  }
}

/** Run `argv[0]` when it names a subcommand and answer its exit code; anything else is not ours. */
export async function runSubcommand(argv: string[], env: NodeJS.ProcessEnv, home = () => resolveHome({ purpose: 'cli', env })): Promise<number | undefined> {
  // Only operator commands receive Home. Task runners keep their two-argument contract.
  if (argv[0] === 'backup') return (await import('./workspace/backup-cli.ts')).runBackupCommand(argv.slice(1), env, home());
  if (argv[0] === 'remote-settings') return (await import('./remote-settings-cli.ts')).runRemoteSettingsCommand(argv.slice(1), env, undefined, home());
  const run = await loadSubcommand(argv[0]);
  return run ? run(argv.slice(1), env) : undefined;
}
