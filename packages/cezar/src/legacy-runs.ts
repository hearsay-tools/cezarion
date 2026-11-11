import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { runIdParamSchema } from '@open-mercato/cezar-contract/events';

/**
 * Tasks whose own files stay in `.ai/cezar/` after a project move (owner decision A,
 * hearsay-tools/cezarion#2778). A move carries the run store and everything else to `.ai/squawk/`,
 * but a task that can still resume at the move (live, or not archived: a human can Continue a
 * finished task) keeps its own items where its agent knows them: its worktree, its handoff file
 * and other `runs/<id>…` files, its scratch directories. The moved store keeps their absolute
 * paths. The move writes the ids of those tasks to `<root>/.ai/squawk/legacy-runs.json`; a later
 * move carries their items once the task is archived or deleted, and removes the file when no
 * task is left.
 *
 * Every path helper of a run's own items resolves its directory with `runDataDir`, so the cockpit
 * reads and writes a leftover task's items in `.ai/cezar/`, and the read-only rule of the fallback
 * directory (`fallbackProjectWriteError`) exempts them.
 */

export const LEGACY_RUNS_FILE = 'legacy-runs.json';

export const legacyRunsSchema = z.object({ version: z.literal(1), runs: z.array(runIdParamSchema.shape.id) }).strict();

const cache = new Map<string, ReadonlySet<string>>();

/**
 * `legacy-runs.json` exists but cannot be read or validated. Which tasks keep their items in
 * `.ai/cezar/` is then unknown: a reader that guessed `.ai/squawk/` could miss a kept task's
 * history and write a second copy beside it, so every per-run path refuses until the project's
 * next move rewrites the file from the run store.
 */
export class LegacyRunsUnreadableError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`Cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}. `
      + 'It names the tasks whose files stayed in .ai/cezar/; the next cockpit start or migrate-project rewrites it', { cause });
  }
}

/** Whether `dataDir` is a project's moved directory, `<root>/.ai/squawk`. */
function movedDirectory(dataDir: string): boolean {
  return basename(dataDir) === 'squawk' && basename(dirname(dataDir)) === '.ai';
}

/**
 * The ids of the tasks that keep their own items in `.ai/cezar/` beside the moved directory
 * `movedDir`. Only an absent file means none; a file that is present but unreadable or invalid
 * throws `LegacyRunsUnreadableError`, and is read again on the next call.
 */
export function legacyRunIds(movedDir: string): ReadonlySet<string> {
  const key = resolve(movedDir);
  const cached = cache.get(key);
  if (cached) return cached;
  const file = join(key, LEGACY_RUNS_FILE);
  let ids: ReadonlySet<string>;
  try {
    ids = new Set(legacyRunsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).runs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LegacyRunsUnreadableError(file, error);
    ids = new Set();
  }
  cache.set(key, ids);
  return ids;
}

/** Forget what was read for `movedDir`: the move that rewrites the file calls it. */
export function forgetLegacyRunIds(movedDir: string): void {
  cache.delete(resolve(movedDir));
}

/** The tasks whose own items stay in `.ai/cezar/` beside `dataDir`; none unless it is a moved project directory. */
export function legacyRunsBeside(dataDir: string): string[] {
  return movedDirectory(dataDir) ? [...legacyRunIds(dataDir)] : [];
}

/**
 * The data directory that holds run `runId`'s own items: `.ai/cezar/` beside a moved project's
 * `dataDir` for a task the move left there, else `dataDir` itself.
 */
export function runDataDir(dataDir: string, runId: string): string {
  if (!movedDirectory(dataDir) || !legacyRunIds(dataDir).has(runId)) return dataDir;
  return join(dirname(dataDir), 'cezar');
}

const RUN_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[.-])/i;
const SHORT_SCRATCH = /^[0-9a-f]{8}$/i;

/**
 * The run among `ids` that owns the item at `parts`, a path relative to a project data directory:
 * `worktrees/<id>`, `tmp/<id>`, `preview/<id>`, `t/<first 8 of id>` and every `runs/<id>…` entry,
 * and anything inside them. Undefined for every other path.
 */
export function legacyItemOwner(parts: readonly string[], ids: ReadonlySet<string>): string | undefined {
  const [top, name] = parts;
  if (!name || parts.includes('..') || parts.includes('.')) return undefined;
  if (top === 'worktrees' || top === 'tmp' || top === 'preview') return ids.has(name) ? name : undefined;
  if (top === 't') return SHORT_SCRATCH.test(name) ? [...ids].find(id => id.slice(0, 8) === name) : undefined;
  if (top === 'runs') {
    const id = RUN_FILE.exec(name)?.[1];
    return id && ids.has(id) ? id : undefined;
  }
  return undefined;
}

/**
 * Whether `path` lies inside an item of a task that kept its files in the legacy directory of
 * the project at `root`: writes there stay allowed although `.ai/cezar/` is the fallback.
 */
export function legacyRunItem(root: string, path: string): boolean {
  const legacy = resolve(root, '.ai', 'cezar');
  const target = resolve(path);
  if (!target.startsWith(legacy + sep)) return false;
  let ids: ReadonlySet<string>;
  // A write guard fails closed: with the list unreadable, no item counts as a kept task's.
  try { ids = legacyRunIds(resolve(root, '.ai', 'squawk')); } catch (error) {
    if (error instanceof LegacyRunsUnreadableError) return false;
    throw error;
  }
  return legacyItemOwner(target.slice(legacy.length + 1).split(sep), ids) !== undefined;
}
