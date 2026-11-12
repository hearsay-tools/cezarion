import { logPrefix } from './home/display.ts';
import { dataReadDirs, pathPresent } from './project-paths.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { recordedProcessLive } from './core/process-stat.ts';

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  startToken: z.string().optional(),
  url: z.string().url().optional(),
});
export type Owner = z.infer<typeof ownerSchema>;

export function readOwner(path: string): Owner | undefined {
  try { return ownerSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return undefined; }
}

export function alive(owner: Owner): boolean {
  // Keep unexpected OS probe failures conservative; only proven absence or a
  // different process incarnation permits reclamation.
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  return recordedProcessLive(owner);
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
    console.warn(`${logPrefix()} A write to ${dataDir} was skipped: ${refusal.message}`);
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
export const heldFences = new Map<string, string>();
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

/** A held migration fence: exclusive until `release`, which never removes another owner's claim. */
export interface ProjectMigrationFence {
  lock: string;
  journal: string;
  release(): void;
}

