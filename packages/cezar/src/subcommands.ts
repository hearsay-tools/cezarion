/**
 * The CLI subcommands that take flags of their own, so `index.ts` runs them before its global
 * parseArgs: their flags are not cockpit flags (#504, #774, #1576). Each module loads only when
 * its command runs.
 */

export type SubcommandRunner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export const SUBCOMMANDS: Readonly<Record<string, () => Promise<SubcommandRunner>>> = {
  discover: async () => (await import('./discovery/cli.ts')).runDiscoverCommand,
  artifact: async () => (await import('./artifacts/cli.ts')).runArtifactCommand,
  task: async () => (await import('./task-cli/cli.ts')).runTaskCommand,
  automation: async () => (await import('./automations/automation-cli.ts')).runAutomationCommand,
  webhook: async () => (await import('./webhooks/cli.ts')).runWebhookCommand,
  worker: async () => (await import('./delegation/cli.ts')).runWorkerCommand,
};

/** Run `argv[0]` when it names a subcommand and answer its exit code; anything else is not ours. */
export async function runSubcommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number | undefined> {
  const [name, ...rest] = argv;
  if (name === undefined || !Object.hasOwn(SUBCOMMANDS, name)) return undefined;
  const run = await SUBCOMMANDS[name]!();
  return run(rest, env);
}
