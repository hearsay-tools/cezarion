import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitCommonDir } from '../delegation/workspace.ts';
import { pathPresent } from '../project-paths.ts';
import type { ProjectMigrationJournal } from './journal.ts';
import { gitOutput } from './plan.ts';

/**
 * What a project migration journal may name (hearsay-tools/cezarion#3089). A journal is read back
 * from disk before a resume, so it is untrusted input: every path it names is checked before any
 * step runs, and each step checks its write target again right before it writes.
 *
 * - `source` and `destination` are exactly `<root>/.ai/cezar` and `<root>/.ai/squawk`, and
 *   `<root>/.ai` is a real directory.
 * - A move goes from inside `source` to the same place inside `destination`; so does a worktree.
 * - A receipt or cleanup checkpoint lies in `<git common dir>/cezar-owned-workspaces/`; every other
 *   rewritten file lies in `<destination>/runs/`.
 * - A rewritten value moves a path from a form of the project root's `.ai/cezar` to the same place
 *   under `.ai/squawk`; a tracked file is a relative `.ai/cezar/...` path printed as a `git mv`.
 * - No existing directory on the way to a checked path resolves elsewhere (a symlink out).
 * - Git does not track the journal: the shared excludes keep it out of every ordinary add.
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

/** `path` inside `from`, carried to the same place inside `to`. */
function carried(from: string, to: string, path: { from: string; to: string }): string | undefined {
  return outsideOf(from, path.from) ?? outsideOf(to, path.to)
    ?? (path.to === to + path.from.slice(from.length) ? undefined : `${path.to} is not where ${path.from} goes`);
}

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

/** The first reason `journal` may not run, checked before any step; undefined when it may. */
async function journalRefusal(path: string, journal: ProjectMigrationJournal): Promise<string | undefined> {
  const root = journal.repoRoot;
  const ai = join(root, '.ai');
  if (journal.source !== join(ai, 'cezar') || journal.destination !== join(ai, 'squawk')) return `its directories are not ${join(ai, 'cezar')} and ${join(ai, 'squawk')}`;
  // `<root>/.ai` itself must be a real directory of the root.
  const aiReal = outsideOf(root, journal.source);
  if (aiReal) return aiReal;
  for (const move of journal.moves) {
    const refusal = carried(journal.source, journal.destination, move);
    if (refusal) return refusal;
  }
  for (const worktree of journal.worktrees) {
    const refusal = carried(journal.source, journal.destination, worktree);
    if (refusal) return refusal;
  }
  for (const file of journal.tracked) {
    const refusal = trackedMoved(file);
    if (refusal) return refusal;
  }
  const receipts = journal.rewrites.some(rewrite => rewrite.kind === 'receipt' || rewrite.kind === 'cleanup-checkpoint')
    ? await receiptDirectory(root) : undefined;
  const runs = join(journal.destination, 'runs');
  const reals = new Map<string, string | undefined>();
  const real = (prefix: string) => {
    if (!reals.has(prefix)) { try { reals.set(prefix, realpathSync(prefix)); } catch { reals.set(prefix, undefined); } }
    return reals.get(prefix);
  };
  for (const rewrite of journal.rewrites) {
    const refusal = ('file' in rewrite ? outsideOf(rewrite.kind === 'receipt' || rewrite.kind === 'cleanup-checkpoint' ? receipts! : runs, rewrite.file) : undefined)
      ?? valueMoved(root, real, rewrite);
    if (refusal) return refusal;
  }
  // Only a forced add or a clone tracks it; one Git call, only when a journal exists.
  if (await gitOutput(root, ['ls-files', '--error-unmatch', '--', relative(root, path)]) !== undefined) return 'Git tracks it; a migration journal is never committed';
  return undefined;
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
