import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { KILL_GRACE_MS } from './runner-runtime.ts';

/**
 * Agent session leaders run in their own process group on POSIX (hearsay-tools/cezarion#890), so
 * Stop, the kill switches, destroy and cezar's own SIGINT/SIGTERM reach what an agent left
 * behind in the worktree. A process that left the group (`setsid`, `setpgid`) is never signalled.
 *
 * Signalling a group whose leader already exited is safe: Linux frees a pid number only when no
 * task uses it as a pid, pgid or sid (`__change_pid` → `free_pid`), and XNU skips a candidate pid
 * while `pghash_exists_locked(pid)` (`forkproc`). While any member lives no new process can get
 * the number; once the group is empty `kill(-pgid)` answers ESRCH. An entry is dropped the first
 * time its group is seen empty, so a number freed and reused by a new `setsid` leader is not
 * signalled after that.
 *
 * win32 has no groups: the leader stays attached to cezar's console and `taskkill /T /F` ends
 * its tree by parent pid at call time.
 */

type Leader = { child: ChildProcess; signalledAt?: number };
/** Grouped leaders this process spawned, keyed by pgid (= the leader's pid). */
const leaders = new Map<number, Leader>();

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
// -1 and 0 address every process and our own group: never a session.
const groupId = (pgid: number) => Number.isSafeInteger(pgid) && pgid > 1;

export function processGroupAlive(pgid: number): boolean {
  if (!groupId(pgid)) return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!groupId(pgid)) return;
  try { process.kill(-pgid, signal); } catch { /* ESRCH: empty; EPERM: no member is ours */ }
}

function prune(): void {
  for (const [pgid, leader] of leaders) if (exited(leader.child) && !processGroupAlive(pgid)) leaders.delete(pgid);
}

/** Spawn an agent session leader. Only a real detached `ChildProcess` with a pid is registered,
 * so a test's fake child (made-up pid) never reaches `process.kill(-pid)`. */
export function spawnSessionLeader(
  bin: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const grouped = process.platform !== 'win32';
  const child = spawn(bin, [...args], { cwd: options.cwd, env: options.env, detached: grouped });
  const pid = child.pid;
  if (!grouped || !(child instanceof ChildProcess) || pid === undefined || !groupId(pid)) return child;
  prune();
  const leader: Leader = { child };
  leaders.set(pid, leader);
  // Runners clear their own SIGKILL timers when the leader exits. A member that ignored the
  // SIGTERM cezar sent outlives it, so the follow-up SIGKILL for the group lives here.
  child.once('exit', () => {
    if (leaders.get(pid) !== leader) return;
    if (!processGroupAlive(pid)) { leaders.delete(pid); return; }
    if (leader.signalledAt === undefined) return;
    const timer = setTimeout(() => {
      if (leaders.get(pid) === leader && processGroupAlive(pid)) signalProcessGroup(pid, 'SIGKILL');
    }, Math.max(0, leader.signalledAt + KILL_GRACE_MS - Date.now()));
    timer.unref?.();
  });
  return child;
}

/** Signal a session: its whole group on POSIX, its tree on win32, else the leader alone. */
export function signalSession(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  const leader = pid === undefined ? undefined : leaders.get(pid);
  if (leader?.child === child) {
    leader.signalledAt ??= Date.now();
    signalProcessGroup(pid!, signal);
    return;
  }
  if (platform === 'win32' && pid !== undefined && !exited(child)) {
    try {
      const taskkill = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      taskkill.on('error', () => { if (!exited(child)) child.kill(signal); });
      return;
    } catch { /* fall back to the leader alone */ }
  }
  child.kill(signal);
}

/** The pgid of a registered, still-running grouped leader, for the worker process ledger. */
export function sessionGroupOf(pid: number): number | undefined {
  const leader = leaders.get(pid);
  return leader && !exited(leader.child) ? pid : undefined;
}

/** cezar's own SIGINT/SIGTERM, passed to every agent group that still has members. */
export function forwardToSessionGroups(signal: NodeJS.Signals): void {
  for (const pgid of [...leaders.keys()]) {
    if (processGroupAlive(pgid)) signalProcessGroup(pgid, signal);
    else leaders.delete(pgid);
  }
}
