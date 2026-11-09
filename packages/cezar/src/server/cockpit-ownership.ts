import { dataReadDirs, pathPresent } from '../project-paths.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { processStartToken, recordedProcessLive } from '../delegation/process-liveness.ts';

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  startToken: z.string().optional(),
  url: z.string().url().optional(),
});
type Owner = z.infer<typeof ownerSchema>;

export class CockpitAlreadyRunningError extends Error {
  constructor(dataDir: string, owner?: Owner, unreadableLock?: string) {
    super(unreadableLock
      ? `Cannot read the cockpit lock ${unreadableLock}; a cockpit of the binary that migrated the project may own ${dataDir}. Remove the file only if no cockpit runs from that directory`
      : owner?.url
        ? `A cockpit already serves ${dataDir} at ${owner.url}`
        : `A cockpit already owns ${dataDir} and is still starting; retry shortly`);
    this.name = 'CockpitAlreadyRunningError';
  }
}

function readOwner(path: string): Owner | undefined {
  try { return ownerSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return undefined; }
}

function newOwner(): Owner {
  const startToken = processStartToken(process.pid);
  return { pid: process.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) };
}

function alive(owner: Owner): boolean {
  // Keep unexpected OS probe failures conservative; only proven absence or a
  // different process incarnation permits reclamation.
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  return recordedProcessLive(owner);
}

function release(path: string, owner: Owner): void {
  // A delayed cleanup must never remove a replacement owner's claim.
  if (readOwner(path)?.token === owner.token) {
    try { unlinkSync(path); } catch { /* process exit cleanup is best effort */ }
  }
}

/** Publish complete metadata atomically: a crash can never leave an empty claim. */
function publish(path: string, owner: Owner, replace = false): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try {
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
    return true;
  } catch (error) {
    if (!replace && (error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
  }
}

/**
 * Serialize stale-file removal through a separate claim. Both before AND after
 * publication we check that guard: a fresh contender cannot pass a reclaimer.
 * Guards use the same protocol, so a process killed during reclamation leaves
 * recoverable state too. Recursion is bounded and fails closed on pathological
 * chains; ordinary boot and reclamation use zero and one guards respectively.
 */
function claim(path: string, owner: Owner, depth = 0): boolean {
  if (depth > 16) throw new Error(`Too many interrupted cockpit lock recoveries: ${path}`);
  const guard = `${path}.reclaim`;
  if (existsSync(guard)) {
    const gate = newOwner();
    if (!claim(guard, gate, depth + 1)) return false;
    release(guard, gate);
  }
  if (publish(path, owner)) {
    if (!existsSync(guard)) return true;
    release(path, owner);
    return false;
  }
  const previous = readOwner(path);
  if (!previous || alive(previous)) return false;
  const gate = newOwner();
  if (!claim(guard, gate, depth + 1)) return false;
  try {
    // Read again under the guard: another reclaimer may already have finished.
    const current = readOwner(path);
    if (current && !alive(current)) unlinkSync(path);
    else if (existsSync(path)) return false;
    return publish(path, owner);
  } finally { release(guard, gate); }
}

/** The migration fence and its journal: beside both directory names, so moving one never moves them. */
export const MIGRATION_FENCE_FILE = 'squawk-migration.lock';
export const MIGRATION_JOURNAL_FILE = 'squawk-migration.json';

/** A project's fence and journal paths; none for a data directory that is not `<root>/.ai/{cezar,squawk}`. */
export function migrationFencePaths(dataDir: string): { lock: string; journal: string } | undefined {
  const directories = dataReadDirs(resolve(dataDir));
  if (directories.length < 2) return undefined;
  const parent = dirname(directories[0]!);
  return { lock: join(parent, MIGRATION_FENCE_FILE), journal: join(parent, MIGRATION_JOURNAL_FILE) };
}

export class ProjectMigrationFencedError extends Error {
  constructor(readonly reason: 'migrating' | 'journal' | 'unreadable', readonly path: string, owner?: Owner) {
    const project = dirname(dirname(path));
    super(reason === 'journal'
      ? `An unfinished project migration (${path}) blocks ${project}. Finish it with the binary that migrated the project`
      : reason === 'unreadable'
        ? `Cannot read the project migration lock ${path}; a migration of another binary may hold ${project}. Remove the file only if no migration runs for this project`
        : `A project migration (pid ${owner?.pid}${owner?.url ? ` at ${owner.url}` : ''}) holds ${project}; retry when it finishes`);
    this.name = 'ProjectMigrationFencedError';
  }
}

/**
 * Why no new operation may touch the project of `dataDir`: a live or unreadable fence (this
 * process's own fence included) or an unfinished journal. Dormant cost: two `lstat` calls.
 * A dead owner without a journal admits; the next fence claim reclaims its file.
 */
export function projectAdmissionRefusal(dataDir: string): ProjectMigrationFencedError | undefined {
  const paths = migrationFencePaths(dataDir);
  if (!paths || leased(paths.lock)) return undefined;
  if (pathPresent(paths.lock)) {
    const owner = readOwner(paths.lock);
    if (!owner && pathPresent(paths.lock)) return new ProjectMigrationFencedError('unreadable', paths.lock);
    if (owner && alive(owner)) return new ProjectMigrationFencedError('migrating', paths.lock, owner);
  }
  return pathPresent(paths.journal) ? new ProjectMigrationFencedError('journal', paths.journal) : undefined;
}

export function assertProjectAdmitted(dataDir: string): void {
  const refusal = projectAdmissionRefusal(dataDir);
  if (refusal) throw refusal;
}

/** Fences of this process still draining: the writes of the work being drained land. */
const draining = new Set<string>();
/** Fences whose skipped writes have been logged, so each is logged once. */
const writeSkipsLogged = new Set<string>();

/**
 * The write backstop under every store write, claim and save: true while a fence refuses this
 * project and the caller holds no lease or hold, unless the fence is this process's own and still
 * draining. A skipped write is logged once per fence. Dormant cost: two `lstat` calls.
 */
export function projectWriteRefused(dataDir: string): boolean {
  const refusal = projectAdmissionRefusal(dataDir);
  const lock = refusal && migrationFencePaths(dataDir)?.lock;
  if (!refusal || !lock || draining.has(lock)) {
    if (lock) writeSkipsLogged.delete(lock);
    return false;
  }
  if (!writeSkipsLogged.has(lock)) {
    writeSkipsLogged.add(lock);
    console.warn(`[cez] A write to ${dataDir} was skipped: ${refusal.message}`);
  }
  return true;
}

/** A CLI write: the project's migration admission is checked right before `write` runs. A CLI
 *  path runs each write that follows an await through it, not only its first one. */
export function admittedWrite<T>(dataDir: string, write: () => T): T {
  assertProjectAdmitted(dataDir);
  return write();
}

/** A durable commit refused by the backstop writes nothing and throws, as on a closed store. */
export function assertProjectWritable(dataDir: string): void {
  if (projectWriteRefused(dataDir)) assertProjectAdmitted(dataDir);
}

/** Operations admitted per fence path in this process; a fence drains them to zero. */
const admitted = new Map<string, number>();
/** The open leases of the current async call chain: an operation admitted before a fence
 *  finishes, task starts included, and the drain waits for what it started. */
const leases = new AsyncLocalStorage<ReadonlyArray<{ lock: string; open: boolean }>>();
function leased(lock: string): boolean {
  return leases.getStore()?.some((lease) => lease.open && lease.lock === lock) ?? false;
}

/** Admit one operation until the returned release runs; throws `ProjectMigrationFencedError`. */
export function admitProject(dataDir: string): () => void {
  assertProjectAdmitted(dataDir);
  const lock = migrationFencePaths(dataDir)?.lock;
  if (!lock) return () => undefined;
  admitted.set(lock, (admitted.get(lock) ?? 0) + 1);
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const left = admitted.get(lock)! - 1;
    if (left > 0) admitted.set(lock, left);
    else admitted.delete(lock);
  };
}

/**
 * Run `work` counted towards the drain and admitted for its whole length, without refusing it:
 * work that admitted or live work already set going (a webhook delivery, a preview release),
 * which a fence must wait for rather than drop. Everything it calls passes admission.
 */
export function holdProjectWork<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const lock = migrationFencePaths(dataDir)?.lock;
  if (!lock) return work();
  admitted.set(lock, (admitted.get(lock) ?? 0) + 1);
  const lease = { lock, open: true };
  const settle = () => {
    lease.open = false;
    const left = admitted.get(lock)! - 1;
    if (left > 0) admitted.set(lock, left);
    else admitted.delete(lock);
  };
  let running: Promise<T>;
  try { running = leases.run([...(leases.getStore() ?? []), lease], work); }
  catch (error) { settle(); throw error; }
  void running.then(settle, settle);
  return running;
}

/**
 * Run `work` admitted until it settles, so a fence drains it; a fenced project answers `refused`.
 * Everything `work` calls passes admission for this project while the lease is open.
 */
export async function withProjectAdmission<T, R>(dataDir: string, work: () => Promise<T>, refused: (error: ProjectMigrationFencedError) => R): Promise<T | R> {
  const refusal = projectAdmissionRefusal(dataDir);
  if (refusal) return refused(refusal);
  return holdProjectWork(dataDir, work);
}

/** A task that is not terminal: it keeps a project from being fenced for a migration. */
export interface LiveProjectTask { id: string; title: string; state: string }

/**
 * How long a fence drains work already in flight before the migration stops by itself: longer
 * than one webhook delivery series (3 attempts of 10 s with backoff), a project context build with
 * recovery and one bounded archive or automation tick; short enough that no migration hangs.
 */
export const PROJECT_FENCE_DRAIN_MS = 60_000;

/** The fence was given up: tasks are live, or work still ran when the drain bound passed. */
export class ProjectMigrationBusyError extends Error {
  constructor(readonly reason: 'live' | 'drain-timeout', readonly tasks: readonly LiveProjectTask[], readonly project: string) {
    const list = tasks.map((task) => `\n- ${task.id} ${task.title} (${task.state})`).join('');
    super(reason === 'live'
      ? `Cannot migrate ${project}: ${tasks.length} task${tasks.length === 1 ? ' is' : 's are'} live. Finish or cancel each one, then retry:${list}`
      : `The migration of ${project} stopped: work was still running after ${PROJECT_FENCE_DRAIN_MS / 1000} s. Nothing was moved. Finish or cancel each task below, then retry:${list}`);
    this.name = 'ProjectMigrationBusyError';
  }
}

/** A held migration fence: exclusive until `release`, which never removes another owner's claim. */
export interface ProjectMigrationFence {
  lock: string;
  journal: string;
  release(): void;
}

/** `work`, or `timedOut()` once `deadline` passes, or the abort reason of `signal`. */
async function withinDeadline(work: Promise<unknown>, deadline: number, signal: AbortSignal | undefined, timedOut: () => Error): Promise<void> {
  const timer = new AbortController();
  const abort = () => timer.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await Promise.race([work, delay(Math.max(0, deadline - Date.now()), undefined, { signal: timer.signal }).then(() => { throw timedOut(); })]);
  } finally {
    signal?.removeEventListener('abort', abort);
    timer.abort();
  }
}

/** The live cockpit other than this process that owns `dataDir`, if any: its pid and, once it
 *  listens, its URL. Read-only: nothing is claimed. */
export function anotherCockpitOwner(dataDir: string): { pid: number; url?: string } | undefined {
  for (const directory of dataReadDirs(dataDir)) {
    const owner = readOwner(join(directory, 'cockpit.lock'));
    if (owner === undefined || owner.pid === process.pid || !alive(owner)) continue;
    return { pid: owner.pid, ...(owner.url ? { url: owner.url } : {}) };
  }
  return undefined;
}

/** Whether a live cockpit other than this process owns `dataDir`. Read-only: nothing is claimed. */
export function ownedByAnotherCockpit(dataDir: string): boolean {
  return anotherCockpitOwner(dataDir) !== undefined;
}

/** One owner per cockpit process, shared by boot and lazy project contexts. */
export class CockpitOwnership {
  private readonly owned = new Map<string, Owner>();
  /** Migration fences this instance holds, by lock path. */
  private readonly fences = new Map<string, Owner>();
  private url: string | undefined;

  /** A long-lived process claim may be borrowed without changing its lifetime. */
  owns(dataDir: string): boolean {
    try { return this.owned.has(join(realpathSync(dataDir), 'cockpit.lock')); }
    catch { return false; }
  }

  async acquire(dataDir: string): Promise<void> {
    return this.claimProject(dataDir, false);
  }

  /** `forFence`: the claim a fence holder takes first, which an unfinished journal does not stop. */
  private async claimProject(dataDir: string, forFence: boolean): Promise<void> {
    // Before mkdir: a project moved under a fence never gets an empty directory back.
    this.checkMigrationFence(dataDir, forFence);
    this.checkFallbackOwner(dataDir);
    mkdirSync(dataDir, { recursive: true });
    const canonical = realpathSync(dataDir);
    const path = join(canonical, 'cockpit.lock');
    if (this.owned.has(path)) return;
    const owner: Owner = { ...newOwner(), ...(this.url ? { url: this.url } : {}) };
    // A competing boot may have acquired its claim before binding HTTP. Wait
    // for its advertised URL, but never touch its stores or recover its runs.
    const deadline = Date.now() + 15_000;
    while (true) {
      if (this.owned.has(path)) return;
      this.checkFallbackOwner(dataDir);
      if (claim(path, owner)) {
        // A fence claimed while this claim landed wins: back off.
        try { this.checkFallbackOwner(dataDir); this.checkMigrationFence(dataDir, forFence); }
        catch (error) { release(path, owner); throw error; }
        this.owned.set(path, owner); return;
      }
      const current = readOwner(path);
      if (current?.url && alive(current)) throw new CockpitAlreadyRunningError(canonical, current);
      if (Date.now() >= deadline) throw new CockpitAlreadyRunningError(canonical, current);
      await delay(50);
    }
  }

  /** Refuse a fenced project, unless the fence is this instance's own. */
  private checkMigrationFence(dataDir: string, journalAllowed: boolean): void {
    const paths = migrationFencePaths(dataDir);
    if (!paths) return;
    const held = this.fences.get(paths.lock);
    if (held && readOwner(paths.lock)?.token === held.token) return;
    const refusal = projectAdmissionRefusal(dataDir);
    if (refusal && !(journalAllowed && refusal.reason === 'journal')) throw refusal;
  }

  /**
   * Take the project's exclusive migration fence: own the project (taking `cockpit.lock` when this
   * instance does not hold it) and refuse new operations. Then, with no wait in between, refuse
   * while any task is live (`liveTasks`), and drain the work in flight (`inFlight` and admitted
   * operations) for at most `drainMs`. Only the `cockpit.lock` holder ever holds the fence, so no
   * other cockpit boots or serves the project meanwhile. A refusal, the bound or an abort releases
   * the fence; otherwise it is held until `release`.
   */
  async fenceProject(dataDir: string, options: {
    liveTasks: () => readonly LiveProjectTask[]; inFlight: () => number; signal?: AbortSignal | undefined; drainMs?: number;
    /** Work that ends on its own once nothing new starts (history compression, a reports scan),
     *  awaited inside the same bound and abort. */
    settle?: () => Promise<unknown>;
  }): Promise<ProjectMigrationFence> {
    const paths = migrationFencePaths(dataDir);
    if (!paths) throw new Error(`Not a project data directory: ${dataDir}`);
    options.signal?.throwIfAborted();
    // The directory that exists, so resuming after the move never recreates the old name.
    const target = dataReadDirs(resolve(dataDir)).find(pathPresent) ?? dataDir;
    if (!this.owns(target)) await this.claimProject(target, true);
    const owner: Owner = { ...newOwner(), ...(this.url ? { url: this.url } : {}) };
    if (!claim(paths.lock, owner)) throw projectAdmissionRefusal(dataDir) ?? new ProjectMigrationFencedError('migrating', paths.lock);
    this.fences.set(paths.lock, owner);
    draining.add(paths.lock);
    const fence = { ...paths, release: () => {
      if (this.fences.get(paths.lock) !== owner) return;
      this.fences.delete(paths.lock);
      release(paths.lock, owner);
    } };
    try {
      const project = dirname(dirname(paths.lock));
      const live = options.liveTasks();
      if (live.length > 0) throw new ProjectMigrationBusyError('live', live, project);
      const deadline = Date.now() + (options.drainMs ?? PROJECT_FENCE_DRAIN_MS);
      while (options.liveTasks().length > 0 || options.inFlight() > 0 || (admitted.get(paths.lock) ?? 0) > 0) {
        if (Date.now() >= deadline) throw new ProjectMigrationBusyError('drain-timeout', options.liveTasks(), project);
        await delay(50, undefined, { signal: options.signal });
      }
      if (options.settle) await withinDeadline(options.settle(), deadline, options.signal, () => new ProjectMigrationBusyError('drain-timeout', options.liveTasks(), project));
      options.signal?.throwIfAborted();
      return fence;
    } catch (error) {
      fence.release();
      throw error;
    } finally {
      draining.delete(paths.lock);
    }
  }

  /** A live owner under the project's other directory name; the claimed directory is not checked. */
  private checkFallbackOwner(dataDir: string): void {
    for (const fallback of dataReadDirs(dataDir)) {
      if (resolve(fallback) === resolve(dataDir)) continue;
      const path = join(fallback, 'cockpit.lock');
      if (!existsSync(path)) continue;
      const owner = readOwner(path);
      // Invalid fallback claims cannot be repaired by this binary; retain them unchanged.
      if (!owner) throw new CockpitAlreadyRunningError(fallback, undefined, path);
      if (alive(owner)) throw new CockpitAlreadyRunningError(fallback, owner);
    }
  }

  publishUrl(url: string): void {
    this.url = url;
    for (const [path, owner] of this.owned) {
      if (readOwner(path)?.token !== owner.token) throw new Error(`Cockpit ownership changed: ${path}`);
      owner.url = url;
      publish(path, owner, true);
    }
  }

  /** Only at process exit: managers may still have asynchronous work after dispose. */
  releaseAll(): void {
    for (const [path, owner] of this.fences) release(path, owner);
    this.fences.clear();
    for (const [path, owner] of this.owned) release(path, owner);
    this.owned.clear();
  }
}
