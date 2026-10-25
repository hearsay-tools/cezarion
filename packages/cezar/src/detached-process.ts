import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Starts a process that outlives the call that started it, and later stops it
 * (hearsay-tools/cezarion#1717, hearsay-tools/cezarion#1815). It holds the Process exits cases
 * of AGENTS.md § Case tables, so a caller that starts through it owns only its own handle and
 * the phases of its own start.
 *
 * A started process leads its own process group (on POSIX), and its start identity is recorded:
 * `stopGroup` ends every member the leader forked, and never signals a pid that now names
 * another process.
 *
 * `.ai/scripts` imports this file from source, before any build, through Node's type stripping.
 * So it imports only Node builtins and uses only TypeScript syntax that strips to JavaScript.
 */

/** A process's start identity: one incarnation, so a reused pid never matches. */
export type ReadStart = (pid: number) => string | undefined;

/** A group leader as its starter recorded it; `start` is absent where it could not be read. Such a
 *  leader is never signalled: nothing tells its incarnation from a process that reused its pid. */
export interface GroupLeader {
  readonly pid: number;
  readonly start?: string | undefined;
}

const POLL_MS = 100;

/** The fields after `comm` in a `/proc/<pid>/stat` line; `comm` may hold spaces and `)`, so the split is after the LAST `)`. */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
}

/** `/proc/<pid>/stat` field 3 (`state`) and field 22 (`starttime`). */
export function parseProcStat(stat: string): { state: string; startToken: string } | undefined {
  const fields = statFields(stat);
  return stat.includes(')') && fields.length >= 20 && /^\d+$/.test(fields[19]!)
    ? { state: fields[0]!, startToken: fields[19]! } : undefined;
}

let bootId: string | null | undefined;
/** `starttime` counts ticks since boot, so it repeats across reboots; the boot id scopes it. */
export function linuxBootId(): string | undefined {
  if (bootId === undefined) { try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { bootId = null; } }
  return bootId ?? undefined;
}

/** One process incarnation, so a reused PID never matches. Absent when the platform cannot say. */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') {
    let start: string | undefined;
    try { start = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.startToken; } catch { /* gone or unreadable */ }
    const boot = linuxBootId();
    return start && boot ? `${boot}:${start}` : start;
  }
  if (platform !== 'darwin') return undefined;
  // `lstart` is locale- and zone-formatted; pin both so the token is stable across cezar processes.
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const token = ps.status === 0 ? ps.stdout.trim() : '';
  return token || undefined;
}

/** A `detached: true` spawn. On POSIX the child leads a new process group, so `stopGroup`
 *  reaches every member it forks; on Windows it gets a console of its own. */
export function spawnDetached(file: string, args: readonly string[], options: Omit<SpawnOptions, 'detached'> = {}): ChildProcess {
  return spawn(file, args, { ...options, detached: true });
}

export interface OwnedStartOptions extends Omit<SpawnOptions, 'detached'> {
  readStart?: ReadStart;
  /** Stop the group and throw when its start identity cannot be read: no later stop could name it. */
  requireStart?: boolean;
}

/** Starts `file` as the leader of a process group its caller owns, and records its start identity.
 *  The caller unrefs the child when the process must outlive it. */
export async function startOwnedGroup(file: string, args: readonly string[], options: OwnedStartOptions = {}): Promise<{ child: ChildProcess; leader: GroupLeader }> {
  const { readStart = processStartToken, requireStart = false, ...spawnOptions } = options;
  const child = spawnDetached(file, args, spawnOptions);
  await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  const pid = child.pid!;
  const start = readStart(pid);
  if (start === undefined && requireStart) {
    // The 'spawn' event and this continuation run before the event loop polls again, so Node has
    // not reaped the child and its pid still names its group.
    killNow(pid);
    throw new Error(`cannot read the start identity of pid ${pid}`);
  }
  return { child, leader: start === undefined ? { pid } : { pid, start } };
}

/** SIGKILL for the group `pid` leads; on Windows, its process tree. */
function killNow(pid: number): void {
  if (process.platform === 'win32') { killTree(pid); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* the group already ended */ }
}

/** Windows has no process groups: end the leader's process tree. */
function killTree(pid: number): void {
  spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 5_000 });
}

type ProcessState = 'gone' | 'zombie' | 'live';

/** Whether `pid` runs: an exited process its parent has not reaped yet is a zombie, not a runner. */
function processState(pid: number): ProcessState {
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'; }
  if (process.platform === 'linux') {
    try { return /^[ZX]$/.test(statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'))[0] ?? '') ? 'zombie' : 'live'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'live'; }
  }
  if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
    if (ps.status === 0 && ps.stdout.trim().startsWith('Z')) return 'zombie';
  }
  return 'live';
}

/** `running`: the recorded incarnation runs. `gone`: it exited, or its pid now names another
 *  process. `unknown`: it runs but its start identity cannot be read, which proves nothing. */
function leaderStatus(leader: GroupLeader, readStart: ReadStart): 'running' | 'gone' | 'unknown' {
  if (processState(leader.pid) !== 'live') return 'gone';
  if (leader.start === undefined) return 'unknown';
  const current = readStart(leader.pid);
  if (current === undefined) return 'unknown';
  return current === leader.start ? 'running' : 'gone';
}

/** True while the recorded leader runs: the same incarnation, and not a zombie. */
export function leaderRunning(leader: GroupLeader, readStart: ReadStart = processStartToken): boolean {
  return leaderStatus(leader, readStart) === 'running';
}

/** True while the group `leader` started still has a member, zombies included. A group outlives
 *  its leader while any member is unreaped, and the kernel never hands out a pid that still names
 *  a group, so `-pid` reaches only this group until then. A live process with the leader's pid
 *  and another start identity means the group ended and the pid was reused. */
/** Whether the group `leader` started may still have members. `unknown` when its pid names a live
 *  process the record cannot verify, which may lead another group now. A leader that is gone leaves
 *  its group's id reserved while any member lives, so a group by that id is still its own. */
function groupStatus(leader: GroupLeader, readStart: ReadStart): 'exists' | 'gone' | 'unknown' {
  // Windows has no process groups: the recorded leader is all there is.
  if (process.platform === 'win32') {
    const status = leaderStatus(leader, readStart);
    return status === 'running' ? 'exists' : status;
  }
  const answers = () => {
    try { process.kill(-leader.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  if (leader.start === undefined) return answers() ? 'unknown' : 'gone';
  if (processState(leader.pid) !== 'gone') {
    const current = readStart(leader.pid);
    if (current === undefined) return 'unknown';
    if (current !== leader.start) return 'gone';
  }
  return answers() ? 'exists' : 'gone';
}
export function groupExists(leader: GroupLeader, readStart: ReadStart = processStartToken): boolean {
  return groupStatus(leader, readStart) !== 'gone';
}

/** True when one look at the process table finds a member of group `pgid` that is not a zombie,
 *  or cannot read the table. Linux reads /proc, macOS asks ps. */
function liveMember(pgid: number): boolean {
  if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2_000 });
    if (ps.status !== 0) return true;
    return ps.stdout.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pgid && !state?.startsWith('Z');
    });
  }
  if (process.platform !== 'linux') return true;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const fields = statFields(readFileSync(`/proc/${name}/stat`, 'utf8'));
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
    } catch (error) {
      // A process that exited after the listing is no member; one it cannot read may be.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') return true;
    }
  }
  return false;
}

/** True while the group `leader` started may still hold a running process. Zombies do not count:
 *  one whose parent never reaps it, such as a container init that does not wait, keeps the group
 *  forever. Before SIGKILL a scan can miss a member forked while it ran, by a member that exited
 *  before the scan reached it. After SIGKILL no member can fork, so a scan that finds none is
 *  final, and the answer only goes from true to false. */
export function groupRunning(leader: GroupLeader, readStart: ReadStart = processStartToken): boolean {
  return groupExists(leader, readStart) && liveMember(leader.pid);
}

export interface StopOptions {
  /** How long the group has to exit after SIGTERM. */
  graceMs?: number;
  /** How long the group has to disappear after SIGKILL, before the stop gives its verdict. */
  killWaitMs?: number;
  readStart?: ReadStart;
}

/** Stops the process group `leader` started: SIGTERM, then SIGKILL for whatever outlives the
 *  grace, the leader or any other member. True once no member runs. SIGKILL goes to every group
 *  that still exists, zombies only included, so it also reaches a member a scan missed. On
 *  Windows it ends the recorded leader's process tree at once, then waits `killWaitMs`. A live
 *  leader whose start is not recorded, or cannot be read now, is never signalled; the stop reports
 *  it stopped only once no member runs. */
export async function stopGroup(leader: GroupLeader, options: StopOptions = {}): Promise<boolean> {
  const { graceMs = 10_000, killWaitMs = 1_000, readStart = processStartToken } = options;
  if (process.platform === 'win32') {
    // Only the recorded incarnation's tree: an unreadable identity could be a reused pid.
    const status = leaderStatus(leader, readStart);
    if (status !== 'running') return status === 'gone';
    killTree(leader.pid);
    const deadline = performance.now() + killWaitMs;
    while (processState(leader.pid) !== 'gone' && performance.now() < deadline) await delay(POLL_MS);
    return processState(leader.pid) === 'gone';
  }
  for (const [signal, waitMs] of [['SIGTERM', graceMs], ['SIGKILL', killWaitMs]] as const) {
    const status = groupStatus(leader, readStart);
    if (status === 'gone') return true;
    // The pid may lead another group now: report, never signal.
    if (status === 'unknown') return !groupRunning(leader, readStart);
    try { process.kill(-leader.pid, signal); } catch { /* the group already ended */ }
    const deadline = performance.now() + waitMs;
    while (groupRunning(leader, readStart) && performance.now() < deadline) await delay(POLL_MS);
  }
  return !groupRunning(leader, readStart);
}

/** What a watcher decided: stop the group for `reason`, then `settle` with the stop's verdict. */
export interface WatchVerdict {
  reason: string;
  settle?: (stopped: boolean) => void | Promise<void>;
}

export interface WatchOptions {
  leader: GroupLeader;
  intervalMs: number;
  readStart?: ReadStart;
  /** While this process runs, the group's starter still owns it, and nothing is decided. */
  starter?: GroupLeader;
  /** Asked at each poll while the leader runs: a verdict stops the group. */
  decide: () => WatchVerdict | undefined | Promise<WatchVerdict | undefined>;
  stop?: Omit<StopOptions, 'readStart'>;
}

/** Watches a group nobody else will stop, and stops it when `decide` says so. A leader that exits
 *  on its own leaves nothing behind: the rest of its group is stopped too, for the reason
 *  `exited`. A stop that fails is tried again at the next poll. Resolves with the reason. The
 *  leader needs a recorded start: without one, nothing is ever decided or stopped. */
export async function watchGroup(options: WatchOptions): Promise<string> {
  const { leader, intervalMs, readStart = processStartToken, starter, decide, stop = {} } = options;
  while (true) {
    await delay(intervalMs);
    if (starter && leaderRunning(starter, readStart)) continue;
    const status = leaderStatus(leader, readStart);
    // An unreadable identity proves nothing either way: look again at the next poll.
    if (status === 'unknown') continue;
    const verdict: WatchVerdict | undefined = status === 'gone' ? { reason: 'exited' } : await decide();
    if (!verdict) continue;
    const stopped = await stopGroup(leader, { ...stop, readStart });
    await verdict.settle?.(stopped);
    if (stopped) return verdict.reason;
  }
}
