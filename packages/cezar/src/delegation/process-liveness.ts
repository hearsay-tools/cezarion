import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Synchronous, dependency-free proof that a crashed worker generation's processes are gone
 * (#469, spec 2026-09-26-worker-orphan-finalization). Sync so `continueRun` stays sync.
 * Every uncertainty answers "alive" or "unknown", never "gone".
 */
export type RecordedProcess = { pid: number; startToken?: string };
export type WorkerProcessRecord = { generation: string; controller: RecordedProcess; processes: RecordedProcess[] };
export type GenerationLiveness = 'gone' | 'alive' | 'unknown';

/** `/proc/<pid>/stat` fields 4 (`ppid`) and 22 (`starttime`); `comm` may hold spaces and `)`, so parse after the LAST `)`. */
export function parseProcStat(stat: string): { state: string; ppid: number; startToken: string } | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return stat.includes(')') && fields.length >= 20 && /^\d+$/.test(fields[1]!) && /^\d+$/.test(fields[19]!)
    ? { state: fields[0]!, ppid: Number(fields[1]), startToken: fields[19]! } : undefined;
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
export type ProcReader = {
  readdir: () => string[]; readlink: (pid: string) => string;
  ownerUid: (pid: string) => number | undefined; startedAtMs: (pid: string) => number | undefined;
  /** `/proc/<pid>/stat` field 4. World-readable, so it is known for the non-dumpable processes
   *  whose cwd is not; absent in a reader, the foreign-ancestor rule below never fires. */
  parentPid?: (pid: string) => number | undefined;
};
let clockTicks: number | undefined;
let bootTimeMs: number | undefined;
/** Wall-clock start of a process: boot time (`/proc/stat` btime) plus its starttime ticks. */
function procStartedAtMs(pid: string): number | undefined {
  try {
    bootTimeMs ??= Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]) * 1000;
    clockTicks ??= Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2_000 }).stdout.trim()) || 100;
    const start = procStat(Number(pid))?.startToken;
    return start === undefined || !Number.isFinite(bootTimeMs) ? undefined : bootTimeMs + Number(start) / clockTicks * 1000;
  } catch { return undefined; }
}
/** The darwin scan: `lsof` for working directories, `ps -A` for the process table of every user
 *  (ours are the candidates; the rest let a parent chain be followed). */
export type DarwinProcess = { pid: number; ppid?: number; uid?: number; startedAtMs?: number };
export type DarwinReader = { lsof: () => { ok: boolean; stdout: string }; processes: () => DarwinProcess[] | undefined };
const realDarwin: DarwinReader = {
  lsof: () => {
    const lsof = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    // Status 1 is ordinary (some process unreadable); completeness is judged against `ps` instead.
    return { ok: !lsof.error && (lsof.status === 0 || lsof.status === 1) && !!lsof.stdout, stdout: lsof.stdout ?? '' };
  },
  processes: () => {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,uid=,stat=,lstart='], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    if (ps.error || ps.status !== 0 || !ps.stdout) return undefined;
    return ps.stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      // `ps` lists itself, and lsof (which ran first) never saw it.
      // Zombies have exited and cannot retain a cwd, even before their parent
      // gets another event-loop turn to reap them. Other states stay conservative.
      if (!match || Number(match[1]) === ps.pid || match[4]!.startsWith('Z')) return [];
      const startedAtMs = Date.parse(`${match[5]} UTC`);
      return [{ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}) }];
    });
  },
};

type Ancestry = { parentPid: (pid: number) => number | undefined; ownerUid: (pid: number) => number | undefined };
const ANCESTRY_HOPS = 64;
/** A process our user cannot have started: its parent chain reaches another user's process before
 *  init or this cezar. Every SSH login looks like this (`sshd`'s privilege-separated monitor is
 *  root's, the user half under it is non-dumpable, `sftp-server` hangs off that), and so do cron,
 *  `su` and `login`; nothing an unprivileged worker spawns can, because it cannot forge a foreign
 *  parent. The walk is no evidence when it ends at init (an orphan reparents there or to a
 *  same-user subreaper such as `systemd --user`), at this process (then the process IS ours), at
 *  an unknown parent or owner, or when the parent changes between reads (PID reuse).
 *  (hearsay-tools/cezarion#874) */
function launchedByAnotherUser(pid: number, uid: number, tree: Ancestry): boolean {
  let current = pid;
  for (let hop = 0; hop < ANCESTRY_HOPS; hop++) {
    const parent = tree.parentPid(current);
    if (parent === undefined || parent <= 1 || parent === process.pid) return false;
    const owner = tree.ownerUid(parent);
    if (owner === undefined || tree.parentPid(current) !== parent) return false;
    if (owner !== uid) return true;
    current = parent;
  }
  return false;
}

const realProc: ProcReader = {
  readdir: () => readdirSync('/proc'),
  readlink: pid => readlinkSync(`/proc/${pid}/cwd`),
  ownerUid: pid => { try { return statSync(`/proc/${pid}`).uid; } catch { return undefined; } },
  startedAtMs: procStartedAtMs,
  parentPid: pid => procStat(Number(pid))?.ppid,
};

/** PIDs (never this process) whose working directory is one of `dirs` or beneath it, in one scan
 * pass; `unknown` when no scan can run. cezar's own short-lived git children in a worktree make
 * this read "alive" briefly: conservative, and a retry self-heals. `since` (epoch ms) is the
 * earliest moment the worker's processes can have started; see the EACCES rule below.
 * Resource proof supplies it only for deletion (`holdersSince`): reboot cannot exclude holders. */
export function processesWithCwdUnder(dirs: string | readonly string[], platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc, since?: number, darwin: DarwinReader = realDarwin): number[] | 'unknown' {
  const scan = scanCwd(dirs, platform, proc, since, darwin);
  return scan === 'unknown' ? scan : [...new Set(scan.all)];
}

type CwdScan = { pids: number[]; candidates: number[]; all: number[]; uncertain: boolean };

/** Keep confirmed cwd matches separate from permission-denied candidates. Only the resource
 * API above combines them: an unreadable cwd is no evidence of execution membership (hearsay-tools/cezarion#839). */
function scanCwd(dirs: string | readonly string[], platform: NodeJS.Platform, proc: ProcReader, since: number | undefined, darwin: DarwinReader): CwdScan | 'unknown' {
  const targets = (typeof dirs === 'string' ? [dirs] : dirs).map(dir => { try { return realpathSync(dir); } catch { return resolve(dir); } });
  const under = (cwd: string) => { const path = cwd.replace(/ \(deleted\)$/, ''); return targets.some(target => path === target || path.startsWith(target + sep)); };
  const found: number[] = []; const candidates: number[] = []; const all: number[] = []; let uncertain = false;
  if (platform === 'linux') {
    let entries: string[];
    try { entries = proc.readdir(); } catch { return 'unknown'; }
    const uid = process.getuid?.();
    const ancestry: Ancestry | undefined = proc.parentPid && { parentPid: pid => proc.parentPid!(String(pid)), ownerUid: pid => proc.ownerUid(String(pid)) };
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { if (under(proc.readlink(entry))) { found.push(Number(entry)); all.push(Number(entry)); } }
      catch (error) {
        // A vanished process is gone; another user's is unreadable by design and skipped. Our own
        // user's non-dumpable processes are unreadable too (systemd --user, sshd, gpg-agent, which
        // every host has), so they cannot all block the proof: one that started before the worker
        // existed cannot be its descendant, and neither can one another user launched (a new SSH,
        // ansible or sftp login after the worker: `launchedByAnotherUser`), which would otherwise
        // block destroy of every leftover worktree. A later one of ours is a possible holder, never signalled.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        const owner = proc.ownerUid(entry);
        if (uid !== undefined && owner !== undefined && owner !== uid) continue;
        if ((code === 'EACCES' || code === 'EPERM') && uid !== undefined && owner === uid && ancestry && launchedByAnotherUser(Number(entry), uid, ancestry)) continue;
        const started = since === undefined ? undefined : proc.startedAtMs(entry);
        if (started === undefined || started >= since!) {
          candidates.push(Number(entry)); all.push(Number(entry));
          if (owner === undefined || uid === undefined || started === undefined ||
            !['EACCES', 'EPERM'].includes(code ?? '')) uncertain = true;
        }
      }
    }
    return { pids: found, candidates, all, uncertain };
  }
  if (platform !== 'darwin') return 'unknown';
  const lsof = darwin.lsof();
  if (!lsof.ok) return 'unknown';
  const seen = new Set<number>();
  let pid: number | undefined;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); seen.add(pid); }
    else if (line.startsWith('n') && pid !== undefined && pid !== process.pid && under(line.slice(1))) { found.push(pid); all.push(pid); }
  }
  // lsof silently omits what it cannot read. An own-user process it omitted is judged by the
  // Linux EACCES rules: a possible holder unless it predates the worker or another user launched
  // it (its parent chain, followed through the same table). Other users' are skipped.
  const table = darwin.processes();
  if (!table) return 'unknown';
  const uid = process.getuid?.();
  const byPid = new Map(table.map(row => [row.pid, row]));
  const tree: Ancestry = { parentPid: pid => byPid.get(pid)?.ppid, ownerUid: pid => byPid.get(pid)?.uid };
  for (const entry of table) {
    if (seen.has(entry.pid) || entry.pid === process.pid) continue;
    if (uid !== undefined && entry.uid !== undefined && entry.uid !== uid) continue;
    if (uid !== undefined && entry.uid === uid && launchedByAnotherUser(entry.pid, uid, tree)) continue;
    if (since === undefined || entry.startedAtMs === undefined || entry.startedAtMs >= since) { candidates.push(entry.pid); all.push(entry.pid); }
  }
  return { pids: [...new Set(found)], candidates, all, uncertain };
}

export type GenerationProbe = { liveness: GenerationLiveness; controller?: number; pids: number[];
  /** Execution may be abandoned, never declared gone. Resource proof remains independent. */
  abandonable?: true;
  candidates?: number[]; // cwd unreadable; never evidence of worker membership
};

/** A missing record (legacy) relies on the working-directory scan alone. `paths` are the
 * worktree and every scratch location. Execution settlement itself deletes nothing. A live foreign controller
 * short-circuits the scan; otherwise `pids` names every live recorded or scanned process. */
function inspect({ record, paths, since }: { record?: WorkerProcessRecord; paths: readonly string[]; since?: number }): GenerationProbe {
  if (record && !isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) return { liveness: 'alive', controller: record.controller.pid, pids: [] };
  const recorded = record?.processes.filter(recordedProcessLive).map(entry => entry.pid) ?? [];
  const scan = scanCwd(paths, process.platform, realProc, since, realDarwin);
  const pids = [...new Set([...recorded, ...(scan === 'unknown' ? [] : scan.all)])];
  const candidates = scan === 'unknown' ? [] : scan.candidates.filter(pid => !recorded.includes(pid));
  return { liveness: pids.length ? 'alive' : scan === 'unknown' ? 'unknown' : 'gone', pids,
    ...(candidates.length ? { candidates } : {}) };
}

export function probeGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[]; since?: number }): GenerationLiveness {
  return inspectGeneration(input).liveness;
}

/** Earliest start of any process a worker can own: its record's creation, less 1 s of slack
 * for whole-second btime plus tick rounding. `undefined` when the timestamp does not parse. */
export function workerProcessCutoff(createdAt: string): number | undefined {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? created - 1_000 : undefined;
}

/** Fresh resource proof. Controller boot says nothing about who holds persistent paths, so
 * every unreadable own-user cwd remains a candidate, even when it predates this task, unless
 * the caller deletes and passes `holdersSince` (`workerProcessCutoff`). Then an unreadable process
 * that predates the worker is ambient (login `sshd`, `systemd --user`, `gpg-agent`) and is
 * skipped, as execution proof skips it (hearsay-tools/cezarion#858). Readable cwds under `paths`, live
 * recorded processes and later unreadable ones still block, except an unreadable process another
 * user launched (`launchedByAnotherUser`, hearsay-tools/cezarion#874). `since` is ignored here. */
export function inspectGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[]; since?: number; holdersSince?: number }): GenerationProbe {
  return inspect({ ...input, since: input.holdersSince });
}

/** Execution-only proof: a known reboot ended all old descendants, provided neither the
 * controller nor any recorded process is still live. Never use this to authorize reuse/deletion.
 * Legacy or unknown boot evidence retains the conservative descendant scan. */
export function inspectExecutionGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[]; pathsComplete?: boolean; since?: number }): GenerationProbe {
  const record = input.record;
  if (record && recordedProcessLive(record.controller)) return { liveness: 'alive', controller: record.controller.pid, pids: [] };
  const pids = record?.processes.filter(recordedProcessLive).map(entry => entry.pid) ?? [];
  if (pids.length) return { liveness: 'alive', pids };
  if (process.platform === 'linux' && controllerPredatesBoot(record?.controller.startToken, linuxBootId())) return { liveness: 'gone', pids: [] };
  // Same-boot crash: a valid ledger can exclude its recorded incarnations, but cannot prove
  // an unreadable ambient process is (or is not) a detached descendant. Abandon the execution
  // honestly instead of inventing either membership or exit. Never authorize reuse/deletion.
  const boot = process.platform === 'linux' ? linuxBootId() : undefined;
  const sameBootLedger = boot !== undefined && LINUX_BOOT_ID.test(boot) && record !== undefined &&
    [record.controller, ...record.processes].every(entry => entry.startToken !== undefined &&
      entry.startToken.startsWith(`${boot}:`) && /^\d+$/.test(entry.startToken.slice(boot.length + 1)));
  if (sameBootLedger && input.pathsComplete === true && input.since !== undefined) {
    const scan = scanCwd(input.paths, process.platform, realProc, input.since, realDarwin);
    if (scan !== 'unknown' && !scan.uncertain && scan.pids.length === 0 && scan.candidates.length > 0) {
      return { liveness: 'unknown', pids: [], abandonable: true };
    }
  }
  const probe = inspect(input);
  // Unknown scratch locations can hide a legacy descendant even when every known path is
  // clear. Keep live PID diagnostics, but never turn a partial scan into proof of termination.
  return probe.liveness === 'gone' && input.pathsComplete === false ? { liveness: 'unknown', pids: [] } : probe;
}
