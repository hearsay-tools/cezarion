import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { processesWithCwdUnder, processStartToken, recordedProcessLive, type RecordedProcess } from './delegation/process-liveness.ts';

type Snapshot = Map<number, string | undefined> | 'unknown';

/** Darwin probes must not block the event loop (and other runs' kill timers). */
function inspect(command: string, args: string[], timeout: number) {
  return new Promise<{ ok: boolean; stdout: string; pid?: number }>(done => {
    const child = execFile(command, args, {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }, (error, stdout) => done({
      ok: !error || (command === 'lsof' && error.code === 1 && !error.killed),
      stdout, pid: child.pid,
    }));
  });
}

async function snapshot(cwd: string, since: number): Promise<Snapshot> {
  if (process.platform === 'linux') {
    const pids = processesWithCwdUnder(cwd, process.platform, undefined, since);
    return pids === 'unknown' ? pids : new Map(pids.map(pid => [pid, processStartToken(pid)]));
  }
  // No process-tree proof exists on other platforms. Refuse before spawning,
  // rather than start work whose shutdown could retain the guard forever.
  if (process.platform !== 'darwin') return 'unknown';
  const uid = process.getuid?.();
  if (uid === undefined) return 'unknown';
  const [lsof, ps] = await Promise.all([
    inspect('lsof', ['-a', '-u', String(uid), '-d', 'cwd', '-Fpn'], 5_000),
    inspect('ps', ['-U', String(uid), '-o', 'pid=,lstart='], 2_000),
  ]);
  if (!ps.ok || !lsof.ok || !lsof.stdout) return 'unknown';
  let root = resolve(cwd);
  try { root = realpathSync(cwd); } catch { /* Git will report an absent directory. */ }
  const seen = new Set<number>();
  const holders = new Set<number>();
  let pid: number | undefined;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); seen.add(pid); }
    else if (line.startsWith('n') && pid !== undefined) {
      const path = line.slice(1);
      if (path === root || path.startsWith(root + sep)) holders.add(pid);
    }
  }
  const result = new Map<number, string | undefined>();
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (id === process.pid || id === ps.pid || id === lsof.pid) continue;
    // As in orphan recovery, a missing cwd is uncertainty, not permission.
    // Record pre-existing uncertain holders in the baseline too.
    if (holders.has(id) || !seen.has(id)) result.set(id, match[2]);
  }
  // A holder born between the two snapshots may be absent from ps. Missing
  // identity is uncertainty, never grounds to drop the lsof observation.
  for (const id of holders) {
    if (id !== process.pid && id !== ps.pid && id !== lsof.pid && !result.has(id)) result.set(id, undefined);
  }
  return result;
}

async function live(entry: RecordedProcess): Promise<boolean> {
  if (process.platform !== 'darwin') return recordedProcessLive(entry);
  try { process.kill(entry.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  const ps = await inspect('ps', ['-o', 'stat=,lstart=', '-p', String(entry.pid)], 2_000);
  if (!ps.ok) return true;
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(ps.stdout);
  if (!match) return true;
  if (match[1]!.startsWith('Z')) return false;
  return entry.startToken === undefined || match[2] === entry.startToken;
}

/**
 * Conservative companion to owned-group proof, using orphan recovery's cwd
 * boundary. Never signal cwd-only matches: they may be unrelated agent tools.
 * Polling does not contain a custom child that detaches AND leaves the tree
 * before it can be observed; this is not an OS sandbox.
 */
export async function watchAutosaveHolders(cwd: string) {
  const since = Date.now();
  const baseline = await snapshot(cwd, since);
  if (baseline === 'unknown') return undefined;
  const observed = new Map<number, RecordedProcess>();
  return async () => {
    const current = await snapshot(cwd, since);
    if (current === 'unknown') return true;
    for (const [pid, startToken] of current) {
      if (startToken !== undefined && baseline.get(pid) === startToken) continue;
      const previous = observed.get(pid);
      if (!previous || (startToken !== undefined && previous.startToken !== startToken)) {
        observed.set(pid, { pid, startToken });
      }
    }
    // Once observed, a holder stays tracked even if it later changes cwd.
    const states = await Promise.all([...observed.values()].map(live));
    return states.some(Boolean);
  };
}
