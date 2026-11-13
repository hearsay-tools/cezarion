import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

import { linuxBootId, processStartToken, pidExists, sameIncarnation, recordedProcessLive, type RecordedProcess } from '../core/process-stat.ts';

/**
 * Synchronous process evidence for worker recovery and resource cleanup. Unreadable cwd is no
 * evidence; other uncertainty stays alive or unknown, never proven gone.
 */
export { parseProcStat, processStartToken, recordedProcessLive, type RecordedProcess } from '../core/process-stat.ts';
export type WorkerProcessRecord = { generation: string; controller: RecordedProcess; processes: RecordedProcess[] };
export type GenerationLiveness = 'gone' | 'alive' | 'unknown';

const LINUX_BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** A known different boot proves that no descendant of this controller can still exist. */
function controllerPredatesBoot(token: string | undefined, boot: string | undefined): boolean {
  const recordedBoot = token?.match(/^(.+):\d+$/)?.[1];
  return recordedBoot !== undefined && boot !== undefined && LINUX_BOOT_ID.test(recordedBoot) && LINUX_BOOT_ID.test(boot) && recordedBoot !== boot;
}
/** A different recorded Linux boot proves every original process group ended. */
export function processPredatesCurrentBoot(entry: RecordedProcess): boolean {
  return process.platform === 'linux' && controllerPredatesBoot(entry.startToken, linuxBootId());
}

/** Whether a recorded session leader's group may be signalled (hearsay-tools/cezarion#890). A live
 * leader must be the exact recorded incarnation; a different one means the group emptied and its
 * number was reused. A dead leader proves nothing: its number may since have been reused, and a
 * double-fork daemon leaves exactly a live group with a dead leader. Such a group is signalled
 * only when it holds the worker's paths: `holderGroups` are the groups of those holders. */
export function recordedGroupSignalable(entry: RecordedProcess, holderGroups: readonly number[] = []): boolean {
  if (entry.pgid === undefined || entry.pgid !== entry.pid) return false;
  if (pidExists(entry.pid)) return entry.startToken !== undefined && processStartToken(entry.pid) === entry.startToken;
  return holderGroups.includes(entry.pgid);
}

export function isCurrentProcess(entry: RecordedProcess): boolean {
  if (entry.pid !== process.pid) return false;
  const own = processStartToken(process.pid);
  return entry.startToken === undefined || own === undefined || sameIncarnation(entry.startToken, own);
}

/** The `/proc` reads the Linux scan makes; injectable for platform/error boundary coverage. */
export type ProcReader = { readdir: () => string[]; readlink: (pid: string) => string };
/** The darwin scan: `lsof` for working directories, of every process or of one. */
export type DarwinReader = { lsof: () => { ok: boolean; stdout: string }; lsofPid?: (pid: number) => { ok: boolean; stdout: string } };
const lsofCwd = (args: string[], timeout: number) => {
  const lsof = spawnSync('lsof', [...args, '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  // Status 1 is ordinary: some process was unreadable, and an unreadable cwd is no evidence.
  return { ok: !lsof.error && (lsof.status === 0 || lsof.status === 1) && !!lsof.stdout, stdout: lsof.stdout ?? '' };
};
const realDarwin: DarwinReader = {
  lsof: () => lsofCwd(['-a'], 5_000),
  lsofPid: pid => lsofCwd(['-a', '-p', String(pid)], 2_000),
};

const realProc: ProcReader = {
  readdir: () => readdirSync('/proc'),
  readlink: pid => readlinkSync(`/proc/${pid}/cwd`),
};

/** Each other process's readable working directory, by pid, or `unknown` when none can be listed. */
export type CwdSnapshot = ReadonlyMap<number, string> | 'unknown';
/** A snapshot taken on first use. Shared only inside one synchronous reprobe tick, never across
 * a yield; destroy, admission and history deletion scan fresh (hearsay-tools/cezarion#879). */
export type CwdSource = () => CwdSnapshot;

/** Every other process's readable working directory, in one scan pass; `unknown` when the
 * processes cannot be listed at all. An unreadable cwd is no evidence (hearsay-tools/cezarion#889):
 * a process that vanished, another user's, or a non-dumpable one of ours (login `sshd`,
 * `systemd --user`, `gpg-agent`, which every host has) is skipped, as `lsof` skips what it cannot
 * read. win32 has no cwd scan and answers none: Windows refuses to delete a directory a process
 * holds, so the checked removal is the proof there, beside the recorded processes. */
export function scanProcessCwds(platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc, darwin: DarwinReader = realDarwin): CwdSnapshot {
  const found = new Map<number, string>();
  if (platform === 'win32') return found;
  if (platform === 'linux') {
    let entries: string[];
    try { entries = proc.readdir(); } catch { return 'unknown'; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { found.set(Number(entry), proc.readlink(entry)); } catch { /* unreadable: no evidence */ }
    }
    return found;
  }
  if (platform !== 'darwin') return 'unknown';
  const lsof = darwin.lsof();
  if (!lsof.ok) return 'unknown';
  let pid: number | undefined;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && pid !== process.pid) found.set(pid, line.slice(1));
  }
  return found;
}

/** One lazy `scan`, memoized for the life of the returned source. */
export function sharedCwdScan(scan: () => CwdSnapshot = scanProcessCwds): CwdSource {
  let snapshot: CwdSnapshot | undefined;
  return () => snapshot ??= scan();
}

/** PIDs (never this process) whose readable working directory is one of `dirs` or beneath it,
 * from `cwds` when the caller shares a snapshot, else from a fresh scan. Squawk's own short-lived
 * git children in a worktree make this read "alive" briefly: conservative, and a retry self-heals. */
export function processesWithCwdUnder(dirs: string | readonly string[], platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc,
  darwin: DarwinReader = realDarwin, cwds?: CwdSnapshot): number[] | 'unknown' {
  const snapshot = cwds ?? scanProcessCwds(platform, proc, darwin);
  if (snapshot === 'unknown') return 'unknown';
  const targets = (typeof dirs === 'string' ? [dirs] : dirs).map(dir => { try { return realpathSync(dir); } catch { return resolve(dir); } });
  const under = (cwd: string) => { const path = cwd.replace(/ \(deleted\)$/, ''); return targets.some(target => path === target || path.startsWith(target + sep)); };
  return [...snapshot].filter(([, cwd]) => under(cwd)).map(([pid]) => pid);
}

/** Whether one process's working directory is still one of `dirs` or beneath it, without a scan:
 * one `readlink` on Linux, one `lsof` of that process on darwin. `false` when it moved away or
 * cannot be read (no evidence, hearsay-tools/cezarion#889); `undefined` on win32, whose scan names
 * no holder in the first place. */
export function processCwdUnder(pid: number, dirs: readonly string[], platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc,
  darwin: DarwinReader = realDarwin): boolean | undefined {
  let cwd: string | undefined;
  if (platform === 'linux') {
    try { cwd = proc.readlink(String(pid)); } catch { return false; }
  } else if (platform === 'darwin') {
    const lsof = darwin.lsofPid?.(pid);
    cwd = lsof?.ok ? lsof.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) : undefined;
    if (cwd === undefined) return false;
  } else return undefined;
  const found = processesWithCwdUnder(dirs, platform, proc, undefined, new Map([[pid, cwd]]));
  return found !== 'unknown' && found.length > 0;
}

/** One process's command line, its program named by base name and cut to 160 characters; undefined
 * when it cannot be read. For a refusal a human reads, never for a decision. */
function processCommand(pid: number): string | undefined {
  let args: string[] | undefined;
  if (process.platform === 'linux') {
    try { args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return undefined; }
  } else if (process.platform === 'darwin') {
    const ps = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
    args = ps.status === 0 ? ps.stdout.trim().split(' ') : undefined;
  }
  const [program = '', ...rest] = args?.filter(Boolean) ?? [];
  // A process title (`squeal <repo> daemon …`) is one argument with spaces, not a program path.
  const command = [program.includes(' ') ? program : basename(program), ...rest].join(' ').replace(/\s+/g, ' ').trim();
  return !command ? undefined : command.length > 160 ? `${command.slice(0, 159)}…` : command;
}

/** Holder pids with their commands, `123 (sleep 30), 456`, so a refusal tells a test server from an
 * agent's leftover (hearsay-tools/squawk#914). At most 8 are named. */
export function describeProcesses(pids: readonly number[]): string {
  const named = pids.slice(0, 8).map(pid => { const command = processCommand(pid); return command ? `${pid} (${command})` : String(pid); });
  return named.join(', ') + (pids.length > 8 ? ', …' : '');
}

export type GenerationProbe = { liveness: GenerationLiveness; controller?: number; pids: number[] };

/** Fresh resource proof for destroy, reuse, admission, scratch cleanup and history deletion.
 * Controller boot says nothing about who holds persistent paths, so it always scans. A process
 * blocks only when its readable cwd is under `paths`, when it is a live recorded process of the
 * generation, or when it is a live foreign controller (hearsay-tools/cezarion#889). `paths` are
 * the worktree and every scratch location; a missing record (legacy) relies on the scan alone.
 * A live foreign controller short-circuits the scan; otherwise `pids` names every holder.
 * `cwds` is a reprobe tick's shared snapshot (hearsay-tools/cezarion#879); without it, it scans. */
export function inspectGeneration({ record, paths, cwds }: { record?: WorkerProcessRecord; paths: readonly string[]; cwds?: CwdSource | undefined }): GenerationProbe {
  if (record && !isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) return { liveness: 'alive', controller: record.controller.pid, pids: [] };
  const recorded = record?.processes.filter(recordedProcessLive).map(entry => entry.pid) ?? [];
  const scan = processesWithCwdUnder(paths, undefined, undefined, undefined, cwds?.());
  const pids = [...new Set([...recorded, ...(scan === 'unknown' ? [] : scan)])];
  return { liveness: pids.length ? 'alive' : scan === 'unknown' ? 'unknown' : 'gone', pids };
}

export function probeGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[] }): GenerationLiveness {
  return inspectGeneration(input).liveness;
}

/** Execution-only proof: a known reboot ended all old descendants, provided neither the
 * controller nor any recorded process is still live. Never use this to authorize reuse/deletion;
 * execution settlement itself deletes nothing. Legacy or unknown boot evidence keeps the descendant scan. */
export function inspectExecutionGeneration(input: { record?: WorkerProcessRecord; paths: readonly string[]; pathsComplete?: boolean; cwds?: CwdSource | undefined }): GenerationProbe {
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
