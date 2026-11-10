import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract';
import { createRunner } from '../core/runner-factory.ts';
import { removeOwnedWorkspace } from '../delegation/workspace.ts';
import { Home } from '../home/home.ts';
import { holdCockpitLease } from '../home/leases.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { defaultServeDeps, serveCommand, type ServeDeps } from '../serve-command.ts';
import { CockpitOwnership, migrationFencePaths, projectAdmissionRefusal } from '../server/cockpit-ownership.ts';
import { processStartToken } from '../delegation/process-liveness.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { moveProjectWhenIdle } from './auto.ts';
import { crashAt, moved, owners, TIMEOUT } from './engine.testkit.ts';
import { ProjectMigrationRecoveryError } from './recovery.ts';
import { buildMigrationProject, removeMigrationProject, TASK, type MigrationProject } from './project-migration.testkit.ts';

/**
 * The cockpit's automatic project move (hearsay-tools/cezarion#3089), through the release switch's
 * test seam: at cockpit start and at a project's first open, an idle legacy project moves before
 * anything serves it; anything else live keeps it where it is, with a notice, until the next start.
 */

async function checkpoint(root: string, workspace: WorkerWorkspace): Promise<void> {
  await removeOwnedWorkspace(root, workspace, undefined, async () => { throw new Error('stopped after the checkpoint'); }).catch(() => undefined);
}

const temporary: string[] = [];
const disposers: Array<() => void> = [];
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
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
    useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** A cockpit run: its ownership (released as its exit would) and its lazy contexts. */
  function cockpit(rebrand: boolean | undefined) {
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership, ...(rebrand === undefined ? {} : { rebrand }),
      listProjects: async () => [{ id: 'p', root: project.root, status: 'ok' as const }] });
    disposers.push(() => contexts.disposeAll());
    return { ownership, contexts, stop: () => { contexts.disposeAll(); ownership.releaseAll(); } };
  }

  const movedState = () => existsSync(join(project.newDir, 'runs.db')) && !existsSync(join(project.dataDir, 'runs.db'));
  const setTask = (status: 'waiting' | 'review') => {
    const store = RunStore.open(project.dataDir, { keepLive: true });
    try { setRunStatus(store, TASK, status); store.flush(); } finally { store.close(); }
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
          return moveProjectWhenIdle(root, { ...options, rebrand: true });
        } } as unknown as ServeDeps).finally(() => process.emit('exit'));
      await expect(boot).rejects.toThrow('listener reached');
      expect(log.mock.calls.flat().join('\n')).toContain(`[hsq] Moved the state of ${project.root} from .ai/cezar/ to .ai/squawk/. Tracked files stay; run these and commit:`);
      expect(log.mock.calls.flat().join('\n')).toContain("git mv -- '.ai/cezar/workflows/flow.yaml' '.ai/squawk/workflows/flow.yaml'");
    } finally { log.mockRestore(); }
    expect(movedState()).toBe(true);
    const store = RunStore.open(project.dataDir, { keepLive: true });
    try { expect(store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath)); } finally { store.close(); }
  });

  it('moves a registered project at its first open, before the context reads it, without counting the cockpit itself', async () => {
    // This cockpit's own presence lease and the project in its registry: its own process never blocks the move.
    await registerProject(project.root, undefined, testHome());
    const release = holdCockpitLease(testHome(), 4321, 'this');
    try {
      const run = cockpit(true);
      // ... and its own cockpit.lock claim, as a cockpit that served the project before holds it.
      await run.ownership.acquire(project.dataDir);
      const context = await run.contexts.context('p');
      expect(movedState()).toBe(true);
      expect(context.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
      await context.store.reports.idle();
    } finally { release(); }
  });

  it('keeps a project with a task live from before the restart where it is, names the task, and moves it at the next start', async () => {
    setTask('waiting');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = cockpit(true);
      const context = await first.contexts.context('p');
      // Served from both folders as before: nothing moved, the task is readable.
      expect(movedState()).toBe(false);
      expect(context.store.getRun(TASK)?.status).toBe('waiting');
      const notice = warn.mock.calls.flat().join('\n');
      expect(notice).toContain(`[hsq] Project ${project.root} keeps its state in .ai/cezar/ for now: task ${TASK} `);
      expect(notice).toContain('the move runs again at the next start');
      // The task ends; one attempt per cockpit run, so the same run does not move it.
      setRunStatus(context.store, TASK, 'review');
      context.store.flush();
      first.contexts.dispose('p');
      await first.contexts.context('p');
      expect(movedState()).toBe(false);
      first.stop();
      // The next start moves it.
      const next = cockpit(true);
      const reopened = await next.contexts.context('p');
      expect(movedState()).toBe(true);
      expect(reopened.store.getRun(TASK)?.worktreePath).toBe(moved(project, project.taskPath));
      await reopened.store.reports.idle();
    } finally { warn.mockRestore(); }
  });

  it('closes the project through recovery when the move fails after its journal exists', async () => {
    const run = cockpit(true);
    const failed = moveProjectWhenIdle(project.root, { ownership: run.ownership, homes: [], rebrand: true, fault: crashAt('move:before') });
    await expect(failed).rejects.toBeInstanceOf(ProjectMigrationRecoveryError);
    await expect(failed).rejects.toThrow('move:before');
    expect(projectAdmissionRefusal(project.dataDir)?.reason).toBe('journal');
  });

  it('waits, with a notice, when another process holds the project\'s fence at the moment of the move', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      const startToken = processStartToken(other.pid!);
      writeFileSync(migrationFencePaths(project.dataDir)!.lock, JSON.stringify({ pid: other.pid, token: randomUUID(), ...(startToken ? { startToken } : {}) }));
      const lines: string[] = [];
      const result = await moveProjectWhenIdle(project.root, { ownership: cockpit(true).ownership, homes: [], rebrand: true, log: line => lines.push(line) });
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

  it('moves nothing with the release switch off, as shipped', async () => {
    expect(REBRAND_SWITCH).toBe(false);
    const run = cockpit(undefined);
    const context = await run.contexts.context('p');
    expect(movedState()).toBe(false);
    expect(existsSync(project.newDir)).toBe(false);
    expect(context.store.getRun(TASK)?.worktreePath).toBe(project.taskPath);
    await context.store.reports.idle();
  });
});
