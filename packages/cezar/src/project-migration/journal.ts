import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { runIdParamSchema } from '@open-mercato/cezar-contract/events';
import { replaceAtomically, settle } from './durable.ts';

/**
 * The project migration journal, `<root>/.ai/squawk-migration.json` (P4b1's
 * `MIGRATION_JOURNAL_FILE`). It sits beside both directory names, so no move carries it. It holds
 * the whole plan: every move, every repair and every old-to-new path rewrite. Each step marks
 * itself done here after its effect; a resume runs the steps not marked done and every step
 * checks each item's state first, so a crash between an effect and its mark never applies a
 * rewrite twice. While the file exists, P4b1's admission refuses the project to everyone but the
 * fence holder.
 */

/**
 * `leftovers` writes which kept tasks (live or not archived) keep their own items in `.ai/cezar/` (`legacy-runs.ts`) and
 * removes the old directories the move emptied. `mark-moved` is last: from its marker on,
 * `projectPaths` writes the project under `.ai/squawk/`.
 */
export const PROJECT_MIGRATION_STEPS = ['lock-worktrees', 'move', 'repair-worktrees', 'receipts', 'run-store', 'run-files', 'leftovers', 'mark-moved'] as const;
export type ProjectMigrationStep = typeof PROJECT_MIGRATION_STEPS[number];

const absolute = z.string().min(1).refine(path => path.startsWith('/') || /^[a-z]:[\\/]/i.test(path), 'absolute path');
const pathChange = { from: absolute, to: absolute };

/** One runtime item renamed from the legacy directory into the new one. */
export const migrationMoveSchema = z.object({ ...pathChange, kind: z.enum(['file', 'directory', 'symlink', 'other']) }).strict();
/** A tracked file: never moved; the user runs the printed `git mv`. Paths relative to the repo root. */
export const trackedFileSchema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
/** A registered task worktree that the move carried: `git worktree repair` points Git at its new path. */
export const worktreeRepairSchema = z.object({ ...pathChange }).strict();

/** Where a stored path lives: a JSON field of a file, a field of a run row, or the handoff's worktree line. */
export const pathRewriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['receipt', 'cleanup-checkpoint', 'worker-execution', 'autosave-cleanup', 'worker-result', 'artifact-metadata']), file: absolute,
    field: z.array(z.string().min(1)).min(1), ...pathChange }).strict(),
  z.object({ kind: z.literal('handoff'), file: absolute, ...pathChange }).strict(),
  z.object({ kind: z.literal('run-row'), runId: z.string().min(1),
    field: z.union([z.object({ data: z.array(z.string().min(1)).min(1) }).strict(),
      z.object({ summary: z.array(z.string().min(1)).min(1) }).strict(),
      z.object({ column: z.literal('worktree_path') }).strict()]), ...pathChange }).strict(),
]);
export type PathRewrite = z.infer<typeof pathRewriteSchema>;

export const projectMigrationJournalSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  repoRoot: absolute,
  source: absolute,
  destination: absolute,
  done: z.array(z.enum(PROJECT_MIGRATION_STEPS)),
  moves: z.array(migrationMoveSchema),
  tracked: z.array(trackedFileSchema),
  worktrees: z.array(worktreeRepairSchema),
  rewrites: z.array(pathRewriteSchema),
  /** The kept tasks (live or not archived) whose own items stay in `source`; absent in a journal of an older build: none. */
  leftovers: z.array(runIdParamSchema.shape.id).optional(),
}).strict();
export type ProjectMigrationJournal = z.infer<typeof projectMigrationJournalSchema>;

export function readProjectMigrationJournal(path: string): ProjectMigrationJournal | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return projectMigrationJournalSchema.parse(JSON.parse(text));
}

/** Durable, atomic, private replacement, settled before the caller goes on. */
export function writeProjectMigrationJournal(path: string, journal: ProjectMigrationJournal): void {
  replaceAtomically(path, `${JSON.stringify(projectMigrationJournalSchema.parse(journal), null, 2)}\n`, 0o600);
  settle(dirname(path), path, { data: true });
}

/** The last step: the project is admitted again once this file is gone. */
export function removeProjectMigrationJournal(path: string): void {
  rmSync(path, { force: true });
  settle(dirname(path), path);
}
