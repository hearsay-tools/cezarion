/** The project's `worktreeTeardown` commands (spec `.ai/specs/2026-10-07-worktree-setup.md`): they stop
 * what a worker's worktree started for itself, such as a test server or a file watcher, before destroy
 * looks for holders (hearsay-tools/squawk#914, hearsay-tools/squawk#1926). The app knows no tool here: a
 * holder the commands leave is named in the refusal and never signalled. */
import { realpath } from 'node:fs/promises';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { resolveWorktreeSetup, runWorktreeSetup, worktreeSetupEnv, worktreeSetupRecordError } from '../worktree-setup.ts';
import { ownedWorktreePresent } from './workspace-removal.ts';

/** Whether `workspace` is still the worktree destroy owns, and its path is its own real path. */
async function proven(root: string, workspace: WorkerWorkspace): Promise<boolean> {
  return await ownedWorktreePresent(root, workspace) && await realpath(workspace.path).catch(() => undefined) === workspace.path;
}

/** Runs `raw`, the project's `worktreeTeardown` value, in the worker's worktree, as worktree setup runs
 * its own: in order, each command bounded by the timeout, stopping at the first failure. Ownership is
 * proven again before each command, at the worktree's own real path, so a path an earlier command
 * redirected or replaced never runs the rest in another checkout. Undefined when nothing failed, or
 * when the worktree is not there to tear down; else why, so the caller records it and its next attempt
 * runs the teardown again. */
export async function runWorktreeTeardown(root: string, raw: unknown, workspace: WorkerWorkspace): Promise<string | undefined> {
  const plan = resolveWorktreeSetup(raw);
  if (plan.kind === 'none') return undefined;
  if (plan.kind === 'invalid') return `invalid config: ${plan.issue}`;
  const env = worktreeSetupEnv({ projectRoot: root, runId: workspace.ownerRunId, tmpEnv: {} });
  for (const [index, command] of plan.commands.entries()) {
    if (!await proven(root, workspace)) return index === 0 ? undefined : `the worktree's ownership is no longer proven before \`${command.slice(0, 120)}\``;
    const outcome = await runWorktreeSetup({ plan: { ...plan, commands: [command] }, cwd: workspace.path, env,
      setInterrupt: () => {}, isCancelled: () => false, onCommandResult: () => {} });
    const error = worktreeSetupRecordError(outcome);
    if (error) return error;
  }
  return undefined;
}
