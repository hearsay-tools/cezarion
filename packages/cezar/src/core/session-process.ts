import { ChildProcess, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { afterExitDrain, exitDrainBudget, KILL_GRACE_MS } from './runner-runtime.ts';

/**
 * Own POSIX session process groups and track member incarnations before signalling after leader
 * exit. Drain output before reaping; use the owned child tree on Windows. Escaped or unprovable
 * descendants may survive rather than risk signalling reused identities.
 */

type Member = { pid: number; token: string };
type Leader = { child: ChildProcess; signalledAt?: number; members?: Member[] };
/** Grouped leaders this process spawned, keyed by pgid (= the leader's pid). */
const leaders = new Map<number, Leader>();
/** Every child `spawnSessionLeader` returned, on any platform: win32's taskkill is for these only. */
const spawned = new WeakSet<ChildProcess>();

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

// include/linux/sched.h: set at the top of do_exit(), before exit_files() closes the sockets.
const PF_EXITING = 0x4;

/** A `/proc/<pid>/stat` line of a task that is exiting or already a zombie. Field 9 (`flags`)
 * follows the last `)`, like every field after `comm`. An unparsable line reads as alive. */
export function procStatExited(stat: string): boolean {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  if (!stat.includes(')') || fields.length < 7 || !/^\d+$/.test(fields[6]!)) return false;
  return fields[0] === 'Z' || (Number(fields[6]) & PF_EXITING) !== 0;
}

/** Exiting, exited, or a zombie Node has not reaped yet. A crashed leader closes its sockets
 * inside do_exit(), before it is a zombie: OpenCode sees its prompt's ACK drop and stops the
 * session in that window, so a zombie check alone races (harness row S19). */
function leaderExited(child: ChildProcess): boolean {
  if (exited(child)) return true;
  const pid = child.pid!;
  if (process.platform === 'linux') {
    try { return procStatExited(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
  }
  if (process.platform !== 'darwin') return false;
  // `ps` STAT: Z is a zombie, E a process trying to exit.
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  return ps.status === 0 ? /^Z|E/.test(ps.stdout.trim()) : ps.status === 1;
}
/** Positive exit evidence before classifying a cleanup signal as our teardown.
 * Unlike leaderExited's group-signal safety check, unknown evidence must keep
 * bounded cleanup armed (hearsay-tools/cezarion#1899). Node's exit notification
 * can lag EOF; signal 0 detects a reaped PID on every platform, and Linux also
 * exposes a zombie or exit-in-progress. Other platforms retain cleanup until
 * Node reports exit or the PID probe confirms absence. */
export function confirmedLeaderExit(child: ChildProcess, platform: NodeJS.Platform = process.platform): boolean {
  if (exited(child)) return true;
  const pid = child.pid;
  if (pid === undefined || !groupId(pid)) return false;
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (platform !== 'linux') return false;
  try { return procStatExited(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch { return false; }
}

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

/** `/proc/<pid>/stat` fields 5 (`pgrp`) and 22 (`starttime`) of a live task; a zombie answers
 * undefined. */
function procIdentity(stat: string): { pgrp: number; token: string } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  if (!stat.includes(')') || fields.length < 20 || fields[0] === 'Z' || !/^\d+$/.test(fields[2]!) || !/^\d+$/.test(fields[19]!)) return undefined;
  return { pgrp: Number(fields[2]), token: fields[19]! };
}

const psEnv = () => ({ ...process.env, LC_ALL: 'C', TZ: 'UTC' });

/** A live process's group and incarnation; undefined when it is gone or the platform cannot say. */
function identity(pid: number): { pgrp: number; token: string } | undefined {
  if (process.platform === 'linux') {
    try { return procIdentity(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return undefined; }
  }
  if (process.platform !== 'darwin') return undefined;
  const ps = spawnSync('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: psEnv() });
  const match = ps.status === 0 ? /^\s*(\d+)\s+(.+?)\s*$/.exec(ps.stdout) : null;
  return match ? { pgrp: Number(match[1]), token: match[2]! } : undefined;
}

/** The process group a live process is in, for destroy's evidence that a recorded group is ours. */
export function processGroupOf(pid: number): number | undefined {
  return identity(pid)?.pgrp;
}

/** Every live process in group `pgid`, by incarnation. Empty when the platform cannot enumerate. */
function groupMembers(pgid: number): Member[] {
  if (process.platform === 'linux') {
    let names: string[];
    try { names = readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return []; }
    return names.flatMap((name) => {
      const id = identity(Number(name));
      return id?.pgrp === pgid ? [{ pid: Number(name), token: id.token }] : [];
    });
  }
  if (process.platform !== 'darwin') return [];
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', timeout: 2_000, env: psEnv() });
  if (ps.status !== 0) return [];
  return ps.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match && Number(match[2]) === pgid ? [{ pid: Number(match[1]), token: match[3]! }] : [];
  });
}

/** An exited leader's entry that no longer names our group: none of the members recorded at its
 * exit is still the same process in the group. */
function stale(pgid: number, leader: Leader): boolean {
  if (!exited(leader.child)) return false;
  return !(leader.members ?? []).some((member) => {
    const id = identity(member.pid);
    return id?.pgrp === pgid && id.token === member.token;
  });
}

function drop(pgid: number, leader: Leader): void {
  if (leaders.get(pgid) === leader) leaders.delete(pgid);
}

function prune(): void {
  for (const [pgid, leader] of leaders) if (stale(pgid, leader)) drop(pgid, leader);
}

/** How often a group that got SIGTERM is checked for members left. */
const GROUP_POLL_MS = 50;

/** The follow-up SIGKILL for a group that got SIGTERM, while it is still ours. The timer is
 * referenced so a host with nothing else to do (a headless `cez run`) stays up to send it, and it
 * stops as soon as the group is empty, so that host exits as soon as the group is gone
 * (hearsay-tools/cezarion#1286). Each check is one `kill(-pgid, 0)`; only the SIGKILL reads the
 * members, which on darwin spawns `ps` once each. */
function scheduleKill(pgid: number, leader: Leader, signalledAt: number): void {
  const deadline = signalledAt + KILL_GRACE_MS;
  const check = (): void => {
    if (leaders.get(pgid) !== leader) return;
    if (!processGroupAlive(pgid)) { drop(pgid, leader); return; }
    const left = deadline - Date.now();
    if (left > 0) setTimeout(check, Math.min(GROUP_POLL_MS, left));
    else if (!stale(pgid, leader)) signalProcessGroup(pgid, 'SIGKILL');
  };
  setTimeout(check, Math.max(0, Math.min(GROUP_POLL_MS, deadline - Date.now())));
}

/**
 * Reap an exited leader’s group only while a recorded member still matches. Rescan before
 * SIGTERM. If all recorded members disappeared first, retain unprovable descendants rather than
 * signal a reused group.
 */
function reap(pgid: number, leader: Leader): void {
  if (leaders.get(pgid) !== leader || leader.signalledAt !== undefined) return;
  const recorded = leader.members ?? [];
  const members = groupMembers(pgid);
  if (!members.some(m => recorded.some(r => r.pid === m.pid && r.token === m.token))) { drop(pgid, leader); return; }
  leader.members = members;
  leader.signalledAt = Date.now();
  signalProcessGroup(pgid, 'SIGTERM');
  scheduleKill(pgid, leader, leader.signalledAt);
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
  spawned.add(child);
  const pid = child.pid;
  if (!grouped || !(child instanceof ChildProcess) || pid === undefined || !groupId(pid)) return child;
  prune();
  const leader: Leader = { child };
  leaders.set(pid, leader);
  // Runners clear their own SIGKILL timers when the leader exits. A member that ignored the
  // SIGTERM cezar sent outlives it, so the follow-up SIGKILL for the group lives here. A leader
  // cezar never signalled is reaped after the exit drain, so a descendant's final crash
  // diagnostic still lands first (harness row S19). The drain is referenced, and bounded by
  // EXIT_DRAIN_CAP_MS, so a host with nothing else to do stays up to reap.
  child.once('exit', (code) => {
    if (leaders.get(pid) !== leader) return;
    leader.members = processGroupAlive(pid) ? groupMembers(pid) : [];
    if (stale(pid, leader)) { drop(pid, leader); return; }
    if (leader.signalledAt === undefined) afterExitDrain(() => reap(pid, leader), exitDrainBudget(code), true);
    else scheduleKill(pid, leader, leader.signalledAt);
  });
  return child;
}

/** Signal a session: its whole group on POSIX, its tree on win32, else the leader alone. A
 * leader that already exited on its own is not group-signalled here: its exit scheduled the reap
 * of what it left behind (hearsay-tools/cezarion#1286). */
export function signalSession(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  const leader = pid === undefined ? undefined : leaders.get(pid);
  if (leader?.child === child && !leaderExited(child)) {
    leader.signalledAt ??= Date.now();
    signalProcessGroup(pid!, signal);
    return;
  }
  if (platform === 'win32' && pid !== undefined && spawned.has(child) && !exited(child)) {
    try {
      const taskkill = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      taskkill.on('error', () => { if (!exited(child)) child.kill(signal); });
      return;
    } catch { /* fall back to the leader alone */ }
  }
  child.kill(signal);
}

/** Signal what a leader that already exited left in its group, under the reap's guard: Cursor
 * print ends its group as each turn's leader exits, ahead of the exit drain. A SIGTERM is the reap
 * itself, sent at most once per group; a SIGKILL goes only to a group that is still ours. */
export function signalExitedSession(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  const leader = pid === undefined ? undefined : leaders.get(pid);
  if (leader?.child !== child || !exited(child)) return;
  if (signal === 'SIGTERM') reap(pid!, leader);
  else if (stale(pid!, leader)) drop(pid!, leader);
  else signalProcessGroup(pid!, 'SIGKILL');
}

/** The pgid of a registered, still-running grouped leader, for the worker process ledger. */
/** Whether `pid` leads a session this process spawned: an agent's own process, which a process
 *  wait refuses because it ends only with the session (hearsay-tools/cezarion#1446). */
export function isSessionLeader(pid: number): boolean {
  return leaders.has(pid);
}

export function sessionGroupOf(pid: number): number | undefined {
  const leader = leaders.get(pid);
  return leader && !exited(leader.child) ? pid : undefined;
}

/** cezar's own SIGINT/SIGTERM, passed to every agent group that still has members. */
export function forwardToSessionGroups(signal: NodeJS.Signals): void {
  for (const [pgid, leader] of [...leaders]) {
    if (stale(pgid, leader)) drop(pgid, leader);
    else if (processGroupAlive(pgid)) signalProcessGroup(pgid, signal);
  }
}
