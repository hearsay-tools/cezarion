import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { projectMigrationErrorSchema, projectMigrationResponseSchema } from '@open-mercato/cezar-contract/project-migration';
import { createRunner } from '../core/runner-factory.ts';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import {
  CockpitOwnership, migrationFencePaths, projectAdmissionRefusal, ProjectMigrationFencedError,
} from '../server/cockpit-ownership.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { createApp } from '../server/server.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { runMigrateProjectCommand, type MigrateProjectDeps } from './cli.ts';
import { crashAt, moved, owners, TIMEOUT } from './engine.testkit.ts';
import { buildMigrationProject, projectSnapshot, removeMigrationProject, TASK, type MigrationProject } from './project-migration.testkit.ts';

/**
 * `migrate-project` behind its P5 gate (hearsay-tools/cezarion#3089), through the gate's test
 * seams, on a real project: the dry run, an ownerless CLI that locks the project, the owning
 * cockpit that migrates on request, live tasks that refuse, an interrupted migration and its retry.
 */

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

const none = { liveTasks: () => [], inFlight: () => 0 };
const temporary: string[] = [];
const disposers: Array<() => void> = [];
const savedHome = process.env.CEZ_HOME;
const savedDryRun = process.env.CEZ_DRY_RUN;

describe('migrate-project behind the P5 gate', { timeout: TIMEOUT }, () => {
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
    for (const dispose of disposers.splice(0)) dispose();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
    useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  async function cli(args: string[], deps: Partial<MigrateProjectDeps> = {}) {
    const out: string[] = [], err: string[] = [];
    const code = await runMigrateProjectCommand([...args, '--repo', project.root], {}, {
      fetch, owner: () => undefined, getRepoInfo: async () => { return { root: project.root } as never; }, cwd: () => project.root,
      log: line => out.push(line), error: line => err.push(line), ...deps,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** The task as the product reads it after the move: P4a's dual read finds it under `.ai/squawk/`. */
  function migratedTask() {
    const store = RunStore.open(project.dataDir, { keepLive: true });
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

  it('refuses at once while another process owns the project or holds its fence', async () => {
    const before = projectSnapshot(project, { databaseBytes: true });
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      const startToken = processStartToken(other.pid!);
      const claim = JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) });
      const cockpitLock = join(project.dataDir, 'cockpit.lock');
      writeFileSync(cockpitLock, claim);
      const starting = await cli([], { owner: (await import('../server/cockpit-ownership.ts')).anotherCockpitOwner });
      expect(starting).toMatchObject({ code: 1, err: `A cockpit (pid ${other.pid}) owns ${project.root} and is still starting; retry shortly` });
      rmSync(cockpitLock);
      writeFileSync(migrationFencePaths(project.dataDir)!.lock, claim);
      const fenced = await cli([]);
      expect(fenced.code).toBe(1);
      expect(fenced.err).toBe(`A project migration (pid ${other.pid}) holds ${project.root}; retry when it finishes`);
      rmSync(migrationFencePaths(project.dataDir)!.lock);
    } finally {
      const exited = once(other, 'exit');
      other.kill('SIGKILL');
      await exited;
    }
    expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);
  });

  describe('through the owning cockpit', () => {
    async function owningCockpit() {
      const boot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migrate-project-boot-'));
      temporary.push(boot);
      const bootId = (await registerProject(boot, undefined, testHome())).id!;
      const targetId = (await registerProject(project.root, undefined, testHome())).id!;
      const ownership = new CockpitOwnership();
      owners.push(ownership);
      ownership.publishUrl('http://127.0.0.1:4321');
      const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership,
        listProjects: async () => [{ id: bootId, root: boot, status: 'not-git' as const }, { id: targetId, root: project.root, status: 'ok' as const }] });
      disposers.push(() => contexts.disposeAll());
      const bootContext = await contexts.context(bootId);
      const app = createApp({ home: testHome(), repoRoot: boot, store: bootContext.store, manager: bootContext.manager, ownership, contexts,
        bootProjectId: bootId, version: '0.0.0-test', projectMigration: true });
      const request: typeof fetch = async (input, init) => apiRequest(app, new URL(String(input)).pathname, init);
      const viaOwner = (args: string[]) => cli(args, { owner: () => ({ pid: 1, url: 'http://127.0.0.1:4321' }), fetch: request });
      return { app, contexts, targetId, bootId, viaOwner };
    }

    it('dispatches a dry run and a migration to the owner, which reopens the project over the moved state', async () => {
      const { app, contexts, targetId, viaOwner } = await owningCockpit();
      await contexts.context(targetId);
      const before = projectSnapshot(project, { databaseBytes: true });
      const dry = await viaOwner(['--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain(`  ${project.taskPath} -> ${moved(project, project.taskPath)}`);
      expect(dry.out.endsWith('Dry run: nothing was moved or rewritten.')).toBe(true);
      expect(projectSnapshot(project, { databaseBytes: true })).toEqual(before);

      const real = await viaOwner([]);
      expect(real.code).toBe(0);
      expect(real.out.endsWith('Migration complete. Run the git mv commands above and commit them.')).toBe(true);
      expect(existsSync(migrationFencePaths(project.dataDir)!.journal)).toBe(false);
      expect(existsSync(migrationFencePaths(project.dataDir)!.lock)).toBe(false);
      // The next request builds the context again and reads the migrated task.
      const task = await apiRequest(app, `/api/v1/p/${targetId}/runs/${TASK}`);
      expect(task.status).toBe(200);
      expect(((await task.json()) as { worktreePath?: string }).worktreePath).toBe(moved(project, project.taskPath));
      // The rebuilt context's report backfill ends before teardown closes its store.
      await (await contexts.context(targetId)).store.reports.idle();
    });

    it('refuses while a task is live and lists it, keeps other projects served, and migrates once the task ends', async () => {
      const { app, contexts, targetId, bootId } = await owningCockpit();
      const context = await contexts.context(targetId);
      setRunStatus(context.store, TASK, 'waiting');
      const post = () => apiRequest(app, `/api/v1/projects/${targetId}/migration`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: false }) });
      const refused = await post();
      expect(refused.status).toBe(409);
      const body = projectMigrationErrorSchema.parse(await refused.json());
      expect(body.liveTasks?.map(task => task.id)).toEqual([TASK]);
      expect(body.error).toContain('Finish or cancel each one, then retry');
      expect(existsSync(project.newDir)).toBe(false);
      // The project and an unrelated project still answer.
      expect((await apiRequest(app, `/api/v1/p/${targetId}/runs/${TASK}`)).status).toBe(200);
      expect((await apiRequest(app, `/api/v1/p/${bootId}/runs`)).status).toBe(200);

      setRunStatus(context.store, TASK, 'review');
      const migrated = await post();
      expect(migrated.status).toBe(200);
      expect(projectMigrationResponseSchema.parse(await migrated.json())).toMatchObject({ dryRun: false, resumed: false });
      expect((await apiRequest(app, `/api/v1/p/${bootId}/runs`)).status).toBe(200);
    });
  });
});
