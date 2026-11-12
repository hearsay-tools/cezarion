import { dataReadDirs, pathPresent } from '../project-paths.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processStartToken } from '../core/process-stat.ts';
import { readOwner, alive, heldFences, migrationFencePaths, projectAdmissionRefusal, ProjectMigrationFencedError, asFenceHolder, type Owner, type ProjectMigrationFence } from '../project-fence.ts';
export { MIGRATION_FENCE_FILE, MIGRATION_JOURNAL_FILE, migrationFencePaths, ProjectMigrationFencedError, projectAdmissionRefusal, assertProjectAdmitted, projectWriteRefused, admittedWrite, assertProjectWritable, holdsProjectFence, asFenceHolder, withProjectAdmission, type ProjectMigrationFence } from '../project-fence.ts';

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

function newOwner(): Owner {
  const startToken = processStartToken(process.pid);
  return { pid: process.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) };
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
