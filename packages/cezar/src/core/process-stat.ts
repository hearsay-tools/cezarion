import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Windows PowerShell 5.1, the one PowerShell every supported Windows host has. */
export const POWERSHELL = 'powershell.exe';

/**
 * The environment for a Windows PowerShell 5.1 child. PowerShell 7 exports its own `PSModulePath`,
 * and a 5.1 child that inherits it finds PowerShell 7's built-in modules first, so autoloading
 * cmdlets such as `Set-Acl` or `Get-CimInstance` fails. Without the variable, 5.1 builds its
 * default module path. Windows environment names ignore case, so every spelling goes.
 */
export function powershellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
}

/** The fields after `comm` in a `/proc/<pid>/stat` line; `comm` may hold spaces and `)`, so the split is after the LAST `)`. */
export function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
}

/** Whether the `/proc/<pid>/stat` fields are of an exited process. A leader whose main thread
 *  exited reads Z while its other threads run and keep its files open, a listening port among them,
 *  so it is exited only once `num_threads` (field 20) counts no thread but its own. */
export function exitedStat(fields: readonly string[]): boolean {
  return /^[ZX]$/.test(fields[0] ?? '') && Number(fields[17]) <= 1;
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


/** `pgid`: the session leader leads its own process group (hearsay-tools/cezarion#890). */
export type RecordedProcess = { pid: number; startToken?: string | undefined; pgid?: number | undefined };

export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  if (process.platform !== 'linux') return true;
  // A zombie leader can still have live threads. Unreadable stat is not proof of exit.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !exitedStat(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/));
  } catch { return true; }
}

const LINUX_TOKEN = /^(?:[0-9a-f-]{36}:)?(\d+)$/;
/** Liveness-only comparison: when exactly one Linux token lacks the boot id (it was unreadable on one
 * side), the `starttime` suffix decides. Reaping still requires an exact match. */
export function sameIncarnation(recorded: string, current: string): boolean {
  if (recorded === current) return true;
  const a = LINUX_TOKEN.exec(recorded), b = LINUX_TOKEN.exec(current);
  return !!a && !!b && recorded.includes(':') !== current.includes(':') && a[1] === b[1];
}

/** Live and the same incarnation. A token-less entry (or an unreadable current token) counts while the PID exists. */
export function recordedProcessLive(entry: RecordedProcess): boolean {
  if (!pidExists(entry.pid)) return false;
  if (entry.startToken === undefined) return true;
  const current = processStartToken(entry.pid);
  return current === undefined || sameIncarnation(entry.startToken, current);
}

