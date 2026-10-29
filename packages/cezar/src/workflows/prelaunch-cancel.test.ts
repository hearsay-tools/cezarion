import { runInternals } from './run-internals.testkit.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { CiToolController } from '../ci-wait/controller.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { RunStore, type RunRecord, type RunStatus } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunManager } from './run.ts';
import { createFixtureManager, removeFixtureRepo } from './fixture-cleanup.testkit.ts';
import type { WorkflowDef } from './types.ts';

const workflow: WorkflowDef = {
  name: 'prelaunch-cancel', source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};
const modes = ['fresh', 'Continue'] as const;

/** Subscribe before releasing setup, so even a synchronous status write cannot be missed. */
function runStatus(store: RunStore, id: string, status: RunStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(guard);
      store.off('run', check);
      if (error) reject(error); else resolve();
    };
    const check = (run: RunRecord | undefined = store.getRun(id)) => {
      if (run?.id !== id) return;
      if (run.status === status) finish();
      else if (['done', 'review', 'failed', 'cancelled'].includes(run.status)) {
        finish(new Error(`Expected ${id} to reach ${status}, got ${run.status}: ${run.error ?? ''}`));
      }
    };
    // bound: fork #1325 measured the real mock park at p95 5.4 s under load. This 20 s
    // hang guard covers that child plus SQLite writes; the run event ends the wait.
    const guard = setTimeout(() => finish(new Error(`Run ${id} did not reach ${status}; status ${store.getRun(id)?.status}`)), 20_000);
    store.on('run', check);
    check();
  });
}

// bound: leave room for the 20 s per-run event guard and fixture setup; the package default is 30 s.
describe('Stop during CI-tool prelaunch setup (#493)', { timeout: 30_000 }, () => {
  const projects: Array<{ root: string; store: RunStore; manager: RunManager }> = [];
  let controller: CiToolController;
  let releaseSetup: () => void;
  let setupEntered: Promise<void>;
  let launchEntered: Promise<void>;
  let setup: MockInstance<typeof CiToolController.start>;
  let launches: MockInstance<ClaudeCliRunner['startSession']>;

  function project(semaphore: WorkspaceSemaphore) {
    const root = mkdtempSync(join(tmpdir(), 'cez-prelaunch-cancel-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = createFixtureManager(store, root, { semaphore });
    const result = { root, store, manager };
    projects.push(result);
    return result;
  }

  function start(p: ReturnType<typeof project>, mode: typeof modes[number]) {
    if (mode === 'fresh') return p.manager.startRun(workflow, { task: 'test prelaunch', runner: 'claude', worktree: false }).id;
    const prior = p.store.createRun({
      title: 'resume', task: 'resume', workflow: workflow.name, runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    p.store.updateStep(prior.id, 'task', { status: 'done', sessionId: 'prior-session', backend: 'claude' });
    p.store.updateRun(prior.id, { status: 'done', workflowDef: workflow });
    expect(p.manager.continueRun(prior.id)).toEqual({ ok: true });
    return prior.id;
  }

  function watchExecution(p: ReturnType<typeof project>, mode: typeof modes[number]) {
    const method = mode === 'fresh' ? 'execute' : 'runContinuation';
    return vi.spyOn(p.manager as unknown as Record<typeof method, (...args: unknown[]) => Promise<void>>, method);
  }

  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    controller = await CiToolController.start();
    const gate = new Promise<void>(resolve => { releaseSetup = resolve; });
    // Delay only external resource startup; provisioning, scheduling and the
    // synchronous runner seam remain real (the runner uses its offline child).
    let enterSetup: () => void;
    setupEntered = new Promise<void>(resolve => { enterSetup = resolve; });
    setup = vi.spyOn(CiToolController, 'start').mockImplementation(async () => {
      enterSetup();
      await gate;
      return controller;
    });
    let enterLaunch: () => void;
    launchEntered = new Promise<void>(resolve => { enterLaunch = resolve; });
    const startSession = ClaudeCliRunner.prototype.startSession;
    launches = vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockImplementation(function (this: ClaudeCliRunner, ...args) {
      enterLaunch();
      return startSession.apply(this, args);
    });
  });

  afterEach(async () => {
    releaseSetup();
    try {
      for (const { root } of projects.splice(0)) await removeFixtureRepo(root);
    } finally {
      await controller.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it.each(modes)('%s never launches after Stop during setup and releases queued capacity', async mode => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    const a = project(semaphore);
    const b = project(semaphore);
    const revoke = vi.fn();
    a.manager.setDelegationProvisioner(() => ({ env: {}, instructions: '', restrictNativeDelegation: true, revoke }));
    const provision = vi.spyOn(controller, 'provision');
    const execution = watchExecution(a, mode);
    const id = start(a, mode);
    await setupEntered;
    expect(setup).toHaveBeenCalledTimes(1);
    const stepId = a.store.getRun(id)!.currentStepId!;
    expect(launches.mock.calls.length).toBe(0);

    const admission = vi.spyOn(runInternals(b.manager).line, 'pump');
    const queuedExecution = watchExecution(b, 'fresh');
    const queued = b.manager.startRun({ name: 'next', source: 'built-in', steps: [{ id: 'check', command: 'true' }] }, { task: 'next project', worktree: false });
    expect(admission).toHaveBeenCalled();
    await Promise.all(admission.mock.results.map(result => result.value));
    expect(b.store.getRun(queued.id)?.status).toBe('queued');
    expect(semaphore.busy()).toBe(1);

    const queuedDone = runStatus(b.store, queued.id, 'done');
    expect(a.manager.cancel(id)).toBe(true);
    expect(a.store.getRun(id)?.stopping).toBe(true);
    expect(a.manager.continueRun(id).ok).toBe(false);
    expect(revoke).toHaveBeenCalled();
    releaseSetup();
    await Promise.race([execution.mock.results[0]!.value, launchEntered]);
    expect(launches.mock.calls.length).toBe(0);
    expect(a.manager.isActive(id)).toBe(false);
    expect(provision).not.toHaveBeenCalled();
    // Cleared fields are absent once the settled run is read back from runs.db (#779).
    expect(a.store.getRun(id)).toMatchObject({ status: 'cancelled', finishedAt: expect.any(String) });
    expect([a.store.getRun(id)?.stopping, a.store.getRun(id)?.currentStepId]).toEqual([undefined, undefined]);
    expect(a.store.getRun(id)?.steps.find(step => step.id === stepId)?.status).toBe('cancelled');
    await queuedDone;
    expect(b.store.getRun(queued.id)?.status).toBe('done');
    // The durable status precedes execute's finally block, which releases capacity.
    expect(queuedExecution).toHaveBeenCalledTimes(1);
    await queuedExecution.mock.results[0]!.value;
    expect(semaphore.busy()).toBe(0);
  });

  it.each(modes)('%s revokes capability prepared as Stop arrives before launch', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const provision = controller.provision.bind(controller);
    const execution = watchExecution(p, mode);
    const id = start(p, mode);
    let revoke: Mock<() => void> | undefined;
    vi.spyOn(controller, 'provision').mockImplementation(register => {
      const capability = provision(register);
      revoke = vi.fn(capability.revoke);
      // Authority changes before the new capability is returned to the manager,
      // so cancel() cannot revoke it yet. The no-launch path must do so.
      expect(p.manager.cancel(id)).toBe(true);
      return { ...capability, revoke };
    });
    await setupEntered;
    expect(setup).toHaveBeenCalledTimes(1);
    releaseSetup();
    await Promise.race([execution.mock.results[0]!.value, launchEntered]);
    expect(launches.mock.calls.length).toBe(0);
    expect(revoke).toHaveBeenCalled();
    // Cleared fields are absent once the settled run is read back from runs.db (#779).
    expect(p.store.getRun(id)?.status).toBe('cancelled');
    expect([p.store.getRun(id)?.stopping, p.store.getRun(id)?.currentStepId]).toEqual([undefined, undefined]);
    expect(p.manager.isActive(id)).toBe(false);
  });

  it.each(modes)('%s stale setup cannot tear down replacement launch authority', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    // A call-through completion barrier avoids sleeps after releasing setup.
    const execution = watchExecution(p, mode);
    const id = start(p, mode);
    await setupEntered;
    expect(setup).toHaveBeenCalledTimes(1);
    const active = (p.manager as unknown as { active: Map<string, { cancelled: boolean; revokeCiTools?: () => void; revokeDelegation?: () => void }> }).active;
    const previous = active.get(id)!;
    expect(p.manager.cancel(id)).toBe(true);
    const revokeCiTools = vi.fn();
    const revokeDelegation = vi.fn();
    // Inject only the authority replacement, not a fake async runner/session.
    // Old setup must neither drop this state nor overwrite its durable status.
    const replacement = { ...previous, cancelled: false, revokeCiTools, revokeDelegation };
    active.set(id, replacement);
    p.store.updateRun(id, { status: 'waiting', stopping: undefined });
    releaseSetup();
    const completion = execution.mock.results[0]!.value;
    try {
      await Promise.race([completion, launchEntered]);
      expect(launches.mock.calls.length).toBe(0);
      await completion;
      expect(active.get(id) === replacement).toBe(true);
      expect(p.store.getRun(id)?.status).toBe('waiting');
      expect(revokeCiTools).not.toHaveBeenCalled();
      expect(revokeDelegation).not.toHaveBeenCalled();
    } finally {
      // Clean up even on the red baseline, where the stale owner launched.
      for (const result of launches.mock.results) if (result.type === 'return') result.value.interrupt();
      await completion;
      p.manager.dispose();
    }
  });

  it.each(modes)('%s still launches after setup when not stopped', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const provision = vi.spyOn(controller, 'provision');
    const id = start(p, mode);
    await setupEntered;
    expect(setup).toHaveBeenCalledTimes(1);
    expect(launches.mock.calls.length).toBe(0);
    const parked = runStatus(p.store, id, 'waiting');
    releaseSetup();
    await parked;
    expect(p.store.getRun(id)?.status).toBe('waiting');
    expect(launches).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(launches.mock.calls[0]![0].cezarTools).toEqual(provision.mock.results[0]!.value.descriptor);
    expect(launches.mock.results[0]!.value).not.toBeInstanceOf(Promise);
  });

  // hearsay-tools/cezarion#1632: the revalidation after provisioning also holds a launch whose root
  // Finish arrives during setup. Only that check sees the Finish, and only it revokes the
  // delegation the launch was given: Stop and `dropActive` do not reach it here.
  it.each(modes)('%s holds the launch when a root Finish arrives during setup, and revokes what it provisioned', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const revokeDelegation = vi.fn();
    p.manager.setDelegationProvisioner(() => ({ env: {}, instructions: '', restrictNativeDelegation: true, revoke: revokeDelegation }));
    const provision = controller.provision.bind(controller);
    let revokeCiTools: Mock<() => void> | undefined;
    vi.spyOn(controller, 'provision').mockImplementation(register => {
      const capability = provision(register);
      revokeCiTools = vi.fn(capability.revoke);
      return { ...capability, revoke: revokeCiTools };
    });
    const execution = watchExecution(p, mode);
    const id = start(p, mode);
    await setupEntered;
    const stepId = p.store.getRun(id)!.currentStepId!;
    p.store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }]);
    releaseSetup();
    await Promise.race([execution.mock.results[0]!.value, launchEntered]);
    expect(launches.mock.calls.length).toBe(0);
    expect(revokeCiTools).toHaveBeenCalled();
    expect(revokeDelegation).toHaveBeenCalledTimes(1);
    expect(p.store.getRun(id)?.status).toBe('queued');
    expect(p.store.getRun(id)?.steps.find(step => step.id === stepId)?.status).toBe('pending');
    // Held in the queue for the Finish, with no session state left behind.
    const engine = p.manager as unknown as { active: Map<string, unknown>;};
    expect(engine.active.has(id)).toBe(false);
    expect(runInternals(p.manager).line.queue).toContain(id);
  });

  // hearsay-tools/cezarion#1632: a run whose execution stops during setup (here an invalid
  // delegation, one of the stops `workerExecutionStopped` reads) settles cancelled and never launches.
  it.each(modes)('%s never launches when its execution stops during setup', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const execution = watchExecution(p, mode);
    const id = start(p, mode);
    await setupEntered;
    const stepId = p.store.getRun(id)!.currentStepId!;
    p.store.updateRun(id, { delegation: { role: 'invalid' } });
    releaseSetup();
    await Promise.race([execution.mock.results[0]!.value, launchEntered]);
    expect(launches.mock.calls.length).toBe(0);
    expect(p.store.getRun(id)?.status).toBe('cancelled');
    expect(p.store.getRun(id)?.steps.find(step => step.id === stepId)?.status).toBe('cancelled');
    expect(p.manager.isActive(id)).toBe(false);
  });
});
