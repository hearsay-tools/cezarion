import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitCommonDir } from '../delegation/workspace.ts';
import { MIGRATION_JOURNAL_FILE } from '../server/cockpit-ownership.ts';
import { pathPresent } from '../project-paths.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import type { PathRewrite, ProjectMigrationJournal } from './journal.ts';

/**
 * What a project migration journal may name (hearsay-tools/cezarion#3089). A journal is read back
 * from disk before a resume, so it is untrusted input: every path it names is checked before any
 * step runs, and each step checks its write target again right before it writes.
 *
 * - `source` and `destination` are exactly `<root>/.ai/cezar` and `<root>/.ai/squawk`, and
 *   `<root>/.ai` is a real directory.
 * - A move goes from inside `source` to the same place inside `destination`; so does a worktree.
 * - A receipt or cleanup checkpoint lies in `<git common dir>/cezar-owned-workspaces/`; every other
 *   rewritten file lies in `<destination>/runs/`, or in `<source>/runs/` for a file a kept task keeps.
 * - A rewritten value moves a path from a form of the project root's `.ai/cezar` to the same place
 *   under `.ai/squawk`; a tracked file is a relative `.ai/cezar/...` path printed as a `git mv`.
 * - No existing directory on the way to a checked path resolves elsewhere (a symlink out), and a
 *   file the engine opens or rewrites in place (the run store and its `-wal` and `-shm`, each
 *   rewritten JSON file, each receipt) is a regular file, never a symlink. A moved item may be a
 *   symlink: a rename moves the link itself.
 * - The journal file itself is a regular file of at most `MAX_JOURNAL_BYTES` that Git does not
 *   track (the shared excludes keep it out of every ordinary add), checked before it is read.
 */

export class ProjectMigrationJournalRefusedError extends Error {
  constructor(readonly journal: string, detail: string) {
    super(`The project migration journal ${journal} is refused: ${detail}. Nothing was changed. `
      + 'The journal stays for inspection; remove it only if no migration of this project ran');
    this.name = 'ProjectMigrationJournalRefusedError';
  }
}

function within(parent: string, path: string): boolean {
  const inside = relative(parent, path);
  return inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`));
}

/**
 * Why `path` may not be written as part of `root`: not a normalized absolute path, outside `root`
 * by its letters, or an existing directory on its way (from `root` down) that resolves elsewhere.
 * Undefined when it may. The last component itself is not followed: a move renames a link, and a
 * rewrite replaces a file by rename.
 */
export function outsideOf(root: string, path: string): string | undefined {
  if (!isAbsolute(path) || resolve(path) !== path) return `${path} is not a normalized absolute path`;
  if (path === root || !within(root, path)) return `${path} is not inside ${root}`;
  let existing = dirname(path);
  while (!pathPresent(existing) && existing !== dirname(existing)) existing = dirname(existing);
  try {
    if (realpathSync(existing) !== existing) return `${existing} resolves to ${realpathSync(existing)}, outside the project`;
  } catch (error) { return `${existing} cannot be resolved: ${(error as Error).message}`; }
  return undefined;
}

/** Why `path`, when it exists, may not be opened or rewritten in place: it is a symlink or not a file. */
export function notRegularFile(path: string): string | undefined {
  if (!pathPresent(path)) return undefined;
  const info = lstatSync(path);
  return info.isSymbolicLink() ? `${path} is a symbolic link` : info.isFile() ? undefined : `${path} is not a regular file`;
}

/** The run store the run-store step opens, and the sidecars SQLite opens with it. */
export function runStoreFiles(directory: string): string[] {
  const database = join(directory, RUNS_DB_FILE);
  return [database, `${database}-wal`, `${database}-shm`];
}

/** `path` inside `from`, carried to the same place inside `to`. */
function carried(from: string, to: string, path: { from: string; to: string }): string | undefined {
  return outsideOf(from, path.from) ?? outsideOf(to, path.to)
    ?? (path.to === to + path.from.slice(from.length) ? undefined : `${path.to} is not where ${path.from} goes`);
}

const execFileAsync = promisify(execFile);

const LEGACY = `${sep}.ai${sep}cezar`;
const MIGRATED = `${sep}.ai${sep}squawk`;

/** A stored value: under some form of the project root's `.ai/cezar`, mapped to the same place under `.ai/squawk`. */
function valueMoved(repoRoot: string, real: (prefix: string) => string | undefined, value: { from: string; to: string }): string | undefined {
  for (let at = value.from.indexOf(LEGACY); at > 0; at = value.from.indexOf(LEGACY, at + 1)) {
    const rest = value.from.slice(at + LEGACY.length);
    if (rest !== '' && !rest.startsWith(sep)) continue;
    const prefix = value.from.slice(0, at);
    if (real(prefix) === repoRoot && value.to === prefix + MIGRATED + rest) return undefined;
  }
  return `the value ${value.from} -> ${value.to} does not move a path of this project from .ai/cezar to .ai/squawk`;
}

/** A tracked file: relative, `.ai/cezar/...` to the same `.ai/squawk/...`, no `..`. */
function trackedMoved(file: { from: string; to: string }): string | undefined {
  const parts = file.from.split('/');
  const ok = parts.length > 2 && parts[0] === '.ai' && parts[1] === 'cezar' && !parts.some(part => part === '' || part === '.' || part === '..')
    && !file.from.includes('\\') && file.to === `.ai/squawk/${parts.slice(2).join('/')}`;
  return ok ? undefined : `the tracked file ${file.from} -> ${file.to} is not a path under .ai/cezar`;
}

/** The first refusal `check` gives for any of `items`. */
function firstRefusal<T>(items: readonly T[], check: (item: T) => string | undefined): string | undefined {
  for (const item of items) {
    const refusal = check(item);
    if (refusal) return refusal;
  }
  return undefined;
}

/** The directories, moves, worktrees and tracked files of `journal`. */
function layoutRefusal(journal: ProjectMigrationJournal): string | undefined {
  const ai = join(journal.repoRoot, '.ai');
  if (journal.source !== join(ai, 'cezar') || journal.destination !== join(ai, 'squawk')) return `its directories are not ${join(ai, 'cezar')} and ${join(ai, 'squawk')}`;
  // `<root>/.ai` itself must be a real directory of the root.
  return outsideOf(journal.repoRoot, journal.source)
    ?? firstRefusal([...journal.moves, ...journal.worktrees], item => carried(journal.source, journal.destination, item))
    ?? firstRefusal(journal.tracked, trackedMoved);
}

/** Every rewrite of `journal`: the file it rewrites in place, the run store it opens, the value it moves. */
async function rewritesRefusal(journal: ProjectMigrationJournal): Promise<string | undefined> {
  const isReceipt = (rewrite: PathRewrite) => rewrite.kind === 'receipt' || rewrite.kind === 'cleanup-checkpoint';
  const receipts = journal.rewrites.some(isReceipt) ? await receiptDirectory(journal.repoRoot) : undefined;
  const runs = join(journal.destination, 'runs');
  const reals = new Map<string, string | undefined>();
  const real = (prefix: string) => {
    if (!reals.has(prefix)) { try { reals.set(prefix, realpathSync(prefix)); } catch { reals.set(prefix, undefined); } }
    return reals.get(prefix);
  };
  // The run store the run-store step opens: before the move it is the source's, after it the destination's.
  const stores = journal.rewrites.some(rewrite => rewrite.kind === 'run-row') ? [...runStoreFiles(journal.source), ...runStoreFiles(journal.destination)] : [];
  const fileRefusal = (rewrite: PathRewrite): string | undefined => {
    if (!('file' in rewrite)) return undefined;
    // A kept task's own run file stays in the old directory and is rewritten there.
    const directory = isReceipt(rewrite) ? receipts! : rewrite.file.startsWith(join(journal.source, 'runs') + sep) ? join(journal.source, 'runs') : runs;
    return outsideOf(directory, rewrite.file) ?? notRegularFile(rewrite.file);
  };
  return firstRefusal(journal.rewrites, (rewrite) => { return fileRefusal(rewrite) ?? valueMoved(journal.repoRoot, real, rewrite); })
    ?? firstRefusal(stores, notRegularFile);
}

/** The first reason `journal` may not run, checked before any step; undefined when it may. */
async function journalRefusal(path: string, journal: ProjectMigrationJournal): Promise<string | undefined> {
  return layoutRefusal(journal) ?? await rewritesRefusal(journal);
}

/**
 * The largest journal a resume reads. A journal holds the plan, a few hundred bytes per path
 * rewrite: 100,000 runs with several rewritten fields each stay well under it. Anything larger
 * is not a journal this engine wrote.
 */
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;

/**
 * Why Git tracking refuses the journal of the project at `repoRoot` (a real path): tracked, or the
 * check could not finish. A directory outside any Git repository tracks nothing. The pathspec is
 * the journal's canonical place, whatever form the caller's path has.
 */
async function trackedJournalRefusal(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', `.ai/${MIGRATION_JOURNAL_FILE}`], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
    return stdout ? 'Git tracks it; a migration journal is never committed' : undefined;
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? ''))) return undefined;
    return `Git could not tell whether it tracks the journal: ${(error as Error).message.split('\n')[0]}`;
  }
}

/**
 * Accept the journal file at `path` before it is read: false when there is none; refused when it
 * is a symlink or not a regular file, larger than `MAX_JOURNAL_BYTES`, tracked by Git (only a
 * forced add or a clone tracks it; one Git call, only when a journal exists), or when that Git
 * check cannot finish. Nothing is read.
 */
export async function assertJournalFile(path: string, repoRoot: string): Promise<boolean> {
  if (!pathPresent(path)) return false;
  const refusal = notRegularFile(path) ?? (lstatSync(path).size > MAX_JOURNAL_BYTES ? `it is larger than ${MAX_JOURNAL_BYTES} bytes` : undefined)
    ?? await trackedJournalRefusal(repoRoot);
  if (refusal) throw new ProjectMigrationJournalRefusedError(path, refusal);
  return true;
}

/** The repository's receipt directory, where receipt and cleanup checkpoint rewrites must lie. */
export async function receiptDirectory(repoRoot: string): Promise<string> {
  return join(await gitCommonDir(repoRoot), 'cezar-owned-workspaces');
}

/** Refuse `journal` before any step when it names anything outside the project's own state. */
export async function assertJournalContained(path: string, journal: ProjectMigrationJournal): Promise<void> {
  const refusal = await journalRefusal(path, journal);
  if (refusal) throw new ProjectMigrationJournalRefusedError(path, refusal);
}
