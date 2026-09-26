import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Synchronous, dependency-free proof that a crashed worker generation's processes are gone
 * (#469, spec 2026-09-26-worker-orphan-finalization). Sync so `continueRun` stays sync.
 * Every uncertainty answers "alive" or "unknown", never "gone".
 */
export type RecordedProcess = { pid: number; startToken?: string };
export type WorkerProcessRecord = { generation: string; controller: RecordedProcess; processes: RecordedProcess[] };
export type GenerationLiveness = 'gone' | 'alive' | 'unknown';

/** `/proc/<pid>/stat` field 22 (`starttime`); `comm` may hold spaces and `)`, so parse after the LAST `)`. */
export function parseProcStat(stat: string): { state: string; startToken: string } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return stat.includes(')') && fields.length >= 20 && /^\d+$/.test(fields[19]!) ? { state: fields[0]!, startToken: fields[19]! } : undefined;
}

function procStat(pid: number) {
  try { return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return undefined; }
}

let bootId: string | null | undefined;
/** `starttime` counts ticks since boot, so it repeats across reboots; the boot id scopes it. */
function linuxBootId(): string | undefined {
  if (bootId === undefined) { try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { bootId = null; } }
  return bootId ?? undefined;
}

/** One process incarnation, so a reused PID never matches. Absent when the platform cannot say. */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') {
    const start = procStat(pid)?.startToken; const boot = linuxBootId();
    return start && boot ? `${boot}:${start}` : start;
  }
  if (platform !== 'darwin') return undefined;
  // `lstart` is locale- and zone-formatted; pin both so the token is stable across cezar processes.
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const token = ps.status === 0 ? ps.stdout.trim() : '';
  return token || undefined;
}

function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  // A zombie has exited; only its parent's wait remains.
  return process.platform !== 'linux' || procStat(pid)?.state !== 'Z';
}

const LINUX_TOKEN = /^(?:[0-9a-f-]{36}:)?(\d+)$/;
/** Liveness-only comparison: when exactly one Linux token lacks the boot id (it was unreadable on one
 * side), the `starttime` suffix decides. Reaping still requires an exact match. */
function sameIncarnation(recorded: string, current: string): boolean {
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

export function isCurrentProcess(entry: RecordedProcess): boolean {
  if (entry.pid !== process.pid) return false;
  const own = processStartToken(process.pid);
  return entry.startToken === undefined || own === undefined || sameIncarnation(entry.startToken, own);
}

/** PIDs (never this process) whose working directory is one of `dirs` or beneath it, in one scan
 * pass; `unknown` when no scan can run. cezar's own short-lived git children in a worktree make
 * this read "alive" briefly: conservative, and a retry self-heals. */
export function processesWithCwdUnder(dirs: string | readonly string[], platform: NodeJS.Platform = process.platform): number[] | 'unknown' {
  const targets = (typeof dirs === 'string' ? [dirs] : dirs).map(dir => { try { return realpathSync(dir); } catch { return resolve(dir); } });
  const under = (cwd: string) => { const path = cwd.replace(/ \(deleted\)$/, ''); return targets.some(target => path === target || path.startsWith(target + sep)); };
  const found: number[] = [];
  if (platform === 'linux') {
    let entries: string[];
    try { entries = readdirSync('/proc'); } catch { return 'unknown'; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { if (under(readlinkSync(`/proc/${entry}/cwd`))) found.push(Number(entry)); } catch { /* ENOENT/EACCES: skip the entry */ }
    }
    return found;
  }
  if (platform !== 'darwin') return 'unknown';
  const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  // lsof exits 1 when some processes are unreadable; no output at all is not a proof.
  if (lsof.error || (lsof.status !== 0 && lsof.status !== 1) || !lsof.stdout) return 'unknown';
  let pid: number | undefined;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && pid !== process.pid && under(line.slice(1))) found.push(pid);
  }
  return [...new Set(found)];
}

export type GenerationProbe = { liveness: GenerationLiveness; controller?: number; pids: number[] };

/** A missing record (legacy) relies on the working-directory scan alone. `paths` are the
 * worktree and every scratch location, which finalization deletes. A live foreign controller
 * short-circuits the scan; otherwise `pids` names every live recorded or scanned process. */
export function inspectGeneration({ record, paths }: { record?: WorkerProcessRecord; paths: readonly string[] }): GenerationProbe {
  if (record && !isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) return { liveness: 'alive', controller: record.controller.pid, pids: [] };
  const recorded = record?.processes.filter(recordedProcessLive).map(entry => entry.pid) ?? [];
  const scan = processesWithCwdUnder(paths);
  const pids = [...new Set([...recorded, ...(scan === 'unknown' ? [] : scan)])];
  return { liveness: pids.length ? 'alive' : scan === 'unknown' ? 'unknown' : 'gone', pids };
}

export function probeGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[] }): GenerationLiveness {
  return inspectGeneration(input).liveness;
}
