/** The project's `worktreeTeardown` commands (spec `.ai/specs/2026-10-07-worktree-setup.md`): they stop
 * what a worker's worktree started for itself, such as a test server or a file watcher, before destroy
 * looks for holders (hearsay-tools/squawk#914, hearsay-tools/squawk#1926). The app knows no tool here: a
 * holder the commands leave is named in the refusal and never signalled. */
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { loadConfig } from '../config.ts';
import type { Home } from '../home/home.ts';
import { resolveWorktreeSetup, runWorktreeSetup, worktreeSetupEnv, worktreeSetupRecordError } from '../worktree-setup.ts';
import { ownedWorktreePresent } from './workspace-removal.ts';

/** Runs the commands in the worker's worktree, as worktree setup runs its own: in order, each bounded by
 * the timeout, stopping at the first failure. It acts only on a worktree whose ownership is proven at its
 * own real path, so a redirected or replaced path never runs them in another checkout. Undefined when
 * nothing failed; else why, so the caller records it and its next attempt runs the teardown again. */
export async function runWorktreeTeardown(project: { root: string; home: Home }, workspace: WorkerWorkspace): Promise<string | undefined> {
  const plan = resolveWorktreeSetup((await loadConfig(project.root, project.home)).worktreeTeardown);
  if (plan.kind === 'none') return undefined;
  if (plan.kind === 'invalid') return `invalid config: ${plan.issue}`;
  if (!await ownedWorktreePresent(project.root, workspace)) return undefined;
  const outcome = await runWorktreeSetup({ plan, cwd: workspace.path,
    env: worktreeSetupEnv({ projectRoot: project.root, runId: workspace.ownerRunId, tmpEnv: {} }),
    setInterrupt: () => {}, isCancelled: () => false, onCommandResult: () => {} });
  return worktreeSetupRecordError(outcome);
}
