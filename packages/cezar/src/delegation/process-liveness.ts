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

/** One process incarnation, so a reused PID never matches. Absent when the platform cannot say. */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') return procStat(pid)?.startToken;
  if (platform !== 'darwin') return undefined;
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  const token = ps.status === 0 ? ps.stdout.trim() : '';
  return token || undefined;
}

function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  // A zombie has exited; only its parent's wait remains.
  return process.platform !== 'linux' || procStat(pid)?.state !== 'Z';
}

/** Live and the same incarnation. A token-less entry (or an unreadable current token) counts while the PID exists. */
export function recordedProcessLive(entry: RecordedProcess): boolean {
  if (!pidExists(entry.pid)) return false;
  if (entry.startToken === undefined) return true;
  const current = processStartToken(entry.pid);
  return current === undefined || current === entry.startToken;
}

export function isCurrentProcess(entry: RecordedProcess): boolean {
  if (entry.pid !== process.pid) return false;
  const own = processStartToken(process.pid);
  return entry.startToken === undefined || own === undefined || entry.startToken === own;
}

/** PIDs (never this process) whose working directory is `dir` or beneath it; `unknown` when no scan can run. */
export function processesWithCwdUnder(dir: string, platform: NodeJS.Platform = process.platform): number[] | 'unknown' {
  let target: string;
  try { target = realpathSync(dir); } catch { target = resolve(dir); }
  const under = (cwd: string) => { const path = cwd.replace(/ \(deleted\)$/, ''); return path === target || path.startsWith(target + sep); };
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

/** A missing record (legacy) relies on the working-directory scan alone. */
export function probeGeneration({ record, worktreePath }: { record?: WorkerProcessRecord; worktreePath: string }): GenerationLiveness {
  if (record && !isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) return 'alive';
  if (record?.processes.some(recordedProcessLive)) return 'alive';
  const scan = processesWithCwdUnder(worktreePath);
  if (scan === 'unknown') return 'unknown';
  return scan.length ? 'alive' : 'gone';
}
