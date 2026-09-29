import { execFile } from 'node:child_process';
import { z } from 'zod';

const processSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(), token: z.string().regex(/^\d*$/) });
type Process = z.infer<typeof processSchema>;
const snapshotScript = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; token=$(if ($_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { '' })} }); ConvertTo-Json -Compress -InputObject $rows`;

/** Bounded async probes: never block another run's shutdown timers. */
function powershell(script: string): Promise<string | undefined> {
  return new Promise(done => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => done(error ? undefined : stdout));
  });
}
async function snapshot(): Promise<Process[] | undefined> {
  const output = await powershell(snapshotScript);
  if (output === undefined) return undefined;
  try { return z.array(processSchema).parse(JSON.parse(output.replace(/^\uFEFF/, ''))); }
  catch { return undefined; }
}

/**
 * Windows retains ParentProcessId when a parent exits. Remember observed ancestry
 * and CreationDate incarnations so children outlive their leader without being
 * mistaken for a reused PID. As with POSIX cwd discovery this is observation,
 * not kernel containment: an unobserved intermediate that exits between scans
 * can hide its descendants. Git's automatic background maintenance is disabled.
 */
export async function watchWindowsAutosave() {
  const baseline = await snapshot();
  if (!baseline) return undefined;
  const before = new Map(baseline.map(entry => [entry.pid, entry.token]));
  const key = (entry: Process) => `${entry.pid}:${entry.token}`;
  const owned = new Map<string, Process & { signalable: boolean }>();
  let leaderObserved = false;
  let stopping: boolean | undefined;
  const signalling = new Set<boolean>();
  let latest: Process[] = [];
  let rootExitTicks: bigint | undefined;
  const ticksNow = () => (BigInt(Date.now()) + 62135596800000n) * 10000n;
  const signal = async () => {
    if (stopping === undefined || signalling.has(stopping)) return;
    const force = stopping;
    const targets = latest.filter(entry => entry.token && owned.get(key(entry))?.signalable);
    if (!targets.length) return;
    signalling.add(force);
    // Pin the Process handle before reading its creation time or acting. CIM
    // dates have microsecond precision; FILETIME adds one 100ns digit.
    // Never signal a PID whose incarnation the snapshot could not identify.
    const script = targets.map(entry => `$p=Get-Process -Id ${entry.pid} -ErrorAction SilentlyContinue; if ($p) { try { [void]$p.Handle; $birth=[string]$p.StartTime.ToUniversalTime().Ticks; if ($birth.Substring(0,$birth.Length-1) -eq '${entry.token.slice(0, -1)}') { ${force ? '$p.Kill()' : '[void]$p.CloseMainWindow()'} } } catch {} finally { $p.Dispose() } }`).join(';');
    try { await powershell(script); } finally { signalling.delete(force); }
  };
  return {
    stop(force: boolean) { stopping = force || stopping === true; void signal(); },
    async alive(root: number, hasExited: () => boolean): Promise<boolean> {
      if (hasExited()) rootExitTicks ??= ticksNow();
      const entries = await snapshot();
      if (!entries) return true;
      const exited = hasExited();
      if (exited) rootExitTicks ??= ticksNow();
      latest = entries;
      const current = new Map(entries.map(entry => [entry.pid, entry]));
      const leader = current.get(root);
      // The leader can exit while CIM is taking its snapshot. Without an
      // observed incarnation this row might already be a reused PID. Retry
      // without claiming ownership or signalling that process.
      if (exited && leader && !leaderObserved) { latest = []; return true; }
      if (!exited && leader && !leaderObserved) { owned.set(key(leader), { ...leader, signalable: true }); leaderObserved = true; }
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of entries) {
          if (owned.has(key(entry)) || (entry.token && before.get(entry.pid) === entry.token)) continue;
          const parents = [...owned.values()].filter(parent => parent.pid === entry.parent);
          if (entry.parent !== root && !parents.length) continue;
          if (entry.parent === root && exited && entry.token && BigInt(entry.token) > rootExitTicks!) continue;
          const replacement = current.get(entry.parent);
          // Parent IDs persist after exit. Birth order separates old ancestry
          // from a later process that reused the same ID.
          if (parents.length && !parents.some(parent => {
            if (parent.token && entry.token && BigInt(entry.token) < BigInt(parent.token)) return false;
            return !replacement || replacement.token === parent.token ||
              (!!entry.token && !!replacement.token && BigInt(entry.token) < BigInt(replacement.token));
          })) continue;
          // Unproven ancestry may hold the guard, but never authorizes a kill.
          // In particular, an already-exited, never-observed root PID could
          // have been reused by an unrelated intermediate between snapshots.
          const signalable = (entry.parent !== root || !exited) && parents.some(parent =>
            parent.signalable && !!parent.token && !!entry.token && BigInt(parent.token) <= BigInt(entry.token) &&
            current.get(parent.pid)?.token === parent.token);
          owned.set(key(entry), { ...entry, signalable }); changed = true;
        }
      }
      void signal();
      return !exited || entries.some(entry => owned.has(key(entry)) ||
        [...owned.values()].some(recorded => recorded.pid === entry.pid && (!recorded.token || !entry.token)));
    },
  };
}
