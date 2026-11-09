import { dataReadDirs, pathPresent } from '../project-paths.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Remove only the empty directories this call created, innermost first. */
function removeCreated(dataDir: string, created: string | undefined): void {
  if (!created) return;
  for (let directory = resolve(dataDir); ; directory = dirname(directory)) {
    try { rmdirSync(directory); } catch { return; }
    if (directory === resolve(created) || directory === dirname(directory)) return;
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
    if (owner && alive(owner)) return new ProjectMigrationFencedError('migrating', paths.lock, owner);
  }
  return pathPresent(paths.journal) ? new ProjectMigrationFencedError('journal', paths.journal) : undefined;
}

export function assertProjectAdmitted(dataDir: string): void {
  const refusal = projectAdmissionRefusal(dataDir);
  if (refusal) throw refusal;
}

/** Operations admitted per fence path in this process; a fence drains them to zero. */
const admitted = new Map<string, number>();

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

/** Run `work` admitted until it settles, so a fence drains it; a fenced project answers `refused`. */
export async function withProjectAdmission<T, R>(dataDir: string, work: () => Promise<T>, refused: (error: ProjectMigrationFencedError) => R): Promise<T | R> {
  let leave: () => void;
  try { leave = admitProject(dataDir); }
  catch (error) {
    if (error instanceof ProjectMigrationFencedError) return refused(error);
    throw error;
  }
  try { return await work(); }
  finally { leave(); }
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
    // Before mkdir: a project moved under a fence never gets an empty directory back.
    this.checkMigrationFence(dataDir);
    this.checkFallbackOwner(dataDir);
    const created = mkdirSync(dataDir, { recursive: true });
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
        // A fence claimed while this claim landed wins: back off and leave nothing behind.
        try { this.checkFallbackOwner(dataDir); this.checkMigrationFence(dataDir); }
        catch (error) { release(path, owner); removeCreated(dataDir, created); throw error; }
        this.owned.set(path, owner); return;
      }
      const current = readOwner(path);
      if (current?.url && alive(current)) throw new CockpitAlreadyRunningError(canonical, current);
      if (Date.now() >= deadline) throw new CockpitAlreadyRunningError(canonical, current);
      await delay(50);
    }
  }

  /** Refuse a fenced project, unless the fence is this instance's own. */
  private checkMigrationFence(dataDir: string): void {
    const paths = migrationFencePaths(dataDir);
    if (!paths) return;
    const held = this.fences.get(paths.lock);
    if (held && readOwner(paths.lock)?.token === held.token) return;
    assertProjectAdmitted(dataDir);
  }

  /**
   * Take the project's exclusive migration fence: refuse new operations, own the project
   * (taking `cockpit.lock` when no cockpit of this instance does), then wait until no admitted
   * operation and no live task (`liveTasks`) remains. Held until `release`; an abort releases it.
   */
  async fenceProject(dataDir: string, options: { liveTasks: () => number; signal?: AbortSignal | undefined }): Promise<ProjectMigrationFence> {
    const paths = migrationFencePaths(dataDir);
    if (!paths) throw new Error(`Not a project data directory: ${dataDir}`);
    mkdirSync(dirname(paths.lock), { recursive: true });
    const owner: Owner = { ...newOwner(), ...(this.url ? { url: this.url } : {}) };
    if (!claim(paths.lock, owner)) throw projectAdmissionRefusal(dataDir) ?? new ProjectMigrationFencedError('migrating', paths.lock);
    this.fences.set(paths.lock, owner);
    const fence = { ...paths, release: () => {
      if (this.fences.get(paths.lock) !== owner) return;
      this.fences.delete(paths.lock);
      release(paths.lock, owner);
    } };
    try {
      // The directory that exists, so resuming after the move never recreates the old name.
      const target = dataReadDirs(resolve(dataDir)).find(pathPresent) ?? dataDir;
      if (!this.owns(target)) await this.acquire(target);
      while (options.liveTasks() > 0 || (admitted.get(paths.lock) ?? 0) > 0) await delay(50, undefined, { signal: options.signal });
      return fence;
    } catch (error) {
      fence.release();
      throw error;
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
