import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { incrementalCwdScan, processesWithCwdUnder, processStartToken, recordedProcessLive, type CwdSnapshot, type RecordedProcess } from './delegation/process-liveness.ts';

type Snapshot = Map<number, string | undefined> | 'unknown';

/** Darwin probes must not block the event loop (and other runs' kill timers). */
function inspect(command: string, args: string[], timeout: number) {
  return new Promise<{ ok: boolean; stdout: string; pid?: number | undefined }>(done => {
    const child = execFile(command, args, {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }, (error, stdout) => done({
      ok: !error || (command === 'lsof' && error.code === 1 && !error.killed),
      stdout, pid: child.pid,
    }));
  });
}

async function snapshot(cwd: string, linuxCwds: () => CwdSnapshot): Promise<Snapshot> {
  if (process.platform === 'linux') return linuxSnapshot(cwd, linuxCwds());
  // No process-tree proof exists on other platforms. Refuse before spawning,
  // rather than start work whose shutdown could retain the guard forever.
  if (process.platform !== 'darwin') return 'unknown';
  return darwinSnapshot(cwd);
}

function linuxSnapshot(cwd: string, cwds: CwdSnapshot): Snapshot {
  const pids = processesWithCwdUnder(cwd, undefined, undefined, undefined, cwds);
  return pids === 'unknown' ? pids : new Map(pids.map(pid => [pid, processStartToken(pid)]));
}

/** One bounded probe result from `inspect`. */
type Inspection = Awaited<ReturnType<typeof inspect>>;

/** Darwin proof needs two independent bounded probes; neither alone is evidence. */
async function darwinSnapshot(cwd: string): Promise<Snapshot> {
  const uid = process.getuid?.();
  if (uid === undefined) return 'unknown';
  const [lsof, ps] = await Promise.all([
    inspect('lsof', ['-a', '-u', String(uid), '-d', 'cwd', '-Fpn'], 5_000),
    inspect('ps', ['-U', String(uid), '-o', 'pid=,lstart='], 2_000),
  ]);
  return darwinHolders(cwd, lsof, ps);
}

/** Reconcile the two probe outputs into the holder set under the worktree root. */
function darwinHolders(cwd: string, lsof: Inspection, ps: Inspection): Snapshot {
  if (!ps.ok || !lsof.ok || !lsof.stdout) return 'unknown';
  let root = resolve(cwd);
  try { root = realpathSync(cwd); } catch { /* Git will report an absent directory. */ }
  const holders = holdersUnderRoot(lsof.stdout, root);
  const excluded = new Set<number | undefined>([process.pid, ps.pid, lsof.pid]);
  const result = psIdentities(ps.stdout, holders, excluded);
  addUnattributed(result, holders, excluded);
  return result;
}

/** lsof prints one `p` line per PID followed by an `n` line for each path it holds open. */
function holdersUnderRoot(lsofOutput: string, root: string): Set<number> {
  const holders = new Set<number>();
  let pid: number | undefined;
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined) {
      const path = line.slice(1);
      if (path === root || path.startsWith(root + sep)) holders.add(pid);
    }
  }
  return holders;
}

/**
 * As in orphan recovery, a process lsof could not read is no evidence (hearsay-tools/cezarion#889);
 * `ps` only supplies each holder's identity.
 */
function psIdentities(psOutput: string, holders: Set<number>, excluded: Set<number | undefined>): Map<number, string | undefined> {
  const result = new Map<number, string | undefined>();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (excluded.has(id) || !holders.has(id)) continue;
    result.set(id, match[2]);
  }
  return result;
}

/** A holder born between the two snapshots may be absent from ps. Missing
 * identity is uncertainty, never grounds to drop the lsof observation. */
function addUnattributed(result: Map<number, string | undefined>, holders: Set<number>, excluded: Set<number | undefined>) {
  for (const id of holders) {
    if (!excluded.has(id) && !result.has(id)) result.set(id, undefined);
  }
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
 * Set on each autosave Git command with a fresh value. Descendants inherit it
 * through fork, exec, setsid and reparenting; unrelated work in the worktree
 * (Squeal's Vitest workers, agent tools) never carries it (hearsay-tools/cezarion#958).
 */
export const AUTOSAVE_OWNER_ENV = 'CEZ_AUTOSAVE_OWNER';

/** `marked` is absent when the environment cannot be read; `gone` means the process exited. */
export type OwnerProbe = (pid: number, marker: string) => Promise<{ marked?: boolean | undefined; parent?: number } | 'gone'>;

/** Only these codes prove the process exited; any other read error (EMFILE, EIO) is uncertainty. */
const exited = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');

const linuxOwnerProbe: OwnerProbe = async (pid, marker) => {
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { return exited(error) ? 'gone' : {}; }
  const parent = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
  try {
    const environ = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
    return { marked: environ.includes(`${AUTOSAVE_OWNER_ENV}=${marker}`), parent };
  } catch (error) {
    return exited(error) ? 'gone' : { parent };
  }
};

const darwinOwnerProbe: OwnerProbe = async (pid, marker) => {
  const ps = await inspect('ps', ['-E', '-ww', '-o', 'ppid=,command=', '-p', String(pid)], 2_000);
  const match = /^\s*(\d+)\s+(.*)$/s.exec(ps.stdout);
  if (!match) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'; }
    return {};
  }
  const line = ' ' + match[2]!.trim();
  if (line.includes(` ${AUTOSAVE_OWNER_ENV}=${marker}`)) return { marked: true, parent: Number(match[1]) };
  // `ps -E` silently omits an environment it may not read. Every ordinary
  // process carries PATH, so its absence is uncertainty, never proof.
  return { marked: /\sPATH=/.test(line) ? false : undefined, parent: Number(match[1]) };
};

export interface AutosaveOwner {
  /** This command's `AUTOSAVE_OWNER_ENV` value. */
  marker: string;
  /** The Git leader, once spawned. */
  root: () => number | undefined;
}

/**
 * Conservative companion to owned-group proof, using orphan recovery's cwd
 * boundary. A new holder counts only when it is Git's: its environment carries
 * this command's marker, its parent is Git or an attributed holder, or its
 * environment cannot be read (fail closed). Never signal cwd-only matches: they
 * may be unrelated agent tools. Polling does not contain a child that both clears
 * its environment and leaves the tree before it can be observed; this is not an
 * OS sandbox.
 */
export async function watchAutosaveHolders(cwd: string, owner: AutosaveOwner,
  probe: OwnerProbe = process.platform === 'darwin' ? darwinOwnerProbe : linuxOwnerProbe) {
  // After the baseline, a Linux check reads only the processes born since the previous one (hearsay-tools/squawk#1694).
  const linuxCwds = incrementalCwdScan();
  const baseline = await snapshot(cwd, linuxCwds);
  if (baseline === 'unknown') return undefined;
  const observed = new Map<number, RecordedProcess>();
  // Per incarnation, so an unrelated process is read once and never tracked.
  const unrelated = new Set<string>();
  let diagnostics: { pids: number[]; processes: RecordedProcess[]; inspectionFailed: boolean } = { pids: [], processes: [], inspectionFailed: false };
  const alive = async () => {
    const current = await snapshot(cwd, linuxCwds);
    if (current === 'unknown') { diagnostics = { ...diagnostics, inspectionFailed: true }; return true; }
    const pending = new Map<number, { startToken?: string | undefined; parent?: number | undefined }>();
    for (const [pid, startToken] of current) {
      if (startToken !== undefined && baseline.get(pid) === startToken) continue;
      const previous = observed.get(pid);
      if (previous && (startToken === undefined || previous.startToken === startToken)) continue;
      if (startToken !== undefined && unrelated.has(`${pid}:${startToken}`)) continue;
      const found = await probe(pid, owner.marker);
      if (found === 'gone') continue;
      if (found.marked !== false) observed.set(pid, { pid, startToken });
      else pending.set(pid, { startToken, parent: found.parent });
    }
    // An unmarked child of Git or of an attributed holder cleared its environment.
    const owns = async (parent: number | undefined) => {
      if (parent === undefined || parent <= 1) return false;
      if (parent === owner.root() || observed.has(parent)) return true;
      const found = await probe(parent, owner.marker);
      return found !== 'gone' && found.marked !== false;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, entry] of pending) {
        if (!await owns(entry.parent)) continue;
        observed.set(pid, { pid, startToken: entry.startToken });
        pending.delete(pid);
        changed = true;
      }
    }
    for (const [pid, entry] of pending) if (entry.startToken !== undefined) unrelated.add(`${pid}:${entry.startToken}`);
    // Once observed, a holder stays tracked even if it later changes cwd.
    const states = await Promise.all([...observed.values()].map(live));
    diagnostics = { pids: [...observed.keys()].filter((_, index) => states[index]), processes: [...observed.values()].filter((_, index) => states[index]), inspectionFailed: false };
    return states.some(Boolean);
  };
  return Object.assign(alive, { diagnostics: () => diagnostics });
}

/** A started watch: whether a Git holder is alive, and the holders it last saw. */
export type AutosaveHolders = NonNullable<Awaited<ReturnType<typeof watchAutosaveHolders>>>;
