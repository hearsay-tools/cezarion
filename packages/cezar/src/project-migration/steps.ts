import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { readOwnedWorkspaceRecord, replaceOwnedWorkspaceRecord } from '../delegation/workspace.ts';
import { withWorktreeMutation } from '../git-worktree-lock.ts';
import { syncDirectory } from '../home/private-files.ts';
import { pathPresent } from '../project-paths.ts';
import { RUNS_DB_FILE, RunDatabase, type RunRowInput } from '../runs/run-database.ts';
import type { PathRewrite, ProjectMigrationJournal, ProjectMigrationStep } from './journal.ts';
import { gitOutput, rewriteHandoffWorktreeLine, trackedPaths, valueAt } from './plan.ts';

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

/** Durable atomic replacement that keeps the file's permission bits. */
function replaceKeepingMode(path: string, content: string): void {
  const mode = statSync(path).mode & 0o777;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    try { fchmodSync(fd, mode); writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
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
  for (const [index, move] of journal.moves.entries()) {
    const from = pathPresent(move.from);
    const to = pathPresent(move.to);
    if (!from && to) continue;
    if (from && to) throw new ProjectMigrationStepError('move', `both ${move.from} and ${move.to} exist`);
    if (!from) throw new ProjectMigrationStepError('move', `${move.from} and ${move.to} are both missing`);
    mkdirSync(dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
    syncDirectory(dirname(move.to));
    syncDirectory(dirname(move.from));
    fault(`move:item:${index}`);
  }
}

/** Point Git at each moved task worktree, then prove it sees each one at its new path. */
async function repairStep(journal: ProjectMigrationJournal): Promise<void> {
  if (journal.worktrees.length === 0) return;
  const paths = journal.worktrees.map(worktree => worktree.to);
  const repaired = await withWorktreeMutation(journal.repoRoot, git => git(journal.repoRoot, ['worktree', 'repair', '--', ...paths]));
  if (!repaired.ok) throw new ProjectMigrationStepError('repair-worktrees', `git worktree repair failed: ${repaired.stderr.trim()}`);
  const listed = (await gitOutput(journal.repoRoot, ['worktree', 'list', '--porcelain', '-z']))?.split('\0') ?? [];
  for (const path of paths) {
    const real = realpathSync(path);
    const top = (await gitOutput(path, ['rev-parse', '--show-toplevel']))?.trim();
    if (!listed.includes(`worktree ${path}`) && !listed.includes(`worktree ${real}`) || !top || realpathSync(top) !== real) {
      throw new ProjectMigrationStepError('repair-worktrees', `Git does not see the worktree ${path} after repair`);
    }
  }
}

async function receiptStep(journal: ProjectMigrationJournal, fault: MigrationFault): Promise<void> {
  const rewrites = journal.rewrites.filter((rewrite): rewrite is Extract<PathRewrite, { kind: 'receipt' | 'cleanup-checkpoint' }> =>
    rewrite.kind === 'receipt' || rewrite.kind === 'cleanup-checkpoint');
  let index = 0;
  for (const [file, fields] of byFile(rewrites)) {
    const text = await readOwnedWorkspaceRecord(file);
    const value: unknown = JSON.parse(text);
    if (applyFields('receipts', file, value, fields)) await replaceOwnedWorkspaceRecord(file, serializeLike(text, value));
    fault(`receipts:item:${index++}`);
  }
}

/** Every affected row in one run-store transaction; none when every field already holds its new value. */
function runStoreStep(journal: ProjectMigrationJournal, fault: MigrationFault): void {
  const rewrites = journal.rewrites.filter((rewrite): rewrite is Extract<PathRewrite, { kind: 'run-row' }> => rewrite.kind === 'run-row');
  if (rewrites.length === 0) return;
  const ids = [...new Set(rewrites.map(rewrite => rewrite.runId))];
  const db = RunDatabase.open(join(journal.destination, RUNS_DB_FILE));
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
}

/** File-backed evidence SQLite cannot transact: each file is replaced atomically on its own. */
function runFilesStep(journal: ProjectMigrationJournal, fault: MigrationFault): void {
  const rewrites = journal.rewrites.filter((rewrite): rewrite is Exclude<PathRewrite, { kind: 'run-row' | 'receipt' | 'cleanup-checkpoint' }> =>
    rewrite.kind !== 'run-row' && rewrite.kind !== 'receipt' && rewrite.kind !== 'cleanup-checkpoint');
  let index = 0;
  for (const [file, fields] of byFile(rewrites)) {
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
    fault(`run-files:item:${index++}`);
  }
}

export const MIGRATION_STEP_RUNNERS: Record<ProjectMigrationStep, (journal: ProjectMigrationJournal, fault: MigrationFault) => Promise<void> | void> = {
  move: moveStep,
  'repair-worktrees': repairStep,
  receipts: receiptStep,
  'run-store': runStoreStep,
  'run-files': runFilesStep,
};
