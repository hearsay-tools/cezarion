import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  constructor(dataDir: string, owner?: Owner) {
    super(owner?.url
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

/** The live cockpit other than this process that owns `dataDir`, if any: its pid and, once it
 *  listens, its URL. Read-only: nothing is claimed. */
export function anotherCockpitOwner(dataDir: string): { pid: number; url?: string } | undefined {
  let canonical: string;
  try { canonical = realpathSync(dataDir); } catch { return undefined; }
  const owner = readOwner(join(canonical, 'cockpit.lock'));
  if (owner === undefined || owner.pid === process.pid || !alive(owner)) return undefined;
  return { pid: owner.pid, ...(owner.url ? { url: owner.url } : {}) };
}

/** Whether a live cockpit other than this process owns `dataDir`. Read-only: nothing is claimed. */
export function ownedByAnotherCockpit(dataDir: string): boolean {
  return anotherCockpitOwner(dataDir) !== undefined;
}

/** One owner per cockpit process, shared by boot and lazy project contexts. */
export class CockpitOwnership {
  private readonly owned = new Map<string, Owner>();
  private url: string | undefined;

  async acquire(dataDir: string): Promise<void> {
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
      if (claim(path, owner)) { this.owned.set(path, owner); return; }
      const current = readOwner(path);
      if (current?.url && alive(current)) throw new CockpitAlreadyRunningError(canonical, current);
      if (Date.now() >= deadline) throw new CockpitAlreadyRunningError(canonical, current);
      await delay(50);
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
    for (const [path, owner] of this.owned) release(path, owner);
    this.owned.clear();
  }
}
