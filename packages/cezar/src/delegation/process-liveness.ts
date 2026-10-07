import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Synchronous, dependency-free proof that a crashed worker generation's processes are gone
 * (#469, spec 2026-09-26-worker-orphan-finalization). Sync so `continueRun` stays sync.
 * An unreadable cwd is no evidence (hearsay-tools/cezarion#889); every other uncertainty answers
 * "alive" or "unknown", never "gone".
 */
export type RecordedProcess = { pid: number; startToken?: string };
export type WorkerProcessRecord = { generation: string; controller: RecordedProcess; processes: RecordedProcess[] };
export type GenerationLiveness = 'gone' | 'alive' | 'unknown';

/** `/proc/<pid>/stat` field 22 (`starttime`); `comm` may hold spaces and `)`, so parse after the LAST `)`. */
export function parseProcStat(stat: string): { state: string; startToken: string } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return stat.includes(')') && fields.length >= 20 && /^\d+$/.test(fields[19]!)
    ? { state: fields[0]!, startToken: fields[19]! } : undefined;
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
const LINUX_BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** A known different boot proves that no descendant of this controller can still exist. */
function controllerPredatesBoot(token: string | undefined, boot: string | undefined): boolean {
  const recordedBoot = token?.match(/^(.+):\d+$/)?.[1];
  return recordedBoot !== undefined && boot !== undefined && LINUX_BOOT_ID.test(recordedBoot) && LINUX_BOOT_ID.test(boot) && recordedBoot !== boot;
}
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

/** The `/proc` reads the Linux scan makes; injectable for platform/error boundary coverage. */
export type ProcReader = { readdir: () => string[]; readlink: (pid: string) => string };
/** The darwin scan: `lsof` for working directories. */
export type DarwinReader = { lsof: () => { ok: boolean; stdout: string } };
const realDarwin: DarwinReader = {
  lsof: () => {
    const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    // Status 1 is ordinary: some process was unreadable, and an unreadable cwd is no evidence.
    return { ok: !lsof.error && (lsof.status === 0 || lsof.status === 1) && !!lsof.stdout, stdout: lsof.stdout ?? '' };
  },
};

const realProc: ProcReader = {
  readdir: () => readdirSync('/proc'),
  readlink: pid => readlinkSync(`/proc/${pid}/cwd`),
};

/** PIDs (never this process) whose readable working directory is one of `dirs` or beneath it,
 * in one scan pass; `unknown` when the processes cannot be listed at all. cezar's own short-lived
 * git children in a worktree make this read "alive" briefly: conservative, and a retry self-heals.
 * An unreadable cwd is no evidence (hearsay-tools/cezarion#889): a process that vanished, another
 * user's, or a non-dumpable one of ours (login `sshd`, `systemd --user`, `gpg-agent`, which every
 * host has) is skipped, as `lsof` skips what it cannot read. win32 has no cwd scan and answers
 * none: Windows refuses to delete a directory a process holds, so the checked removal is the
 * proof there, beside the recorded processes. */
export function processesWithCwdUnder(dirs: string | readonly string[], platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc, darwin: DarwinReader = realDarwin): number[] | 'unknown' {
  if (platform === 'win32') return [];
  const targets = (typeof dirs === 'string' ? [dirs] : dirs).map(dir => { try { return realpathSync(dir); } catch { return resolve(dir); } });
  const under = (cwd: string) => { const path = cwd.replace(/ \(deleted\)$/, ''); return targets.some(target => path === target || path.startsWith(target + sep)); };
  const found = new Set<number>();
  if (platform === 'linux') {
    let entries: string[];
    try { entries = proc.readdir(); } catch { return 'unknown'; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { if (under(proc.readlink(entry))) found.add(Number(entry)); } catch { /* unreadable: no evidence */ }
    }
    return [...found];
  }
  if (platform !== 'darwin') return 'unknown';
  const lsof = darwin.lsof();
  if (!lsof.ok) return 'unknown';
  let pid: number | undefined;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && pid !== process.pid && under(line.slice(1))) found.add(pid);
  }
  return [...found];
}

export type GenerationProbe = { liveness: GenerationLiveness; controller?: number; pids: number[] };

/** Fresh resource proof for destroy, reuse, admission, scratch cleanup and history deletion.
 * Controller boot says nothing about who holds persistent paths, so it always scans. A process
 * blocks only when its readable cwd is under `paths`, when it is a live recorded process of the
 * generation, or when it is a live foreign controller (hearsay-tools/cezarion#889). `paths` are
 * the worktree and every scratch location; a missing record (legacy) relies on the scan alone.
 * A live foreign controller short-circuits the scan; otherwise `pids` names every holder. */
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

/** Execution-only proof: a known reboot ended all old descendants, provided neither the
 * controller nor any recorded process is still live. Never use this to authorize reuse/deletion;
 * execution settlement itself deletes nothing. Legacy or unknown boot evidence keeps the descendant scan. */
export function inspectExecutionGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[]; pathsComplete?: boolean }): GenerationProbe {
  const record = input.record;
  if (record && recordedProcessLive(record.controller)) return { liveness: 'alive', controller: record.controller.pid, pids: [] };
  const pids = record?.processes.filter(recordedProcessLive).map(entry => entry.pid) ?? [];
  if (pids.length) return { liveness: 'alive', pids };
  if (process.platform === 'linux' && controllerPredatesBoot(record?.controller.startToken, linuxBootId())) return { liveness: 'gone', pids: [] };
  const probe = inspectGeneration(input);
  // Unknown scratch locations can hide a legacy descendant even when every known path is
  // clear. Keep live PID diagnostics, but never turn a partial scan into proof of termination.
  return probe.liveness === 'gone' && input.pathsComplete === false ? { liveness: 'unknown', pids: [] } : probe;
}
