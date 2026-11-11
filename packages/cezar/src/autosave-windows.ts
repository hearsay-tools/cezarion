import { POWERSHELL, powershellEnv } from './core/windows-powershell.ts';
import { execFile, execFileSync } from 'node:child_process';
import { z } from 'zod';

const processSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(), token: z.string().regex(/^\d*$/) });
type Process = z.infer<typeof processSchema>;
const snapshotScript = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; token=$(if ($_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { '' })} }); ConvertTo-Json -Compress -InputObject $rows`;

/** Bounded async probes: never block another run's shutdown timers. */
function powershell(script: string): Promise<string | undefined> {
  return new Promise(done => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: powershellEnv(), encoding: 'utf8', windowsHide: true, timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => done(error ? undefined : stdout));
  });
}
async function snapshot(): Promise<Process[] | undefined> {
  const output = await powershell(snapshotScript);
  if (output === undefined) return undefined;
  try { return z.array(processSchema).parse(JSON.parse(output.replace(/^\uFEFF/, ''))); }
  catch { return undefined; }
}

/** One bounded synchronous incarnation probe for durable admission after restart. */
function incarnation(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if (-not $p) { 'gone' } elseif ($p.CreationDate) { [string]$p.CreationDate.ToUniversalTime().Ticks }`;
  try {
    const token = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: powershellEnv(), encoding: 'utf8', windowsHide: true, timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }).trim();
    return token === 'gone' || /^\d+$/.test(token) ? token : undefined;
  } catch { return undefined; }
}
export function windowsAutosaveProcessToken(pid: number): string | undefined {
  const token = incarnation(pid);
  return token === 'gone' ? undefined : token;
}
export function windowsAutosaveProcessLive(entry: { pid: number; startToken?: string | undefined }): boolean {
  const token = incarnation(entry.pid);
  return token !== 'gone' && (token === undefined || entry.startToken === undefined || token === entry.startToken);
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
  let diagnostic = 'Windows process inspection pending';
  let rootExitTicks: bigint | undefined;
  const ticksNow = () => (BigInt(Date.now()) + 62135596800000n) * 10000n;
  // The leader can exit while CIM is taking its snapshot. Without an
  // observed incarnation this row might already be a reused PID. Retry
  // without claiming ownership or signalling that process.
  const observeLeader = (root: number, exited: boolean, leader: Process | undefined): boolean => {
    if (exited && leader && !leaderObserved) { latest = []; diagnostic = `Windows leader PID ${root} incarnation uncertain`; return false; }
    if (!exited && leader && !leaderObserved) { owned.set(key(leader), { ...leader, signalable: true }); leaderObserved = true; }
    return true;
  };
  /** Parent IDs persist after exit. Birth order separates old ancestry from a later process that reused the same ID. */
  const plausibleAncestor = (entry: Process, parents: (Process & { signalable: boolean })[], replacement: Process | undefined) =>
    parents.some(parent => {
      if (parent.token && entry.token && BigInt(entry.token) < BigInt(parent.token)) return false;
      return !replacement || replacement.token === parent.token ||
        (!!entry.token && !!replacement.token && BigInt(entry.token) < BigInt(replacement.token));
    });
  // Unproven ancestry may hold the guard, but never authorizes a kill.
  // In particular, an already-exited, never-observed root PID could
  // have been reused by an unrelated intermediate between snapshots.
  const maySignal = (entry: Process, parents: (Process & { signalable: boolean })[], current: Map<number, Process>, exited: boolean, root: number) =>
    (entry.parent !== root || !exited) && parents.some(parent =>
      parent.signalable && !!parent.token && !!entry.token && BigInt(parent.token) <= BigInt(entry.token) &&
      current.get(parent.pid)?.token === parent.token);
  const admitEntry = (entry: Process, current: Map<number, Process>, root: number, exited: boolean): boolean => {
    if (owned.has(key(entry)) || (entry.token && before.get(entry.pid) === entry.token)) return false;
    const parents = [...owned.values()].filter(parent => parent.pid === entry.parent);
    if (entry.parent !== root && !parents.length) return false;
    if (entry.parent === root && exited && entry.token && BigInt(entry.token) > rootExitTicks!) return false;
    const replacement = current.get(entry.parent);
    if (parents.length && !plausibleAncestor(entry, parents, replacement)) return false;
    owned.set(key(entry), { ...entry, signalable: maySignal(entry, parents, current, exited, root) });
    return true;
  };
  /** Fixed point: children admitted in one pass can make their own children admissible in the next. */
  const admitRetained = (entries: Process[], current: Map<number, Process>, root: number, exited: boolean) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        if (admitEntry(entry, current, root, exited)) changed = true;
      }
    }
  };
  const retainsGuard = (entries: Process[]) => entries.some(entry => owned.has(key(entry)) ||
    [...owned.values()].some(recorded => recorded.pid === entry.pid && (!recorded.token || !entry.token)));
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
    diagnostic: () => diagnostic,
    cleanupProof: () => ({
      processes: [...owned.values()].map(entry => ({ pid: entry.pid, ...(entry.token ? { startToken: entry.token } : {}) })),
      groups: [] as number[],
      // A crashed controller cannot reconstruct unobserved Windows ancestry.
      uncertain: /failed|uncertain|pending/.test(diagnostic),
    }),
    stop(force: boolean) { stopping = force || stopping === true; void signal(); },
    async alive(root: number, hasExited: () => boolean): Promise<boolean> {
      if (hasExited()) rootExitTicks ??= ticksNow();
      const entries = await snapshot();
      if (!entries) { diagnostic = 'Windows process inspection failed'; return true; }
      const exited = hasExited();
      if (exited) rootExitTicks ??= ticksNow();
      latest = entries;
      const current = new Map(entries.map(entry => [entry.pid, entry]));
      if (!observeLeader(root, exited, current.get(root))) return true;
      admitRetained(entries, current, root, exited);
      const pids = entries.filter(entry => owned.has(key(entry))).map(entry => entry.pid);
      diagnostic = `Windows retained autosave PIDs: ${pids.join(', ') || 'none'}${!exited ? '; leader termination uncertain' : ''}`;
      void signal();
      return !exited || retainsGuard(entries);
    },
  };
}
