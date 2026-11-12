import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
const release = vi.hoisted(() => ({ enabled: true }));
vi.mock('../home/switch.ts', () => ({ get REBRAND_SWITCH() { return release.enabled; } }));
import { ensureDataGitignore } from '../data-gitignore.ts';
import { createRunner } from '../core/runner-factory.ts';
import { createOwnedWorkspace, removeOwnedWorkspace } from '../delegation/workspace.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { CockpitOwnership } from '../server/cockpit-ownership.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { worktreePathFor } from '../git-worktree.ts';
import { fallbackProjectWriteError, projectMovedMarker, projectMoveMarked, projectPaths } from '../project-paths.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { migrationAnswer, migrationAnswerText } from './answer.ts';
import { moveProjectWhenIdle } from './auto.ts';
import { crashAt, fence, migrate, moved, TIMEOUT } from './engine.testkit.ts';
import { migrateProject, resumeProjectMigration } from './engine.ts';
import { planProjectMigration } from './plan.ts';
import { buildMigrationProject, git, projectSnapshot, removeMigrationProject, TASK, WORKER, type MigrationProject } from './project-migration.testkit.ts';
import { createRunManager } from '../server/run-manager.testkit.ts';

/**
 * The write root of a moved project (hearsay-tools/cezarion#3150), with the release switch on
 * through the test seam: the completed migration's marker makes `projectPaths` write `.ai/squawk/`
 * and read `.ai/cezar/` as the fallback; an unmoved project keeps writing `.ai/cezar/`.
 */

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

/** A new task, written where the product writes it: the store at `projectPaths(root).write`. */
function newTask(root: string): string {
  const store = RunStore.open(projectPaths(root).write, { keepLive: true });
  try {
    const run = store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] });
    // Settled, as a task that finished before the next start: a live one would block a move.
    setRunStatus(store, run.id, 'review');
    store.flush();
    expect(store.sourceDataDir(run.id)).toBe(projectPaths(root).write);
    return run.id;
  } finally { store.close(); }
}

describe('a moved project with the release switch on', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });
  const savedHome = process.env.CEZ_HOME;
  const homes: string[] = [];
  beforeEach(() => {
    project.restore();
    release.enabled = true;
    homes.push(mkdtempSync(join(realpathSync(tmpdir()), 'cez-moved-project-home-')));
    useTestHome(Home.sandbox(homes.at(-1)!));
  });
  afterEach(() => {
    useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('writes a new task to .ai/squawk/runs.db and creates no .ai/cezar/runs.db', async () => {
    await migrate(project);
    expect(projectMoveMarked(project.root)).toBe(true);
    expect(projectPaths(project.root)).toEqual({ write: project.newDir, reads: [project.newDir, project.dataDir] });
    newTask(project.root);
    expect(existsSync(join(project.newDir, RUNS_DB_FILE))).toBe(true);
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
    expect(worktreePathFor(project.root, TASK)).toBe(join(project.newDir, 'worktrees', TASK));
  });

  it('continues a moved task without adoption, and delegation and preview write under .ai/squawk/', async () => {
    await migrate(project);
    const store = RunStore.open(projectPaths(project.root).write, { keepLive: true });
    try {
      expect(store.isFallbackRun(TASK)).toBe(false);
      expect(store.runOwnership(TASK)).not.toBe('fallback');
      expect(store.writeRefusal(TASK)).toBeUndefined();
      expect(store.updateRun(TASK, { title: 'continued' })?.title).toBe('continued');
      store.flush();
      // The preview host's check: the moved worktree and the run are both writable.
      const worktree = store.getRun(TASK)!.worktreePath!;
      expect(worktree).toBe(moved(project, project.taskPath));
      expect(fallbackProjectWriteError(worktree) ?? store.writeRefusal(TASK)).toBeUndefined();
      expect(fallbackProjectWriteError(store.getRun(WORKER)!.worktreePath!)).toBeUndefined();
    } finally { store.close(); }
    // `.ai/cezar/` is the fallback now: a write there is refused.
    expect(fallbackProjectWriteError(join(project.dataDir, 'worktrees', TASK))).toMatch(/Cannot write read-only project data/);
    // A new worker workspace is provisioned under the write root.
    const worker = await createOwnedWorkspace(project.root, '70000000-0000-4000-8000-000000000007', git(project.root, 'rev-parse', 'HEAD'));
    expect(worker.path).toBe(join(project.newDir, 'worktrees', worker.ownerRunId));
    expect(existsSync(join(worker.path, '.git'))).toBe(true);
    expect(existsSync(join(project.dataDir, 'worktrees'))).toBe(false);
  });

  it('answers a second move of a moved project as a no-op, not a destination conflict', async () => {
    await migrate(project);
    newTask(project.root);
    const before = projectSnapshot(project);
    const again = await migrate(project);
    expect(again.alreadyMoved).toBe(true);
    expect(projectSnapshot(project)).toEqual(before);
    expect(existsSync(join(project.root, '.ai/squawk-migration.json'))).toBe(false);
    const text = migrationAnswerText(migrationAnswer(again));
    expect(text).toContain('Already moved: a completed migration marked this project');
    expect(text).toContain("git mv -- '.ai/cezar/workflows/flow.yaml' '.ai/squawk/workflows/flow.yaml'");
    expect(text.endsWith('The project was already moved; nothing changed. Run the git mv commands above and commit them.')).toBe(true);
  });

  it('keeps an unmoved project writing .ai/cezar/ until its move, which then completes cleanly', async () => {
    expect(projectPaths(project.root).write).toBe(project.dataDir);
    const before = newTask(project.root);
    expect(existsSync(join(project.newDir, RUNS_DB_FILE))).toBe(false);
    const result = await migrate(project);
    expect(result.alreadyMoved).toBe(false);
    expect(result.journal.moves.map(move => move.from)).toContain(join(project.dataDir, RUNS_DB_FILE));
    expect(projectPaths(project.root).write).toBe(project.newDir);
    const after = newTask(project.root);
    const store = RunStore.open(projectPaths(project.root).write, { keepLive: true });
    try {
      expect(store.writeRefusal(before)).toBeUndefined();
      expect(store.getRun(after)).toBeDefined();
    } finally { store.close(); }
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
  });

  it('moves an unmoved project at its first idle open, writes the context to .ai/squawk/, and skips a marked one', async () => {
    newTask(project.root);
    const ownership = new CockpitOwnership();
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), ownership, listProjects: async () => [{ id: 'p', root: project.root, status: 'ok' as const }] });
    try {
      const context = await contexts.context('p');
      expect(projectMoveMarked(project.root)).toBe(true);
      expect(context.dataDir).toBe(project.newDir);
      const run = context.store.createRun({ title: 'after', task: 'after', workflow: 'quick-task', steps: [] });
      context.store.flush();
      expect(context.store.sourceDataDir(run.id)).toBe(project.newDir);
      expect(context.store.writeRefusal(TASK)).toBeUndefined();
    } finally { contexts.disposeAll(); ownership.releaseAll(); }
    expect(existsSync(join(project.dataDir, RUNS_DB_FILE))).toBe(false);
    // The next cockpit run finds the marker: nothing to move, no plan, no journal.
    const next = new CockpitOwnership();
    try { expect(await moveProjectWhenIdle(project.root, { ownership: next, homes: [testHome()] })).toEqual({ status: 'nothing' }); }
    finally { next.releaseAll(); }
  });

  it('never counts a marker a repository can ship or forge, and still moves the project', async () => {
    // A committed marker where an earlier design kept it, and a forged one naming another root.
    mkdirSync(join(project.newDir), { recursive: true });
    writeFileSync(join(project.newDir, 'moved.json'), '{}\n');
    git(project.root, 'add', '-f', '.ai/squawk/moved.json');
    git(project.root, 'commit', '-qm', 'ship a marker');
    const marker = projectMovedMarker(project.root)!;
    expect(dirname(dirname(marker.path))).toBe(realpathSync(join(project.root, '.git')));
    mkdirSync(dirname(marker.path), { recursive: true });
    writeFileSync(marker.path, `${JSON.stringify({ version: 1, root: '/elsewhere' })}\n`);
    expect(projectMoveMarked(project.root)).toBe(false);
    expect(projectPaths(project.root).write).toBe(project.dataDir);
    expect((await planProjectMigration(project.root)).alreadyMoved).toBe(false);
    const ownership = new CockpitOwnership();
    try { expect((await moveProjectWhenIdle(project.root, { ownership, homes: [testHome()] })).status).toBe('moved'); }
    finally { ownership.releaseAll(); }
    expect(projectMoveMarked(project.root)).toBe(true);
    expect(JSON.parse(readFileSync(marker.path, 'utf8'))).toMatchObject({ root: realpathSync(project.root) });
    expect(projectPaths(project.root).write).toBe(project.newDir);
  });

  it('keys the marker by the project root, so a linked checkout of the same repository has its own', () => {
    const linked = join(project.base, 'work', 'linked-project');
    git(project.root, 'worktree', 'add', '-q', '-b', 'linked-project', linked);
    const main = projectMovedMarker(project.root)!, other = projectMovedMarker(linked)!;
    expect(dirname(other.path)).toBe(dirname(main.path));
    expect(dirname(dirname(main.path))).toBe(realpathSync(git(project.root, 'rev-parse', '--path-format=absolute', '--git-common-dir')));
    expect(other.path).not.toBe(main.path);
    expect(other.root).toBe(realpathSync(linked));
  });

  it('resumes a crash between the mark and the journal removal into a marked, moved project', async () => {
    const crashed = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: crashed, fault: crashAt('mark-moved:after') })).rejects.toThrow('mark-moved:after');
    crashed.release();
    expect(existsSync(join(project.root, '.ai/squawk-migration.json'))).toBe(true);
    const recovery = await fence(project);
    try { expect((await resumeProjectMigration({ repoRoot: project.root, fence: recovery }))?.resumed).toBe(true); }
    finally { recovery.release(); }
    expect(existsSync(join(project.root, '.ai/squawk-migration.json'))).toBe(false);
    expect(projectMoveMarked(project.root)).toBe(true);
    expect(projectPaths(project.root).write).toBe(project.newDir);
  });

  it('keeps the run data ignore rules in the write root, without blocking the git mv of a tracked copy', async () => {
    git(project.root, 'add', '-f', '.ai/cezar/.gitignore');
    git(project.root, 'commit', '-qm', 'track the ignore file');
    await migrate(project);
    ensureDataGitignore(project.root);
    // The tracked copy stays in .ai/cezar/ for the printed git mv; a new file would make that move fail.
    expect(existsSync(join(project.dataDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(project.newDir, '.gitignore'))).toBe(false);
    const exclude = readFileSync(join(project.root, git(project.root, 'rev-parse', '--git-common-dir'), 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toEqual(expect.arrayContaining(['/.ai/squawk/runs.db', '/.ai/squawk/worktrees/']));
    git(project.root, 'mv', '.ai/cezar/.gitignore', '.ai/squawk/.gitignore');
    ensureDataGitignore(project.root);
    expect(readFileSync(join(project.newDir, '.gitignore'), 'utf8').split('\n')).toContain('runs.db');
  });

  it('keeps writing .ai/cezar/ with the switch off, marker or not', async () => {
    await migrate(project);
    expect(projectMoveMarked(project.root)).toBe(true);
    release.enabled = false;
    expect(projectPaths(project.root)).toEqual({ write: project.dataDir, reads: [project.dataDir, project.newDir] });
    expect(fallbackProjectWriteError(project.newDir)).toMatch(/Cannot write read-only project data/);
  });
});
