/** What a worker's worktree started for itself, stopped before destroy looks for holders
 * (hearsay-tools/squawk#914, hearsay-tools/squawk#1926). Each service stops through its own tool:
 * Squeal stops its daemon, and the test-env lease stops an idle app. A holder that is neither is
 * named in the refusal and never signalled. */
import { execFile, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { withIdleTestApp } from './idle-test-app.ts';

const run = promisify(execFile);
/** `squeal stop` waits up to 60 s for its daemon to exit. */
const SQUEAL_STOP_MS = 75_000;

/** Whether a Squeal daemon validates one of `roots`. Its title ends with its root:
 * `squeal <repo> daemon @<id> <cli> daemon <root>`. Its test runs, and the e2e lease their global
 * setup takes, live in its process group, whose cwd is the worktree. */
function squealDaemonRuns(roots: readonly string[]): boolean {
  const ps = spawnSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8', timeout: 2_000 });
  if (ps.status !== 0) return false;
  return ps.stdout.split('\n').some(line => line.startsWith('squeal ') && roots.some(root => line.trimEnd().endsWith(` daemon ${root}`)));
}

/** Best effort and bounded: what still holds the worktree afterwards is the holder scan's to report. */
export async function stopWorktreeServices(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    let real = path;
    try { real = realpathSync(path); } catch { /* a missing worktree runs nothing */ }
    // --until-start: a hook of the stopping session cannot start the daemon again.
    if (squealDaemonRuns([...new Set([path, real])])) await run('squeal', ['stop', '--until-start', path], { timeout: SQUEAL_STOP_MS }).catch(() => undefined);
  }
  // The lease tool's own stop: an app no live lease holder uses. The removal claims it again.
  await withIdleTestApp(path, async () => undefined).catch(() => undefined);
}
