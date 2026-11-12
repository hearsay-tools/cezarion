import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { projectAdmissionRefusal } from '../server/cockpit-ownership.ts';
import { migrateProject, resumeProjectMigration } from './engine.ts';
import { Crash, crashAt, fence, migrate, moved, TIMEOUT } from './engine.testkit.ts';
import { readProjectMigrationJournal } from './journal.ts';
import { ProjectMigrationStepError } from './steps.ts';
import { buildMigrationProject, git, removeMigrationProject, type MigrationProject } from './project-migration.testkit.ts';

/** The fence holder's side of the project migration engine (hearsay-tools/cezarion#3088): a step
 *  that stops on an unexpected value, a redirect placed after planning, directory modes, worktree
 *  locks the user set. */
/** A real cleanup checkpoint: the removal stops right after writing it, with the worktree in place. */
async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

describe('the holder', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });

  it('stops with the journal in place when an item holds neither its old nor its new value', async () => {
    project.restore();
    const crashed = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt('receipts:before') })).rejects.toThrow(Crash);
    crashed.release();
    const receipt = join(git(project.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'cezar-owned-workspaces', `${project.worker.resourceId}.json`);
    const text = readFileSync(receipt, 'utf8');
    writeFileSync(receipt, text.replace(project.worker.path, '/somewhere/else'));
    const recovery = await fence(project);
    try {
      await expect(resumeProjectMigration({ repoRoot: project.root, fence: recovery })).rejects.toBeInstanceOf(ProjectMigrationStepError);
    } finally { recovery.release(); }
    expect(readProjectMigrationJournal(join(project.root, '.ai/squawk-migration.json'))?.done).toEqual(['lock-worktrees', 'move', 'repair-worktrees']);
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('refuses to open a moved run store that is gone, and creates none', async () => {
    project.restore();
    const crashed = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt('run-store:before') })).rejects.toThrow(Crash);
    crashed.release();
    rmSync(join(project.newDir, RUNS_DB_FILE));
    const recovery = await fence(project);
    try {
      await expect(resumeProjectMigration({ repoRoot: project.root, fence: recovery })).rejects.toThrow(/the moved run store .* is missing/);
    } finally { recovery.release(); }
    expect(existsSync(join(project.newDir, RUNS_DB_FILE))).toBe(false);
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('refuses a symlink that appears on a destination path between the plan and the move', async () => {
    project.restore();
    const outside = join(project.base, 'outside');
    mkdirSync(outside, { recursive: true });
    const held = await fence(project);
    const plant = (at: string) => { if (at === 'move:before') { mkdirSync(project.newDir, { recursive: true }); symlinkSync(outside, join(project.newDir, 'workflows')); } };
    try {
      await expect(migrateProject({ repoRoot: project.root, fence: held, fault: plant })).rejects.toThrow(/workflows is not a directory of this project/);
    } finally { held.release(); }
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(project.dataDir, 'workflows/local.yaml'))).toBe(true);
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('creates new parents with the permission bits of their source counterparts and keeps moved items\' bits', async () => {
    project.restore();
    chmodSync(project.dataDir, 0o750);
    chmodSync(join(project.dataDir, 'workflows'), 0o700);
    chmodSync(join(project.dataDir, 'runs'), 0o700);
    await migrate(project);
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(project.newDir)).toBe(0o750);
    expect(mode(join(project.newDir, 'workflows'))).toBe(0o700);
    expect(mode(join(project.newDir, 'runs'))).toBe(0o700);
  });

  it('keeps a lock the user set, and unlocks only the worktrees the migration locked', async () => {
    project.restore();
    git(project.root, 'worktree', 'lock', '--reason', 'mine, keep it', project.taskPath);
    await migrate(project);
    const listed = git(project.root, 'worktree', 'list', '--porcelain');
    expect(listed).toContain(`worktree ${moved(project, project.taskPath)}\nHEAD`);
    expect(listed.match(/^locked.*$/gm)).toEqual(['locked mine, keep it']);
    expect(listed.split('\n\n').find(record => record.startsWith(`worktree ${moved(project, project.taskPath)}\n`))).toContain('locked mine, keep it');
  });
});
