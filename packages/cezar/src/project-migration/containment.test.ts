import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { defaultServeDeps, serveCommand, type ServeDeps } from '../serve-command.ts';
import { CockpitOwnership } from '../server/cockpit-ownership.ts';
import { MAX_JOURNAL_BYTES, ProjectMigrationJournalRefusedError } from './containment.ts';
import { resumeProjectMigration } from './engine.ts';
import { PROJECT_MIGRATION_STEPS, writeProjectMigrationJournal, type PathRewrite, type ProjectMigrationJournal } from './journal.ts';
import { writeSettledJournal } from './project-migration.testkit.ts';
import { ProjectMigrationRecoveryError, recoverProjectMigration } from './recovery.ts';
import { MIGRATION_STEP_RUNNERS, ProjectMigrationStepError } from './steps.ts';

/**
 * A migration journal is untrusted input (hearsay-tools/cezarion#3089): a resume refuses one that
 * names anything outside the project's own state before any step runs, and each step checks its
 * write target again before it writes. A repository can commit a journal, so automatic recovery
 * must never write outside the project because of one.
 */

const temporary: string[] = [];
const owners: CockpitOwnership[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.releaseAll();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

/** A Git project whose state already moved, and a user file elsewhere holding the expected value. */
function project() {
  const root = directory('cez-containment-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  mkdirSync(join(root, '.ai/squawk/runs'), { recursive: true });
  const outside = directory('cez-containment-outside-');
  return { root, outside, journal: join(root, '.ai/squawk-migration.json') };
}

/** The first five steps done; only the run-files step with `rewrite` is left. */
function journalWith(root: string, rewrite: PathRewrite): ProjectMigrationJournal {
  return { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), repoRoot: root, source: join(root, '.ai/cezar'),
    destination: join(root, '.ai/squawk'), done: PROJECT_MIGRATION_STEPS.slice(0, 5), moves: [], tracked: [], worktrees: [], rewrites: [rewrite] };
}

/** A user file that holds `value` in its `value` field. */
function userFile(path: string, value: string): { path: string; bytes: string } {
  const bytes = `${JSON.stringify({ value })}\n`;
  writeFileSync(path, bytes);
  return { path, bytes };
}

async function resume(root: string) {
  const ownership = new CockpitOwnership();
  owners.push(ownership);
  const fence = await ownership.fenceProject(join(root, '.ai/cezar'), { liveTasks: () => [] });
  // Released as a CLI's exit releases it.
  try { return await resumeProjectMigration({ repoRoot: root, fence }); } finally { fence.release(); ownership.releaseAll(); }
}

describe('a migration journal that names a path outside the project', () => {
  it('is refused before any step: the outside file stays byte for byte and the journal stays', async () => {
    const { root, outside, journal } = project();
    // The reviewer's journal: an absolute file anywhere, any values.
    const plain = userFile(join(outside, 'outside-project.json'), '/old');
    writeProjectMigrationJournal(journal, journalWith(root, { kind: 'artifact-metadata', file: plain.path, field: ['value'], from: '/old', to: '/new' }));
    await expect(resume(root)).rejects.toThrow(new ProjectMigrationJournalRefusedError(journal, `${plain.path} is not inside ${join(root, '.ai/squawk/runs')}`));
    // The same file with values a real migration would write.
    const valued = userFile(plain.path, join(root, '.ai/cezar/worktrees/x'));
    writeProjectMigrationJournal(journal, journalWith(root, { kind: 'artifact-metadata', file: valued.path, field: ['value'], from: join(root, '.ai/cezar/worktrees/x'), to: join(root, '.ai/squawk/worktrees/x') }));
    await expect(resume(root)).rejects.toBeInstanceOf(ProjectMigrationJournalRefusedError);
    expect(readFileSync(valued.path, 'utf8')).toBe(valued.bytes);
    expect(existsSync(journal)).toBe(true);
  });

  it('is refused through a symlinked directory inside the project that points outside', async () => {
    const { root, outside, journal } = project();
    symlinkSync(outside, join(root, '.ai/squawk/runs/escape'));
    const from = join(root, '.ai/cezar/worktrees/x');
    const user = userFile(join(outside, 'metadata.json'), from);
    const file = join(root, '.ai/squawk/runs/escape/metadata.json');
    writeProjectMigrationJournal(journal, journalWith(root, { kind: 'artifact-metadata', file, field: ['value'], from, to: join(root, '.ai/squawk/worktrees/x') }));
    await expect(resume(root)).rejects.toThrow(`${join(root, '.ai/squawk/runs/escape')} resolves to ${outside}, outside the project`);
    expect(readFileSync(user.path, 'utf8')).toBe(user.bytes);
  });

  it('is refused by the step itself, before it writes, when a step runs without the journal check', () => {
    const { root, outside } = project();
    symlinkSync(outside, join(root, '.ai/squawk/runs/escape'));
    const from = join(root, '.ai/cezar/worktrees/x');
    const user = userFile(join(outside, 'metadata.json'), from);
    const journal = journalWith(root, { kind: 'artifact-metadata', file: join(root, '.ai/squawk/runs/escape/metadata.json'), field: ['value'], from, to: join(root, '.ai/squawk/worktrees/x') });
    expect(() => MIGRATION_STEP_RUNNERS['run-files'](journal, () => undefined)).toThrow(ProjectMigrationStepError);
    expect(readFileSync(user.path, 'utf8')).toBe(user.bytes);
  });

  it('keeps cockpit boot from starting, with the refusal as its cause, and writes nothing outside', async () => {
    const { root, outside, journal } = project();
    const user = userFile(join(outside, 'outside-project.json'), '/old');
    writeProjectMigrationJournal(journal, journalWith(root, { kind: 'artifact-metadata', file: user.path, field: ['value'], from: '/old', to: '/new' }));
    const listener = vi.fn().mockRejectedValue(new Error('listener reached'));
    const process = new EventEmitter();
    const boot = serveCommand(testHome(), root, 0, false, undefined, false, { ...defaultServeDeps, acquireServeListener: listener, process } as unknown as ServeDeps)
      .finally(() => process.emit('exit'));
    await expect(boot).rejects.toBeInstanceOf(ProjectMigrationRecoveryError);
    await expect(boot).rejects.toThrow(/is refused: .* is not inside .*\. Nothing was changed\./);
    expect(listener).not.toHaveBeenCalled();
    expect(readFileSync(user.path, 'utf8')).toBe(user.bytes);
    expect(existsSync(journal)).toBe(true);
  });

  it('refuses a run store that is a symlink: the journal check and the run-store step leave the target unchanged', async () => {
    const { root, outside, journal } = project();
    // Another SQLite database, which RunDatabase.open would switch to WAL and migrate.
    const external = join(outside, 'other.db');
    const db = new DatabaseSync(external);
    db.exec('CREATE TABLE kept (x)');
    db.close();
    const bytes = readFileSync(external);
    symlinkSync(external, join(root, '.ai/squawk/runs.db'));
    const paused: ProjectMigrationJournal = { ...journalWith(root, { kind: 'run-row', runId: 'r', field: { column: 'worktree_path' },
      from: join(root, '.ai/cezar/worktrees/x'), to: join(root, '.ai/squawk/worktrees/x') }), done: PROJECT_MIGRATION_STEPS.slice(0, 4) };
    writeProjectMigrationJournal(journal, paused);
    await expect(resume(root)).rejects.toThrow(new ProjectMigrationJournalRefusedError(journal, `${join(root, '.ai/squawk/runs.db')} is a symbolic link`));
    expect(() => MIGRATION_STEP_RUNNERS['run-store'](paused, () => undefined)).toThrow(ProjectMigrationStepError);
    expect(readFileSync(external)).toEqual(bytes);
    expect(readdirSync(outside).sort()).toEqual(['other.db']);
  });

  it('refuses a committed symlink journal and an oversized journal without reading them', async () => {
    const { root, outside, journal } = project();
    // A valid journal outside the project, reached through a committed symlink.
    const target = writeSettledJournal(root);
    renameSync(target, join(outside, 'journal.json'));
    symlinkSync(join(outside, 'journal.json'), journal);
    execFileSync('git', ['add', '-f', '.ai/squawk-migration.json'], { cwd: root });
    await expect(resume(root)).rejects.toThrow(new ProjectMigrationJournalRefusedError(journal, `${journal} is a symbolic link`));
    // The automatic entries take the same refusal.
    await expect(recoverProjectMigration(root)).rejects.toThrow(`${journal} is a symbolic link`);
    expect(lstatSync(journal).isSymbolicLink()).toBe(true);
    execFileSync('git', ['rm', '-q', '--cached', '.ai/squawk-migration.json'], { cwd: root });
    rmSync(journal);
    // A sparse file one byte over the bound: refused from its size.
    writeFileSync(journal, '');
    truncateSync(journal, MAX_JOURNAL_BYTES + 1);
    await expect(resume(root)).rejects.toThrow(new ProjectMigrationJournalRefusedError(journal, `it is larger than ${MAX_JOURNAL_BYTES} bytes`));
    expect(statSync(journal).size).toBe(MAX_JOURNAL_BYTES + 1);
  });

  it('checks Git tracking at the canonical journal path, also through a symlinked root, and refuses when Git cannot answer', async () => {
    const { root } = project();
    const journal = writeSettledJournal(root);
    execFileSync('git', ['add', '-f', '.ai/squawk-migration.json'], { cwd: root });
    const linked = join(directory('cez-containment-link-'), 'repo');
    symlinkSync(root, linked);
    await expect(resume(linked)).rejects.toThrow('Git tracks it; a migration journal is never committed');
    execFileSync('git', ['rm', '-q', '--cached', '.ai/squawk-migration.json'], { cwd: root });
    // A repository Git cannot read: the check cannot finish, so the journal is refused.
    renameSync(join(root, '.git'), join(root, '.git-moved'));
    writeFileSync(join(root, '.git'), 'not a gitfile\n');
    await expect(resume(root)).rejects.toThrow(/is refused: Git could not tell whether it tracks the journal/);
    expect(existsSync(journal)).toBe(true);
  });

  it('refuses a journal that Git tracks, even one with nothing left to apply', async () => {
    const { root } = project();
    const journal = writeSettledJournal(root);
    execFileSync('git', ['add', '-f', '.ai/squawk-migration.json'], { cwd: root });
    await expect(resume(root)).rejects.toThrow(new ProjectMigrationJournalRefusedError(journal, 'Git tracks it; a migration journal is never committed'));
    expect(existsSync(journal)).toBe(true);
  });
});
