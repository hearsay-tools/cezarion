import { execFileSync, spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runArtifactCommand } from '../artifacts/cli.ts';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { Home } from '../home/home.ts';
import { holdCockpitLease } from '../home/leases.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { projectPaths } from '../project-paths.ts';
import { CockpitOwnership, migrationFencePaths, projectAdmissionRefusal, ProjectMigrationFencedError } from '../server/cockpit-ownership.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { runMigrateProjectCommand, type MigrateProjectDeps } from './cli.ts';
import { crashAt, fence, moved, owners, TIMEOUT } from './engine.testkit.ts';
import { migrateProject } from './engine.ts';
import { migrateProjectOffline } from './offline.ts';
import { projectLiveTasksOffline } from './live.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { buildMigrationProject, projectSnapshot, removeMigrationProject, TASK, type MigrationProject } from './project-migration.testkit.ts';

/**
 * The offline `migrate-project` (hearsay-tools/cezarion#3089) on a real project: the dry run, the
 * exclusive lock for the whole move, refusals while a cockpit serves the project or a task is live,
 * an interrupted migration and its retry, and a task context the migration made stale.
 */

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

const none = { liveTasks: () => [] };
const temporary: string[] = [];
const savedHome = process.env.CEZ_HOME;
const savedDryRun = process.env.CEZ_DRY_RUN;

describe('the offline migrate-project', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });
  beforeEach(() => {
    project.restore();
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migrate-project-home-'));
    temporary.push(home);
    useTestHome(Home.sandbox(home));
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
  });
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
    useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  async function cli(args: string[], deps: Partial<MigrateProjectDeps> = {}) {
    const out: string[] = [], err: string[] = [];
    const code = await runMigrateProjectCommand([...args, '--repo', project.root], {
      homes: [testHome()], getRepoInfo: async () => { return { root: project.root } as never; }, cwd: () => project.root,
      log: line => out.push(line), error: line => err.push(line), ...deps,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** The task as the product reads it after the move: P4a's dual read finds it under `.ai/squawk/`. */
  function migratedTask() {
    const store = RunStore.open(projectPaths(project.root).write, { keepLive: true });
    try { return store.getRun(TASK); } finally { store.close(); }
  }

  function expectReleased(): void {
    const paths = migrationFencePaths(project.dataDir)!;
    expect(existsSync(paths.journal)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(join(project.dataDir, 'cockpit.lock'))).toBe(false);
    expect(projectAdmissionRefusal(project.dataDir)).toBeUndefined();
  }

  it('prints the whole dry-run plan with the tracked-file commands and changes nothing', async () => {
    const before = projectSnapshot(project, { databaseBytes: true });
    const { code, out } = await cli(['--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain(`Project ${project.root}: ${project.dataDir} -> ${project.newDir}`);
    expect(out).toContain(`  ${project.taskPath} -> ${moved(project, project.taskPath)}`);
    expect(out).toMatch(/Tracked files left in place; run these and commit:\n {2}cd -- /);
    expect(out).toContain("git mv -- '.ai/cezar/workflows/flow.yaml' '.ai/squawk/workflows/flow.yaml'");
    expect(out.endsWith('Dry run: nothing was moved or rewritten.')).toBe(true);
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
    expectReleased();
  });

  it('plans a dry run under the project claim, so no cockpit boots and no fence starts while it reads', async () => {
    const claims: unknown[] = [];
    const { code } = await cli(['--dry-run'], { fault: point => {
      if (point === 'plan:before') claims.push(JSON.parse(readFileSync(join(project.dataDir, 'cockpit.lock'), 'utf8')));
    } });
    expect(code).toBe(0);
    expect(claims).toEqual([expect.objectContaining({ pid: process.pid })]);
    expectReleased();
  });

  it('locks an ownerless project for the whole migration, keeps competitors out, and leaves readable migrated tasks', async () => {
    const outside = AsyncLocalStorage.snapshot();
    const during: { refusal?: string | undefined; competitors: Array<Promise<unknown>> } = { competitors: [] };
    const { code, out } = await cli([], { fault: point => {
      if (point !== 'move:before') return;
      // Outside the migration's own work: what a cockpit boot, a lazy build or another CLI meets.
      outside(() => {
        during.refusal = projectAdmissionRefusal(project.dataDir)?.reason;
        const cockpit = new CockpitOwnership(), cli = new CockpitOwnership();
        owners.push(cockpit, cli);
        // Each settles to what it met; awaited after the migration ends.
        during.competitors.push(...[cockpit.acquire(project.dataDir), cli.fenceProject(project.dataDir, none)].map(entry => entry.then(() => 'entered', (error: unknown) => error)));
      });
    } });
    expect(code).toBe(0);
    expect(during.refusal).toBe('migrating');
    expect(during.competitors).toHaveLength(2);
    for (const competitor of during.competitors) expect(await competitor).toBeInstanceOf(ProjectMigrationFencedError);
    expect(out).toContain("git mv -- '.ai/cezar/workflows/flow.yaml' '.ai/squawk/workflows/flow.yaml'");
    expect(out.endsWith('Migration complete. Run the git mv commands above and commit them.')).toBe(true);
    // Tracked files stay for the user's `git mv`; runtime state moved.
    expect(existsSync(join(project.dataDir, 'workflows/flow.yaml'))).toBe(true);
    expect(existsSync(join(project.newDir, 'runs.db'))).toBe(true);
    expectReleased();
    expect(migratedTask()?.worktreePath).toBe(moved(project, project.taskPath));
  });

  it('keeps an interrupted migration blocked, and a retry finishes it', async () => {
    const crashed = await cli([], { fault: crashAt('run-store:before') });
    expect(crashed.code).toBe(1);
    expect(crashed.err).toBe('run-store:before');
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
    expect(existsSync(join(project.dataDir, 'cockpit.lock'))).toBe(false);

    const retried = await cli([]);
    expect(retried.code).toBe(0);
    expect(retried.out).toContain('An unfinished migration was finished first.');
    expect(retried.out).toContain(`  ${project.taskPath} -> ${moved(project, project.taskPath)}`);
    expect(retried.out.endsWith('Migration complete. Run the git mv commands above and commit them.')).toBe(true);
    expectReleased();
    expect(migratedTask()?.worktreePath).toBe(moved(project, project.taskPath));
  });

  it('reports what a dry run completed first when it met an interrupted migration', async () => {
    expect((await cli([], { fault: crashAt('run-store:before') })).code).toBe(1);
    const dry = await cli(['--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out.startsWith('An interrupted migration was found and completed first. It did this:\n')).toBe(true);
    // The recovery's own moves are listed, then what remains is planned.
    expect(dry.out.indexOf(`  ${project.taskPath} -> ${moved(project, project.taskPath)}`)).toBeLessThan(dry.out.indexOf('The dry run of what remains:'));
    expect(dry.out.endsWith('Dry run: planning changed nothing; the completed migration above did.')).toBe(true);
    expect(dry.out).not.toContain('nothing was moved or rewritten');
    expect(migratedTask()?.worktreePath).toBe(moved(project, project.taskPath));
  });

  it('refuses an artifact publish whose task context names a directory the recovered migration moved', async () => {
    // A real journal: the migration stopped before its first move, so recovery moves runs/.
    const held = await fence(project);
    await expect(migrateProject({ repoRoot: project.root, fence: held, fault: crashAt('move:before') })).rejects.toThrow('move:before');
    held.release();
    const artifactsDir = join(project.dataDir, 'runs', `${TASK}-artifacts`);
    const report = join(project.taskPath, 'report.html');
    const errors: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // The first publish recovers the journal; the second meets the finished migration.
        const code = await runArtifactCommand(['publish', moved(project, report)], { CEZ_ARTIFACTS_DIR: artifactsDir, CEZ_TASK_ID: TASK });
        expect(code).toBe(1);
        expect(JSON.parse(errors.at(-1)!).error).toBe(`The task context is out of date: a project migration moved ${artifactsDir} to ${moved(project, artifactsDir)}. `
          + 'Nothing was published. Continue the task from the cockpit so it gets its new paths');
        expect(existsSync(join(project.dataDir, 'runs'))).toBe(false);
      }
    } finally { error.mockRestore(); }
    expect(existsSync(migrationFencePaths(project.dataDir)!.journal)).toBe(false);
  });

  it('refuses at once, writing nothing, while another process owns the project or holds its fence', async () => {
    const store = RunStore.open(project.dataDir, { keepLive: true });
    try { setRunStatus(store, TASK, 'running'); store.updateRun(TASK, { title: 'live migration task' }); store.flush(); } finally { store.close(); }
    const before = projectSnapshot(project, { databaseBytes: true });
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      const startToken = processStartToken(other.pid!);
      const claim = JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) });
      const cockpitLock = join(project.dataDir, 'cockpit.lock');
      writeFileSync(cockpitLock, JSON.stringify({ ...JSON.parse(claim), url: 'http://127.0.0.1:4999' }));
      for (const args of [[], ['--dry-run']]) {
        expect(await cli(args)).toMatchObject({ code: 1, err: `Cannot migrate ${project.root} while it is in use. Stop what is listed, then retry:\n`
          + `- cockpit pid ${other.pid} at http://127.0.0.1:4999: stop it\n`
          + `- task ${TASK} live migration task (running): finish or cancel it` });
      }
      rmSync(cockpitLock);
      writeFileSync(migrationFencePaths(project.dataDir)!.lock, claim);
      // A dry run is an admitted read: it is refused under a fence like a migration.
      for (const args of [[], ['--dry-run']]) {
        const fenced = await cli(args);
        expect(fenced.code).toBe(1);
        expect(fenced.err).toBe(`A project migration (pid ${other.pid}) holds ${project.root}; retry when it finishes`);
      }
      rmSync(migrationFencePaths(project.dataDir)!.lock);
    } finally {
      const exited = once(other, 'exit');
      other.kill('SIGKILL');
      await exited;
    }
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
  });

  // hearsay-tools/cezarion#3136: a cockpit that does not own the project but lists it runs its
  // automations, so it serves the project too.
  it('refuses while a cockpit of this home that does not own the project lists it, and names it', async () => {
    const before = projectSnapshot(project, { databaseBytes: true });
    // A live cockpit of this home that lists nothing of this project does not stop the migration.
    const release = holdCockpitLease(testHome(), 4998, 'elsewhere');
    try {
      const dry = await cli(['--dry-run'], { self: -1 });
      expect(dry.code).toBe(0);
      await registerProject(project.root, undefined, testHome());
      const refused = await cli([], { self: -1 });
      expect(refused).toMatchObject({ code: 1, err: `Cannot migrate ${project.root} while it is in use. Stop what is listed, then retry:\n`
        + `- cockpit pid ${process.pid} on port 4998, instance elsewhere, home ${testHome().root}: stop it` });
      expect(existsSync(join(project.dataDir, 'cockpit.lock'))).toBe(false);
    } finally { release(); }
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
    expect((await cli([], { self: -1 })).code).toBe(0);
  });

  it('keeps the cockpit details when its older database prevents a live-task read', async () => {
    await registerProject(project.root, undefined, testHome());
    const release = holdCockpitLease(testHome(), 4998, 'older-store');
    const db = new DatabaseSync(join(project.dataDir, 'runs.db'));
    try { db.exec('PRAGMA user_version = 0'); } finally { db.close(); }
    const before = projectSnapshot(project, { databaseBytes: true });
    try {
      const refused = await cli([], { self: -1 });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(`- cockpit pid ${process.pid} on port 4998`);
      expect(refused.err).toContain('live tasks could not be read:');
      expect(refused.err).toContain('schema');
      expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
    } finally { release(); }
  });

  it('migrates while a task is live, keeps the task\'s own files in place and lists it, and moves them once the task is archived', async () => {
    const store = RunStore.open(project.dataDir, { keepLive: true });
    try { setRunStatus(store, TASK, 'waiting', { archived: false }); store.flush(); } finally { store.close(); }
    const first = await cli([]);
    expect(first.code).toBe(0);
    expect(first.out).toContain(`Kept in .ai/cezar/ for tasks until they are archived:\n  ${TASK}`);
    expect(first.out).toContain('The tasks listed above keep their files in .ai/cezar/; a later migration moves them once they are archived.');
    expect(existsSync(join(project.newDir, 'runs.db'))).toBe(true);
    expect(migratedTask()?.worktreePath).toBe(project.taskPath);
    expect(existsSync(project.taskPath)).toBe(true);
    expectReleased();
    // In review, a human can still Continue it: its files stay.
    const reviewed = RunStore.open(project.newDir, { keepLive: true });
    try { setRunStatus(reviewed, TASK, 'review'); reviewed.flush(); } finally { reviewed.close(); }
    const second = await cli([]);
    expect(second.code).toBe(0);
    expect(migratedTask()?.worktreePath).toBe(project.taskPath);
    expect(existsSync(project.taskPath)).toBe(true);
    const archived = RunStore.open(project.newDir, { keepLive: true });
    try { archived.setArchived(TASK, true); archived.flush(); } finally { archived.close(); }
    const migrated = await cli([]);
    expect(migrated.code).toBe(0);
    expect(migratedTask()?.worktreePath).toBe(moved(project, project.taskPath));
    expect(existsSync(project.taskPath)).toBe(false);
  });
});

describe('the live-task check of an offline migration', () => {
  /** Every entry under `root`: its kind, and the bytes of each file. */
  function snapshot(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      out[path] = entry.isFile() ? readFileSync(path, 'base64') : entry.isDirectory() ? 'dir' : 'other';
    }
    return out;
  }

  it('refuses a project with a runs.json no store imported yet, live task and all, and writes nothing', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migrate-legacy-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
      writeFileSync(join(root, '.ai/cezar/runs.json'), JSON.stringify([makeRunRecord({ id: 'legacy-run', title: 'legacy live', status: RUN_STATUS.running })]));
      const before = snapshot(root);
      await expect(migrateProjectOffline(root, { homes: [], dryRun: false })).rejects.toThrow(
        `Cannot migrate ${root}:\n- ${join(root, '.ai/cezar/runs.json')} has not been imported into a run store; open the project with this build first`);
      expect(snapshot(root)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the read-only live-task view', () => {
  it('refuses a task marked live whose record it cannot read', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migrate-unreadable-'));
    try {
      const dataDir = join(root, '.ai/cezar');
      seedRuns(dataDir, [makeRunRecord({ id: 'unreadable-run', title: 'live', status: RUN_STATUS.running })]);
      const db = new DatabaseSync(join(dataDir, 'runs.db'));
      try { db.prepare('UPDATE runs SET data = ? WHERE id = ?').run('{"written":"by another binary"}', 'unreadable-run'); } finally { db.close(); }
      expect(() => projectLiveTasksOffline(root)).toThrow(`Cannot migrate ${root}: these tasks are marked live but their records cannot be read: unreadable-run.`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the migrate-project command line', () => {
  it('refuses a --repo that does not exist with one line on stderr and exit 1', async () => {
    const missing = join(realpathSync(tmpdir()), `cez-missing-${randomUUID()}`);
    const out: string[] = [], err: string[] = [];
    const code = await runMigrateProjectCommand(['--repo', missing], { homes: [], getRepoInfo: async () => null, cwd: () => tmpdir(),
      log: line => out.push(line), error: line => err.push(line) });
    expect({ code, out, err }).toEqual({ code: 1, out: [], err: [expect.stringMatching(new RegExp(`^ENOENT: no such file or directory, \\w+ '${missing}'$`))] });
  });
});
