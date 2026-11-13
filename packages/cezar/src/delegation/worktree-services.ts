/** What a worker's worktree started for itself, stopped before destroy looks for holders
 * (hearsay-tools/squawk#914, hearsay-tools/squawk#1926). Each service stops through its own tool:
 * Squeal stops its daemon, and the test-env lease stops an idle app. A holder that is neither is
 * named in the refusal and never signalled. */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { withIdleTestApp } from './idle-test-app.ts';
import { ownedWorktreePresent } from './workspace-removal.ts';

const run = promisify(execFile);
/** `squeal stop` waits up to 60 s for its daemon to exit. */
const SQUEAL_STOP_MS = 75_000;

/** Whether a Squeal daemon validates `root`. Its title ends with its root:
 * `squeal <repo> daemon @<id> <cli> daemon <root>`. Its test runs, and the e2e lease their global
 * setup takes, live in its process group, whose cwd is the worktree. */
function squealDaemonRuns(root: string): boolean {
  const ps = spawnSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8', timeout: 2_000 });
  if (ps.status !== 0) return false;
  return ps.stdout.split('\n').some(line => line.startsWith('squeal ') && line.trimEnd().endsWith(` daemon ${root}`));
}

/** Bounded: what still holds the worktree afterwards is the holder scan's to report. It acts only on
 * a worktree whose ownership is proven at its own real path, so a redirected or replaced path never
 * reaches another checkout's services. False while a service of the worktree outlived its stop (a
 * Squeal daemon still running, a test app still leased), so the caller retries the stop in full. */
export async function stopWorktreeServices(repoRoot: string, workspace: WorkerWorkspace): Promise<boolean> {
  if (!await ownedWorktreePresent(repoRoot, workspace)) return true;
  const { path } = workspace;
  let squealStopped = true;
  if (process.platform !== 'win32' && squealDaemonRuns(path)) {
    // --until-start: a hook of the stopping session cannot start the daemon again.
    await run('squeal', ['stop', '--until-start', path], { timeout: SQUEAL_STOP_MS }).catch(() => undefined);
    squealStopped = !squealDaemonRuns(path);
  }
  // The lease tool's own stop: an app no live lease holder uses. The removal claims it again.
  let appStopped = true;
  await withIdleTestApp(path, async (_stopped, busy) => { appStopped = !busy; }).catch(() => { appStopped = false; });
  return squealStopped && appStopped;
}
