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
  if (!paths) return undefined;
  if (pathPresent(paths.lock)) {
    const owner = readOwner(paths.lock);
    if (!owner && pathPresent(paths.lock)) return new ProjectMigrationFencedError('unreadable', paths.lock);
    if (owner && alive(owner)) {
      // Only the fence holder's own work passes: the migration engine and the holder's live-task
      // check, run inside `asFenceHolder`. Everything else in this process is refused too.
      if (heldFences.get(paths.lock) === owner.token && holderScope.getStore() === paths.lock) return undefined;
      return new ProjectMigrationFencedError('migrating', paths.lock, owner);
    }
  }
  return pathPresent(paths.journal) ? new ProjectMigrationFencedError('journal', paths.journal) : undefined;
}

export function assertProjectAdmitted(dataDir: string): void {
  const refusal = projectAdmissionRefusal(dataDir);
  if (refusal) throw refusal;
}

/** Fences whose skipped writes have been logged, so each is logged once. */
const writeSkipsLogged = new Set<string>();

/**
 * The write backstop under every store write, claim and save: true while a fence or a journal
 * refuses this project, outside the fence holder's own work. Offline, the migration CLI refuses
 * while any cockpit it can see serves the project; this stops the writes of one it cannot see (a
 * cockpit of another home that has the project registered). A skipped write is logged once per
 * fence. Dormant cost: two `lstat` calls.
 */
export function projectWriteRefused(dataDir: string): boolean {
  const lock = migrationFencePaths(dataDir)?.lock;
  const refusal = lock && projectAdmissionRefusal(dataDir);
  if (!lock || !refusal) {
    // No refusal now: the next fence of this project logs its first skip again.
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

/** The token of every fence this process holds, by lock path. */
const heldFences = new Map<string, string>();
/** The fence whose holder work the current async call chain runs (`asFenceHolder`). */
const holderScope = new AsyncLocalStorage<string>();

/** Whether this process holds the live migration fence of `dataDir`'s project: the project
 *  migration engine runs only under a fence its own process holds. */
export function holdsProjectFence(dataDir: string): boolean {
  const lock = migrationFencePaths(dataDir)?.lock;
  const token = lock ? heldFences.get(lock) : undefined;
  return token !== undefined && readOwner(lock!)?.token === token;
}

/**
 * Run `work` as the holder of `fence`: admission and the write backstop pass for this project
 * inside it, and only inside it, so a cockpit that recovers a journal still refuses its own other
 * requests for the project meanwhile.
 */
export function asFenceHolder<T>(fence: Pick<ProjectMigrationFence, 'lock'>, work: () => T): T {
  return holderScope.run(fence.lock, work);
}

/** Run `work` unless the project is fenced or has an unfinished journal; then answer `refused`. */
export async function withProjectAdmission<T, R>(dataDir: string, work: () => Promise<T>, refused: (error: ProjectMigrationFencedError) => R): Promise<T | R> {
  const refusal = projectAdmissionRefusal(dataDir);
  return refusal ? refused(refusal) : work();
}

/** A task that is not terminal: it keeps a project from being fenced for a migration. */
export interface LiveProjectTask { id: string; title: string; state: string }

/** The fence was refused: tasks are live. Nothing was claimed or moved. */
export class ProjectMigrationBusyError extends Error {
  constructor(readonly tasks: readonly LiveProjectTask[], readonly project: string) {
    const list = tasks.map((task) => `\n- ${task.id} ${task.title} (${task.state})`).join('');
    super(`Cannot migrate ${project}: ${tasks.length} task${tasks.length === 1 ? ' is' : 's are'} live. Finish or cancel each one, then retry:${list}`);
    this.name = 'ProjectMigrationBusyError';
  }
}

/** A held migration fence: exclusive until `release`, which never removes another owner's claim. */
export interface ProjectMigrationFence {
  lock: string;
  journal: string;
  release(): void;
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
   * Take the project's exclusive migration fence, offline: own the project (taking `cockpit.lock`
   * when this instance does not hold it), so no cockpit boots on or builds it, then claim the
   * fence, so no other process is admitted. Right after the claim, `liveTasks` runs as the holder;
   * any live task releases the fence and throws `ProjectMigrationBusyError`. Held until `release`.
   */
  async fenceProject(dataDir: string, options: { liveTasks: () => readonly LiveProjectTask[] }): Promise<ProjectMigrationFence> {
    const paths = migrationFencePaths(dataDir);
    if (!paths) throw new Error(`Not a project data directory: ${dataDir}`);
    // The directory that exists, so resuming after the move never recreates the old name.
    const target = dataReadDirs(resolve(dataDir)).find(pathPresent) ?? dataDir;
    if (!this.owns(target)) await this.claimProject(target, true);
    const owner: Owner = { ...newOwner(), ...(this.url ? { url: this.url } : {}) };
    if (!claim(paths.lock, owner)) throw projectAdmissionRefusal(dataDir) ?? new ProjectMigrationFencedError('migrating', paths.lock);
    this.fences.set(paths.lock, owner);
    heldFences.set(paths.lock, owner.token);
    const fence = { ...paths, release: () => {
      if (this.fences.get(paths.lock) !== owner) return;
      this.fences.delete(paths.lock);
      if (heldFences.get(paths.lock) === owner.token) heldFences.delete(paths.lock);
      release(paths.lock, owner);
    } };
    try {
      const live = asFenceHolder(fence, options.liveTasks);
      if (live.length > 0) throw new ProjectMigrationBusyError(live, dirname(dirname(paths.lock)));
      return fence;
    } catch (error) {
      fence.release();
      throw error;
    }
  }

  /** The claim this instance holds in `directory`, if any. */
  private ownedClaim(directory: string): Owner | undefined {
    try { return this.owned.get(join(realpathSync(directory), 'cockpit.lock')); }
    catch { return undefined; }
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
      // This instance's own claim there (a recovery kept it) is not another cockpit.
      if (this.ownedClaim(fallback)?.token === owner.token) continue;
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
    for (const [path, owner] of this.fences) {
      if (heldFences.get(path) === owner.token) heldFences.delete(path);
      release(path, owner);
    }
    this.fences.clear();
    for (const [path, owner] of this.owned) release(path, owner);
    this.owned.clear();
  }
}
