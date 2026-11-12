import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { commandText } from '../home/command.ts';
import type { Home } from '../home/home.ts';
import { getRepoInfo } from '../server/git.ts';
import { migrationAnswerText } from './answer.ts';
import { migrateProjectOffline } from './offline.ts';
import type { MigrationFault } from './steps.ts';

/**
 * `migrate-project [--dry-run] [--repo <dir>]` (hearsay-tools/cezarion#3089): the offline project
 * migration, run only by the user, registered only with the release switch.
 */

const HELP = commandText(`Usage: cez migrate-project [--dry-run] [--repo <dir>]
Move this project's runtime state from .ai/cezar/ to .ai/squawk/, offline. Stop every
cockpit that serves the project first; the command names what it finds still running.
A task that is not archived keeps its own files (worktree, handoff, scratch) in
.ai/cezar/ until it is archived; run the command again, or start a cockpit, to move them then. It cannot see a cockpit of another home that
lists the project but never opened it: stop it yourself, and keep older binaries off
the project. Tracked files are never moved: the command prints the
git mv commands to run and commit.

    --dry-run     print every move, repair and rewrite; only an unfinished
                  migration is completed (and reported) first; exits 1
                  if the plan has blockers or conflicts
    --repo <dir>  the project (default: the current directory)
-h, --help        show this help`);

export interface MigrateProjectDeps {
  /** The homes whose live cockpits may serve the project. */
  homes: readonly Home[];
  /** Test seam: the engine's fault points (`MigrationFault`), and `plan:before` in a dry run. */
  fault?: MigrationFault;
  /** Test seam: the process the cockpit check skips (this one). */
  self?: number;
  getRepoInfo: typeof getRepoInfo;
  cwd: () => string;
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function runMigrateProjectCommand(argv: string[], deps: MigrateProjectDeps): Promise<number> {
  let values: { 'dry-run'?: boolean; repo?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    deps.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 1;
  }
  if (values.help) { deps.log(HELP); return 0; }
  try {
    // A missing --repo is a refusal like any other: one line on stderr, exit 1.
    const cwd = resolve(values.repo ?? deps.cwd());
    const root = realpathSync((await deps.getRepoInfo(cwd))?.root ?? cwd);
    const answer = await migrateProjectOffline(root, { homes: deps.homes, dryRun: values['dry-run'] === true, fault: deps.fault, self: deps.self });
    deps.log(migrationAnswerText(answer));
    return answer.blocked ? 1 : 0;
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** The runner the subcommand table registers. */
export function migrateProjectRunner(homes: (env: NodeJS.ProcessEnv) => readonly Home[]) {
  return (argv: string[], env: NodeJS.ProcessEnv) => runMigrateProjectCommand(argv, {
    homes: homes(env), getRepoInfo, cwd: () => process.cwd(), log: line => console.log(line), error: line => console.error(line),
  });
}
