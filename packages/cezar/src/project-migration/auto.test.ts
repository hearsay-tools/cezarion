import { reportsIndex } from '../artifacts/reports-index.ts';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { createRunner } from '../core/runner-factory.ts';
import { removeOwnedWorkspace } from '../delegation/workspace-removal.ts';
import { Home } from '../home/home.ts';
import { holdCockpitLease } from '../home/leases.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { defaultServeDeps, serveCommand, type ServeDeps } from '../serve-command.ts';
import { CockpitOwnership, migrationFencePaths, projectAdmissionRefusal } from '../server/cockpit-ownership.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { ProjectContexts, sweepRegisteredPreviewLeftovers } from '../server/project-context.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { AutomationStore } from '../automations/store.ts';
import { ArchiveOnMergeCoordinator } from '../server/archive-on-merge.ts';
import { CompletionActionCoordinator } from '../server/completion-actions.ts';
import { WorkspaceEventBus } from '../server/server.ts';
import { startServer } from '../server/start-server.ts';
import type { RunManager } from '../workflows/run.ts';
import { moveProjectWhenIdle } from './auto.ts';
import { crashAt, moved, owners, TIMEOUT } from './engine.testkit.ts';
import { ProjectMigrationRecoveryError } from './recovery.ts';
import { buildMigrationProject, PARENT, removeMigrationProject, TASK, WORKER, type MigrationProject } from './project-migration.testkit.ts';
import { artifactDirectory } from '../artifacts/store.ts';
import { handoffPath } from '../handoff.ts';
import { LEGACY_RUNS_FILE } from '../legacy-runs.ts';
import { fallbackProjectWriteError } from '../project-paths.ts';
import { createRunManager } from '../server/run-manager.testkit.ts';

/**
 * The cockpit's automatic project move (hearsay-tools/cezarion#3089): at cockpit start and at a project's first open, a legacy project moves before anything
 * serves it. A task live from before the restart keeps its own items in place until a later start;
 * another live writer keeps the whole project where it is, with a notice, until the next start.
 */

// The preview sweep runs right after the post-listen preparation, in every version: the signal that
// the preparation's continuation ran.
vi.mock('../server/project-context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/project-context.ts')>();
  return { ...actual, sweepRegisteredPreviewLeftovers: vi.fn(actual.sweepRegisteredPreviewLeftovers) };
});

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

const temporary: string[] = [];
const disposers: Array<() => unknown> = [];
const savedHome = process.env.CEZ_HOME;
const savedDryRun = process.env.CEZ_DRY_RUN;

describe('the automatic project move', { timeout: TIMEOUT }, () => {
  let project: MigrationProject;
  beforeAll(async () => { project = await buildMigrationProject({ linked: false, checkpoint }); }, TIMEOUT);
  afterAll(() => { if (project) removeMigrationProject(project); });
  beforeEach(() => {
    project.restore();
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-auto-move-home-'));
    temporary.push(home);
    useTestHome(Home.sandbox(home));
    process.env.CEZ_DRY_RUN = '1';
    clearProjectProbeCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // Closing the contexts waits for their branch sweeps, which may still write the repository.
    for (const dispose of disposers.splice(0)) await dispose();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
    useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** A cockpit run: its ownership (released as its exit would) and its lazy contexts. */
  function cockpit() {
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), ownership,
      listProjects: async () => [{ id: 'p', root: project.root, status: 'ok' as const }] });
    disposers.push(() => contexts.disposeAll());
    return { ownership, contexts, stop: () => { void contexts.disposeAll(); ownership.releaseAll(); } };
  }

  const movedState = () => existsSync(join(project.newDir, 'runs.db')) && !existsSync(join(project.dataDir, 'runs.db'));
  const setTask = (status: 'waiting' | 'review', archived = true) => {
    const store = RunStore.open(project.dataDir, { keepLive: true });
    try { setRunStatus(store, TASK, status, { archived }); store.flush(); } finally { store.close(); }
  };

  it('moves an idle legacy project at cockpit start, before the listener, and its task data stays readable', async () => {
    const listener = vi.fn().mockRejectedValue(new Error('listener reached'));
    const process = new EventEmitter();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const boot = serveCommand(testHome(), project.root, 0, false, undefined, false, { ...defaultServeDeps, acquireServeListener: listener, process,
        moveProjectWhenIdle: (root: string, options: Parameters<typeof moveProjectWhenIdle>[1]) => {
          // The move ran before the listener: nothing served the project yet.
          expect(listener).not.toHaveBeenCalled();
          return moveProjectWhenIdle(root, options);
        } } as unknown as ServeDeps).finally(() => process.emit('exit'));
      await expect(boot).rejects.toThrow('listener reached');
      expect(log.mock.calls.flat().join('\n')).toContain(`[hsq] Moved the state of ${project.root} from .ai/cezar/ to .ai/squawk/. Tracked files stay; run these and commit:`);
      expect(log.mock.calls.flat().join('\n')).toContain("git mv -- '.ai/cezar/workflows/flow.yaml' '.ai/squawk/workflows/flow.yaml'");
    } finally { log.mockRestore(); }
    expect(movedState()).toBe(true);
    const store = RunStore.open(project.newDir, { keepLive: true });
    try { expect(store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath)); } finally { store.close(); }
  });

  it('moves a registered project at its first open, before the context reads it, without counting the cockpit itself', async () => {
    // This cockpit's own presence lease and the project in its registry: its own process never blocks the move.
    await registerProject(project.root, undefined, testHome());
    const release = holdCockpitLease(testHome(), 4321, 'this');
    try {
      const run = cockpit();
      // ... and its own cockpit.lock claim, as a cockpit that served the project before holds it.
      await run.ownership.acquire(project.dataDir);
      const context = await run.contexts.context('p');
      expect(movedState()).toBe(true);
      expect(context.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
      await reportsIndex(context.store).idle();
    } finally { release(); }
  });

  it('moves a project with a task live from before the restart, keeps the task\'s own files in place while it is not archived, names it, and moves them at the start after it is archived', async () => {
    setTask('waiting', false);
    const handoff = join(project.dataDir, 'runs', `${TASK}.handoff.md`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = cockpit();
      const context = await first.contexts.context('p');
      // The store moved; the live task's worktree, handoff and artifacts stay where its agent knows them.
      expect(movedState()).toBe(true);
      expect(context.dataDir).toBe(project.newDir);
      expect(context.store.getRun(TASK)?.status).toBe('waiting');
      expect(context.store.getRun(TASK)?.worktreePath).toBe(project.taskPath);
      expect(existsSync(join(project.taskPath, 'report.html'))).toBe(true);
      expect(handoffPath(context.dataDir, TASK)).toBe(handoff);
      expect(readFileSync(handoff, 'utf8')).toContain(`**Worktree:** ${project.taskPath}`);
      expect(existsSync(artifactDirectory(context.dataDir, TASK))).toBe(true);
      expect(artifactDirectory(context.dataDir, TASK)).toBe(join(realpathSync(project.dataDir), 'runs', `${TASK}-artifacts`));
      // The reports index reads the kept task's artifacts in .ai/cezar/, and keeps its report.
      expect(await reportsIndex(context.store).list({})).toMatchObject({ reports: [{ id: project.artifactId, runId: TASK }] });
      // Everything else moved, and is written in the new directory.
      expect(existsSync(join(project.newDir, 'workflows/local.yaml'))).toBe(true);
      expect(existsSync(join(project.newDir, 'runs', `${PARENT}-worker-results`))).toBe(true);
      expect(context.store.getRun(WORKER)?.worktreePath).toBe(moved(project, project.worker.path));
      expect(JSON.parse(readFileSync(join(project.newDir, LEGACY_RUNS_FILE), 'utf8'))).toEqual({ version: 1, runs: [TASK] });
      const notice = warn.mock.calls.flat().join('\n');
      expect(notice).toContain(`[hsq] Moved the state of ${project.root} from .ai/cezar/ to .ai/squawk/. 1 task keeps its files in .ai/cezar/ until it is archived: ${TASK}.`);
      // A live task's own items stay writable for this cockpit, although .ai/cezar/ is the fallback now.
      expect(fallbackProjectWriteError(project.taskPath)).toBeUndefined();
      expect(fallbackProjectWriteError(handoff)).toBeUndefined();
      expect(fallbackProjectWriteError(join(project.dataDir, 'runs.db'))).toMatch(/read-only project data/);
      // The task ends in review; a human can still Continue it, so the next start keeps its files.
      setRunStatus(context.store, TASK, 'review');
      context.store.flush();
      first.stop();
      const second = cockpit();
      const kept = await second.contexts.context('p');
      expect(kept.store.getRun(TASK)?.worktreePath).toBe(project.taskPath);
      expect(existsSync(join(project.taskPath, 'report.html'))).toBe(true);
      expect(JSON.parse(readFileSync(join(project.newDir, LEGACY_RUNS_FILE), 'utf8'))).toEqual({ version: 1, runs: [TASK] });
      // The task is archived; one attempt per cockpit run, so the same run does not move its files.
      kept.store.setArchived(TASK, true);
      kept.store.flush();
      second.contexts.dispose('p');
      await second.contexts.context('p');
      expect(existsSync(project.taskPath)).toBe(true);
      second.stop();
      // The next start moves them, rewrites their stored paths and removes what the move emptied.
      const next = cockpit();
      const reopened = await next.contexts.context('p');
      expect(reopened.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
      expect(existsSync(join(moved(project, project.taskPath), 'report.html'))).toBe(true);
      expect(readFileSync(join(project.newDir, 'runs', `${TASK}.handoff.md`), 'utf8')).toContain(`**Worktree:** ${moved(project, project.taskPath)}`);
      expect(existsSync(join(project.newDir, LEGACY_RUNS_FILE))).toBe(false);
      expect(readdirSync(project.dataDir).filter(name => !name.startsWith('cockpit.lock')).sort()).toEqual(['context.yaml', 'skills', 'workflows']);
      expect(handoffPath(reopened.dataDir, TASK)).toBe(join(project.newDir, 'runs', `${TASK}.handoff.md`));
      await reportsIndex(reopened.store).idle();
    } finally { warn.mockRestore(); }
  });

  it('closes the project through recovery when the move fails after its journal exists', async () => {
    const run = cockpit();
    const failed = moveProjectWhenIdle(project.root, { ownership: run.ownership, homes: [], fault: crashAt('move:before') });
    await expect(failed).rejects.toBeInstanceOf(ProjectMigrationRecoveryError);
    await expect(failed).rejects.toThrow('move:before');
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('waits, with a notice, on any failure before the journal exists, and serves the project as before', async () => {
    const run = cockpit();
    const lines: string[] = [];
    const result = await moveProjectWhenIdle(project.root, { ownership: run.ownership, homes: [], fault: crashAt('journal:before'),
      log: line => lines.push(line) });
    expect(result).toEqual({ status: 'blocked', reason: 'journal:before' });
    expect(lines).toEqual([`[hsq] Project ${project.root} keeps its state in .ai/cezar/ for now: journal:before. It is served from both folders; the move runs again at the next start.`]);
    expect(projectAdmissionRefusal(project.dataDir)).toBeUndefined();
    expect(movedState()).toBe(false);
    const context = await run.contexts.context('p');
    expect(context.store.getRun(TASK)?.worktreePath).toBe(project.taskPath);
    await reportsIndex(context.store).idle();
  });

  it('waits, with a notice, when another process holds the project\'s fence at the moment of the move', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(project.dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      const lines: string[] = [];
      const result = await moveProjectWhenIdle(project.root, { ownership: cockpit().ownership, homes: [], log: line => lines.push(line) });
      expect(result).toEqual({ status: 'blocked', reason: `A project migration (pid ${other.pid}) holds ${project.root}; retry when it finishes` });
      expect(lines).toEqual([`[hsq] Project ${project.root} keeps its state in .ai/cezar/ for now: ${result.status === 'blocked' ? result.reason : ''}. `
        + 'It is served from both folders; the move runs again at the next start.']);
      expect(movedState()).toBe(false);
    } finally {
      const exited = once(other, 'exit');
      other.kill('SIGKILL');
      await exited;
      rmSync(migrationFencePaths(project.dataDir)!.lock, { force: true });
    }
  });

  it('makes a request that comes while the project is being prepared wait for the move, never read first', async () => {
    const run = cockpit();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'warn').mockImplementation((line: string) => { lines.push(line); });
    try {
      // Whether the move had finished when the request's build first opened the project's run store.
      const movedAtOpen: boolean[] = [];
      const open = RunStore.open;
      vi.spyOn(RunStore, 'open').mockImplementation((dataDir, options) => {
        if (dataDir === (project.newDir)) movedAtOpen.push(movedState());
        return open.call(RunStore, dataDir, options);
      });
      // The post-listen preparation's move and a first request for the project, at once.
      const preparing = moveProjectWhenIdle(project.root, { ownership: run.ownership, homes: [] });
      const opening = run.contexts.context('p');
      const [, context] = await Promise.all([preparing, opening]);
      expect(movedAtOpen).toEqual([true]);
      expect(movedState()).toBe(true);
      expect(context.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
      expect(lines.filter(line => line.startsWith('[hsq] Moved the state of'))).toHaveLength(1);
      await reportsIndex(context.store).idle();
    } finally { log.mockRestore(); vi.mocked(RunStore.open).mockRestore(); }
  });

  it('prepares every project, with warm-up off, before automation discovery opens its state', async () => {
    vi.stubEnv('CEZ_PROJECT_WARMUP', '0');
    const boot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-auto-move-boot-'));
    temporary.push(boot);
    execFileSync('git', ['init', '-q', boot]);
    const bootId = (await registerProject(boot, undefined, testHome())).id!;
    const projectId = (await registerProject(project.root, undefined, testHome())).id!;
    // Whether the legacy project had moved when automation discovery first opened its store.
    const movedWhenOpened: boolean[] = [];
    const store = AutomationCoordinator.prototype.store;
    vi.spyOn(AutomationCoordinator.prototype, 'store').mockImplementation(function (this: AutomationCoordinator, id: string, root?: string) {
      if (id === projectId) movedWhenOpened.push(movedState());
      return store.call(this, id, root);
    });
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), ownership,
      listProjects: () => listProjects(testHome()) });
    const bootStore = RunStore.open(join(boot, '.ai/cezar'), { keepLive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = startServer({ home: testHome(), repoRoot: boot, bootProjectId: bootId, store: bootStore, ownership,
      manager: { isActive: () => false } as unknown as RunManager, version: 'test', contexts }, 0);
    try {
      // bound: hang guard; discovery opens the project's automation store once it is prepared.
      await vi.waitFor(() => expect(movedWhenOpened.length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(movedWhenOpened[0]).toBe(true);
      expect(contexts.peek(projectId)).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); });
      await contexts.disposeAll();
      bootStore.close();
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  /** A cockpit server over a boot repo, with warm-up off. */
  async function server(options: { workspaceEvents?: WorkspaceEventBus } = {}) {
    vi.stubEnv('CEZ_PROJECT_WARMUP', '0');
    const boot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-auto-move-boot-'));
    temporary.push(boot);
    execFileSync('git', ['init', '-q', boot]);
    const bootId = (await registerProject(boot, undefined, testHome())).id!;
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), ownership, listProjects: () => listProjects(testHome()) });
    // The boot project's store lives outside it, so the boot project holds no legacy state to move:
    // the legacy project is the preparation's last real work.
    const bootData = mkdtempSync(join(realpathSync(tmpdir()), 'cez-auto-move-boot-data-'));
    temporary.push(bootData);
    const bootStore = RunStore.open(bootData, { keepLive: true });
    const started = startServer({ home: testHome(), repoRoot: boot, bootProjectId: bootId, store: bootStore, ownership,
      manager: { isActive: () => false } as unknown as RunManager, version: 'test', contexts, ...options }, 0);
    disposers.push(async () => { started.close(); await contexts.disposeAll(); bootStore.close(); vi.unstubAllEnvs(); });
    return started;
  }

  it('starts no archive or completion job once the cockpit closed during the preparation', async () => {
    await registerProject(project.root, undefined, testHome());
    const archive = vi.spyOn(ArchiveOnMergeCoordinator.prototype, 'start');
    const completion = vi.spyOn(CompletionActionCoordinator.prototype, 'start');
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: string) => { lines.push(String(line)); });
    let cockpit: Awaited<ReturnType<typeof server>> | undefined;
    // The cockpit closes in the middle of the legacy project's move.
    const fence = CockpitOwnership.prototype.fenceProject;
    vi.spyOn(CockpitOwnership.prototype, 'fenceProject').mockImplementation(function (this: CockpitOwnership, ...args) {
      cockpit?.close();
      return fence.apply(this, args);
    });
    vi.mocked(sweepRegisteredPreviewLeftovers).mockClear();
    try {
      cockpit = await server();
      // bound: hang guard; the preparation's continuation runs once the move that was running ends.
      await vi.waitFor(() => expect(sweepRegisteredPreviewLeftovers).toHaveBeenCalled(), { timeout: 15_000 });
      expect(lines.some(line => line.startsWith('[hsq] Moved the state of'))).toBe(true);
      expect(archive).not.toHaveBeenCalled();
      expect(completion).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.mocked(CockpitOwnership.prototype.fenceProject).mockRestore();
    }
  });

  it('prepares a project registered after start before the automation coordinator opens its state', async () => {
    const events = new WorkspaceEventBus();
    const movedWhenOpened: boolean[] = [];
    const store = AutomationCoordinator.prototype.store;
    vi.spyOn(AutomationCoordinator.prototype, 'store').mockImplementation(function (this: AutomationCoordinator, id: string, root?: string) {
      if (root === project.root) movedWhenOpened.push(movedState());
      return store.call(this, id, root);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cockpit = await server({ workspaceEvents: events });
      if (!cockpit.listening) await once(cockpit, 'listening');
      const added = await registerProject(project.root, undefined, testHome());
      events.emit('project-added', { project: { id: added.id, root: project.root, status: 'ok' } });
      // bound: hang guard; the late project's automation store opens once it is prepared.
      await vi.waitFor(() => expect(movedWhenOpened.length).toBeGreaterThan(0), { timeout: 15_000 });
      expect(movedWhenOpened[0]).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('does not move a project while an automation of this cockpit holds its lease', async () => {
    const lease = AutomationStore.open(project.dataDir).acquireLease();
    expect(lease).toBeDefined();
    try {
      const result = await moveProjectWhenIdle(project.root, { ownership: cockpit().ownership, homes: [], log: () => undefined });
      expect(result).toEqual({ status: 'blocked', reason: 'an automation of this cockpit holds its lease' });
      expect(movedState()).toBe(false);
    } finally { lease?.release(); }
  });
});
