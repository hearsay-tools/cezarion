import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { readOwnedWorkspaceRecord, replaceOwnedWorkspaceRecord } from '../delegation/workspace.ts';
import type { WorktreeGit } from '../git-worktree-lock.ts';
import { pathPresent, projectMovedMarker, projectMoveMarked, realDirectory } from '../project-paths.ts';
import { forgetLegacyRunIds, LEGACY_RUNS_FILE, legacyItemOwner } from '../legacy-runs.ts';
import { RUNS_DB_FILE, RunDatabase, type RunRowInput } from '../runs/run-database.ts';
import { notRegularFile, outsideOf, receiptDirectory, runStoreFiles } from './containment.ts';
import { replaceAtomically, settle } from './durable.ts';
import type { PathRewrite, ProjectMigrationJournal, ProjectMigrationStep } from './journal.ts';
import { gitOutput, gitReportedPath, redirectedComponent, rewriteHandoffWorktreeLine, trackedPaths, valueAt } from './plan.ts';

/**
 * The steps of a project migration. Each one reads the state of every item first and applies only
 * what is still at its old value, so running a step again after a crash (effect done, mark not
 * written) changes nothing more. An item in neither the old nor the new state fails the step: the
 * journal stays and admission keeps the project blocked for recovery.
 */

/** A fault point: tests stop the migration here, as a crash would. */
export type MigrationFault = (point: string) => void;

export class ProjectMigrationStepError extends Error {
  constructor(step: ProjectMigrationStep, detail: string) {
    super(`Project migration step ${step} cannot continue: ${detail}. The journal stays; resume the migration after fixing it`);
    this.name = 'ProjectMigrationStepError';
  }
}

/** Refuse a write target outside `root` (or behind a directory that resolves elsewhere), checked
 *  right before the write; the journal was checked as a whole before any step. */
function contained(step: ProjectMigrationStep, root: string, path: string): void {
  const refusal = outsideOf(root, path);
  if (refusal) throw new ProjectMigrationStepError(step, refusal);
}

/** Refuse to open or rewrite in place anything but a regular file: never through a symlink. */
function regularFile(step: ProjectMigrationStep, path: string): void {
  const refusal = notRegularFile(path);
  if (refusal) throw new ProjectMigrationStepError(step, refusal);
}

type FieldRewrite = { field: readonly string[]; from: string; to: string };

/** Apply `rewrites` to `value`; true when something changed. A field at neither value refuses. */
function applyFields(step: ProjectMigrationStep, where: string, value: unknown, rewrites: readonly FieldRewrite[]): boolean {
  let changed = false;
  for (const rewrite of rewrites) {
    const current = valueAt(value, rewrite.field);
    if (current === rewrite.to) continue;
    if (current !== rewrite.from) throw new ProjectMigrationStepError(step, `${where} ${rewrite.field.join('.')} holds neither ${rewrite.from} nor ${rewrite.to}`);
    const parent = valueAt(value, rewrite.field.slice(0, -1)) as Record<string, unknown>;
    parent[rewrite.field.at(-1)!] = rewrite.to;
    changed = true;
  }
  return changed;
}

/** JSON in the layout it was read in: compact, or indented with the same width. */
function serializeLike(original: string, value: unknown): string {
  const indent = /^\{\r?\n( +)"/.exec(original)?.[1]?.length;
  return JSON.stringify(value, null, indent) + (original.endsWith('\n') ? '\n' : '');
}

/** Atomic replacement that keeps the file's permission bits; the caller settles it. */
function replaceKeepingMode(path: string, content: string): void {
  replaceAtomically(path, content, statSync(path).mode & 0o777);
}

/**
 * Create the missing directories from `root` down to `path`, each with the permission bits of its
 * counterpart under `sourceRoot` (private when it has none), so a move never exposes private data
 * through a new parent. The move that follows settles them.
 */
function createDirectories(root: string, sourceRoot: string, path: string): void {
  const parts = path === root ? [] : path.slice(root.length + 1).split(sep);
  let current = root;
  let counterpart = sourceRoot;
  for (const part of ['', ...parts]) {
    if (part) { current = join(current, part); counterpart = join(counterpart, part); }
    if (pathPresent(current)) continue;
    const mode = pathPresent(counterpart) ? statSync(counterpart).mode & 0o777 : 0o700;
    mkdirSync(current, { mode });
    chmodSync(current, mode);
  }
}

function byFile<T extends { file: string }>(rewrites: readonly T[]): Map<string, T[]> {
  const files = new Map<string, T[]>();
  for (const rewrite of rewrites) files.set(rewrite.file, [...files.get(rewrite.file) ?? [], rewrite]);
  return files;
}

/** Rename every planned item. Before the first rename, no planned item may hold a tracked path. */
async function moveStep(journal: ProjectMigrationJournal, fault: MigrationFault): Promise<void> {
  const tracked = await trackedPaths(journal.repoRoot);
  if (!tracked) throw new ProjectMigrationStepError('move', `Git cannot list the tracked files of ${journal.repoRoot}`);
  for (const move of journal.moves) {
    if (!pathPresent(move.from)) continue;
    const item = relative(journal.repoRoot, move.from).split(sep).join(posix.sep);
    if ([...tracked].some(path => path === item || path.startsWith(`${item}/`))) throw new ProjectMigrationStepError('move', `${move.from} now holds a tracked file`);
  }
  const root = dirname(journal.destination);
  for (const [index, move] of journal.moves.entries()) {
    const from = pathPresent(move.from);
    const to = pathPresent(move.to);
    if (from && to) throw new ProjectMigrationStepError('move', `both ${move.from} and ${move.to} exist`);
    if (!from && !to) throw new ProjectMigrationStepError('move', `${move.from} and ${move.to} are both missing`);
    if (from) {
      // Checked again here: a symlink placed after planning must not redirect the rename.
      const redirected = redirectedComponent(root, dirname(move.to)) ?? redirectedComponent(dirname(journal.source), dirname(move.from));
      if (redirected) throw new ProjectMigrationStepError('move', `${redirected} is not a directory of this project`);
      contained('move', journal.source, move.from);
      contained('move', journal.destination, move.to);
      createDirectories(journal.destination, journal.source, dirname(move.to));
      fault(`move:prepared:${index}`);
      renameSync(move.from, move.to);
      fault(`move:renamed:${index}`);
    }
    // Moved now or before a crash: both sides, with every directory created for it, become durable.
    settle(root, move.to);
    settle(root, move.from);
    fault(`move:item:${index}`);
  }
}

/** A worktree's administrative directory, from its `.git` link. */
function adminDirectory(worktree: string): string {
  return resolve(worktree, gitReportedPath(readFileSync(join(worktree, '.git'), 'utf8').replace(/^gitdir: /, '').trim()));
}

/** The registered worktrees, and the lock reason of each locked one ('' without one), by path in this platform's form. */
async function worktreeListing(journal: ProjectMigrationJournal, git: WorktreeGit): Promise<{ paths: Set<string>; locks: Map<string, string> }> {
  const listed = await git(journal.repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (!listed.ok) throw new ProjectMigrationStepError('lock-worktrees', `Git cannot list the worktrees of ${journal.repoRoot}`);
  const paths = new Set<string>();
  const locks = new Map<string, string>();
  let current: string | undefined;
  for (const entry of listed.stdout.split('\0')) {
    if (entry.startsWith('worktree ')) paths.add(current = gitReportedPath(entry.slice('worktree '.length)));
    else if (current && (entry === 'locked' || entry.startsWith('locked '))) locks.set(current, entry.slice('locked '.length));
  }
  return { paths, locks };
}

/** The lock reason that marks a worktree this migration locked; only those are unlocked again. */
export function migrationLockReason(journal: Pick<ProjectMigrationJournal, 'id'>): string {
  return `cezar project migration ${journal.id}`;
}

/**
 * Lock every worktree the move carries before it moves: between the move and the repair its old
 * path is missing, and a `git worktree prune` from any checkout sharing this Git directory would
 * delete an unlocked registration (its index included). A worktree the user locked keeps its lock.
 */
async function lockStep(journal: ProjectMigrationJournal, fault: MigrationFault, git?: WorktreeGit): Promise<void> {
  if (journal.worktrees.length === 0) return;
  const { locks } = await worktreeListing(journal, git!);
  for (const [index, worktree] of journal.worktrees.entries()) {
    const path = pathPresent(worktree.from) ? worktree.from : worktree.to;
    contained('lock-worktrees', path === worktree.from ? journal.source : journal.destination, path);
    if (!locks.has(worktree.from) && !locks.has(worktree.to)) {
      const locked = await git!(journal.repoRoot, ['worktree', 'lock', '--reason', migrationLockReason(journal), '--', path]);
      if (!locked.ok) throw new ProjectMigrationStepError('lock-worktrees', `git worktree lock ${path} failed: ${locked.stderr.trim()}`);
    }
    const admin = adminDirectory(path);
    settle(admin, join(admin, 'locked'), { data: true });
    fault(`lock-worktrees:item:${index}`);
  }
}

/** Point Git at each moved task worktree, prove it sees each one at its new path, then unlock what this migration locked. */
async function repairStep(journal: ProjectMigrationJournal, fault: MigrationFault, git?: WorktreeGit): Promise<void> {
  if (journal.worktrees.length === 0) return;
  const paths = journal.worktrees.map(worktree => worktree.to);
  for (const path of paths) contained('repair-worktrees', journal.destination, path);
  const repaired = await git!(journal.repoRoot, ['worktree', 'repair', '--', ...paths]);
  if (!repaired.ok) throw new ProjectMigrationStepError('repair-worktrees', `git worktree repair failed: ${repaired.stderr.trim()}`);
  const { paths: listed, locks } = await worktreeListing(journal, git!);
  for (const [index, path] of paths.entries()) {
    const real = realpathSync(path);
    const top = (await gitOutput(path, ['rev-parse', '--show-toplevel']))?.trim();
    if (!listed.has(path) && !listed.has(real) || !top || realpathSync(gitReportedPath(top)) !== real) {
      throw new ProjectMigrationStepError('repair-worktrees', `Git does not see the worktree ${path} after repair`);
    }
    // Git writes the links without an fsync; the unlock depends on them, so they settle first.
    const admin = adminDirectory(path);
    settle(path, join(path, '.git'), { data: true });
    settle(admin, join(admin, 'gitdir'), { data: true });
    if ((locks.get(path) ?? locks.get(real)) === migrationLockReason(journal)) {
      fault(`repair-worktrees:unlock:${index}`);
      const unlocked = await git!(journal.repoRoot, ['worktree', 'unlock', '--', path]);
      if (!unlocked.ok) throw new ProjectMigrationStepError('repair-worktrees', `git worktree unlock ${path} failed: ${unlocked.stderr.trim()}`);
    }
    settle(admin, join(admin, 'locked'));
    fault(`repair-worktrees:item:${index}`);
  }
}

async function receiptStep(journal: ProjectMigrationJournal, fault: MigrationFault): Promise<void> {
  const rewrites = journal.rewrites.filter((rewrite): rewrite is Extract<PathRewrite, { kind: 'receipt' | 'cleanup-checkpoint' }> =>
    rewrite.kind === 'receipt' || rewrite.kind === 'cleanup-checkpoint');
  const receipts = rewrites.length > 0 ? await receiptDirectory(journal.repoRoot) : '';
  let index = 0;
  for (const [file, fields] of byFile(rewrites)) {
    contained('receipts', receipts, file);
    regularFile('receipts', file);
    const text = await readOwnedWorkspaceRecord(file);
    const value: unknown = JSON.parse(text);
    if (applyFields('receipts', file, value, fields)) await replaceOwnedWorkspaceRecord(file, serializeLike(text, value));
    settle(dirname(file), file, { data: true });
    fault(`receipts:item:${index++}`);
  }
}

/** Every affected row in one run-store transaction; none when every field already holds its new value. */
function runStoreStep(journal: ProjectMigrationJournal, fault: MigrationFault): void {
  const rewrites = journal.rewrites.filter((rewrite): rewrite is Extract<PathRewrite, { kind: 'run-row' }> => rewrite.kind === 'run-row');
  if (rewrites.length === 0) return;
  const ids = [...new Set(rewrites.map(rewrite => rewrite.runId))];
  const path = join(journal.destination, RUNS_DB_FILE);
  contained('run-store', journal.destination, path);
  for (const file of runStoreFiles(journal.destination)) regularFile('run-store', file);
  // RunDatabase.open creates a missing database: refuse first, so no empty store shadows a lost one.
  if (!pathPresent(path)) throw new ProjectMigrationStepError('run-store', `the moved run store ${path} is missing`);
  const db = RunDatabase.open(path);
  try {
    const rows = new Map(db.getMany(ids).map(row => [row.id, row]));
    const upserts: RunRowInput[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) throw new ProjectMigrationStepError('run-store', `run ${id} is missing from the run store`);
      const data: unknown = JSON.parse(row.data);
      const summary: unknown = JSON.parse(row.summary);
      const column = { worktree_path: row.worktreePath };
      const mine = rewrites.filter(rewrite => rewrite.runId === id);
      const field = (rewrite: typeof mine[number], key: 'data' | 'summary') => key in rewrite.field
        ? [{ field: (rewrite.field as Record<typeof key, string[]>)[key], from: rewrite.from, to: rewrite.to }] : [];
      const changed = [
        applyFields('run-store', `run ${id} data`, data, mine.flatMap(rewrite => field(rewrite, 'data'))),
        applyFields('run-store', `run ${id} summary`, summary, mine.flatMap(rewrite => field(rewrite, 'summary'))),
        applyFields('run-store', `run ${id} column`, column, mine.flatMap(rewrite => 'column' in rewrite.field ? [{ field: ['worktree_path'], from: rewrite.from, to: rewrite.to }] : [])),
      ].some(Boolean);
      if (!changed) continue;
      const { seq: _seq, revision, ...input } = row;
      upserts.push({ ...input, worktreePath: column.worktree_path, data: serializeLike(row.data, data), summary: serializeLike(row.summary, summary),
        issueAttributionCurrent: db.getMeta(`issue-attribution:${id}`) === String(revision) });
    }
    if (upserts.length > 0) db.transaction({ upserts, deletes: [], beforeCommit: () => { fault('run-store:commit'); } });
  } finally { db.close(); }
  // The last connection's close checkpoints the WAL into the database and removes the WAL file.
  settle(dirname(journal.destination), path, { data: true });
}

/** File-backed evidence SQLite cannot transact: each file is replaced atomically on its own. */
function runFilesStep(journal: ProjectMigrationJournal, fault: MigrationFault): void {
  const rewrites = journal.rewrites.filter((rewrite): rewrite is Exclude<PathRewrite, { kind: 'run-row' | 'receipt' | 'cleanup-checkpoint' }> =>
    rewrite.kind !== 'run-row' && rewrite.kind !== 'receipt' && rewrite.kind !== 'cleanup-checkpoint');
  let index = 0;
  for (const [file, fields] of byFile(rewrites)) {
    // A kept task's own file stays in the old directory and is rewritten there.
    const kept = file.startsWith(join(journal.source, 'runs') + sep);
    contained('run-files', join(kept ? journal.source : journal.destination, 'runs'), file);
    regularFile('run-files', file);
    const text = readFileSync(file, 'utf8');
    let next = text;
    // Only the seeded worktree line, and only while it still names the old path: the agent may edit the file.
    for (const rewrite of fields) if (rewrite.kind === 'handoff') next = rewriteHandoffWorktreeLine(next, rewrite.from, rewrite.to);
    const json = fields.flatMap(rewrite => rewrite.kind === 'handoff' ? [] : [rewrite]);
    if (json.length > 0) {
      const value: unknown = JSON.parse(text);
      if (applyFields('run-files', file, value, json)) next = serializeLike(text, value);
    }
    if (next !== text) replaceKeepingMode(file, next);
    settle(dirname(journal.destination), file, { data: true });
    fault(`run-files:item:${index++}`);
  }
}

/**
 * Remove the directories under `directory` (at `parts` below the old directory) that the move left
 * empty, deepest first: never a kept task's item, never a directory that still holds anything,
 * never through a symlink. A directory something else fills in the meantime stays.
 */
function pruneEmptied(directory: string, parts: readonly string[], keep: ReadonlySet<string>, top: boolean): void {
  for (const name of readdirSync(directory)) {
    if (top && name.startsWith('cockpit.lock')) continue;
    const path = join(directory, name);
    if (!realDirectory(path) || legacyItemOwner([...parts, name], keep)) continue;
    pruneEmptied(path, [...parts, name], keep, false);
    try { rmdirSync(path); } catch { /* not empty: it stays */ }
  }
}

/**
 * Name the kept tasks (live or not archived) whose own items stay in the old directory (`legacy-runs.ts`), in the new
 * one, then remove the old directories the move emptied; no task left removes the file. Written
 * before the mark, so the project is never marked moved while a task's items resolve elsewhere.
 */
function leftoversStep(journal: ProjectMigrationJournal): void {
  const keep = new Set(journal.leftovers ?? []);
  const file = join(journal.destination, LEGACY_RUNS_FILE);
  contained('leftovers', journal.destination, file);
  regularFile('leftovers', file);
  if (keep.size > 0) {
    createDirectories(journal.destination, journal.source, journal.destination);
    replaceAtomically(file, `${JSON.stringify({ version: 1, runs: [...keep].sort() }, null, 2)}\n`, 0o600);
  } else rmSync(file, { force: true });
  forgetLegacyRunIds(journal.destination);
  // With nothing moved and no task kept, the new directory may not exist: nothing was written there.
  if (pathPresent(journal.destination)) settle(dirname(journal.destination), file, { data: keep.size > 0 });
  if (realDirectory(journal.source)) {
    pruneEmptied(journal.source, [], keep, true);
    // Nothing left at all, not even an ownership claim: the old directory itself goes.
    try { rmdirSync(journal.source); } catch { /* not empty: it stays */ }
  }
  settle(dirname(journal.destination), journal.source);
}

/**
 * The durable mark that the project is moved (`projectMovedMarker`: in the Git common directory,
 * naming the project's real root), written once every other step is done and settled before the
 * journal goes. From then on, with the release switch on, `projectPaths` writes `.ai/squawk/`.
 */
function markMovedStep(journal: ProjectMigrationJournal): void {
  const marker = projectMovedMarker(journal.repoRoot);
  if (!marker || marker.root !== journal.repoRoot) throw new ProjectMigrationStepError('mark-moved', `cannot find the Git directory of ${journal.repoRoot}`);
  const directory = dirname(marker.path);
  if (!pathPresent(directory)) mkdirSync(directory, { mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new ProjectMigrationStepError('mark-moved', `${directory} is not a directory`);
  regularFile('mark-moved', marker.path);
  if (!projectMoveMarked(journal.repoRoot)) {
    replaceAtomically(marker.path, `${JSON.stringify({ version: 1, root: marker.root, from: journal.source }, null, 2)}\n`, 0o600);
  }
  settle(dirname(directory), marker.path, { data: true });
}

/** The steps that run inside one hold of the Git common directory's worktree mutation lock. */
export const GIT_MIGRATION_STEPS: readonly ProjectMigrationStep[] = ['lock-worktrees', 'move', 'repair-worktrees'];

export const MIGRATION_STEP_RUNNERS: Record<ProjectMigrationStep, (journal: ProjectMigrationJournal, fault: MigrationFault, git?: WorktreeGit) => Promise<void> | void> = {
  'lock-worktrees': lockStep,
  move: moveStep,
  'repair-worktrees': repairStep,
  receipts: receiptStep,
  'run-store': runStoreStep,
  'run-files': runFilesStep,
  leftovers: leftoversStep,
  'mark-moved': markMovedStep,
};
