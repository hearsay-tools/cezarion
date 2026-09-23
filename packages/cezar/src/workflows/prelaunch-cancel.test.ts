import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { CiToolController } from '../ci-wait/controller.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const workflow: WorkflowDef = {
  name: 'prelaunch-cancel', source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};
const waitOptions = { timeout: 5000, interval: 10 };
const modes = ['fresh', 'Continue'] as const;

describe('Stop during CI-tool prelaunch setup (#493)', { timeout: 15_000 }, () => {
  const projects: Array<{ root: string; store: RunStore; manager: RunManager }> = [];
  let controller: CiToolController;
  let releaseSetup: () => void;
  let setup: MockInstance<typeof CiToolController.start>;
  let launches: MockInstance<ClaudeCliRunner['startSession']>;

  function project(semaphore: WorkspaceSemaphore) {
    const root = mkdtempSync(join(tmpdir(), 'cez-prelaunch-cancel-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { semaphore });
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

  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    controller = await CiToolController.start();
    const gate = new Promise<void>(resolve => { releaseSetup = resolve; });
    // Delay only external resource startup; provisioning, scheduling and the
    // synchronous runner seam remain real (the runner uses its offline child).
    setup = vi.spyOn(CiToolController, 'start').mockImplementation(async () => { await gate; return controller; });
    launches = vi.spyOn(ClaudeCliRunner.prototype, 'startSession');
  });

  afterEach(async () => {
    releaseSetup();
    try {
      for (const { root, store, manager } of projects.splice(0)) {
        for (const run of store.listRuns()) manager.cancel(run.id);
        await vi.waitFor(() => expect(store.listRuns().every(run => !manager.isActive(run.id))).toBe(true), waitOptions);
        manager.dispose();
        store.flush();
        rmSync(root, { recursive: true, force: true });
      }
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
    const id = start(a, mode);
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1), waitOptions);
    const stepId = a.store.getRun(id)!.currentStepId!;
    expect(launches.mock.calls.length).toBe(0);

    const admission = vi.spyOn(b.manager as unknown as { pump(): Promise<void> }, 'pump');
    const queued = b.manager.startRun({ name: 'next', source: 'built-in', steps: [{ id: 'check', command: 'true' }] }, { task: 'next project', worktree: false });
    await vi.waitFor(() => expect(admission).toHaveBeenCalled(), waitOptions);
    await Promise.all(admission.mock.results.map(result => result.value));
    expect(b.store.getRun(queued.id)?.status).toBe('queued');
    expect(semaphore.busy()).toBe(1);

    expect(a.manager.cancel(id)).toBe(true);
    expect(a.store.getRun(id)?.stopping).toBe(true);
    expect(a.manager.continueRun(id).ok).toBe(false);
    expect(revoke).toHaveBeenCalled();
    releaseSetup();
    await vi.waitFor(() => expect(!a.manager.isActive(id) || launches.mock.calls.length > 0).toBe(true), waitOptions);
    expect(launches.mock.calls.length).toBe(0);
    expect(a.manager.isActive(id)).toBe(false);
    expect(provision).not.toHaveBeenCalled();
    expect(a.store.getRun(id)).toMatchObject({ status: 'cancelled', stopping: undefined, currentStepId: undefined, finishedAt: expect.any(String) });
    expect(a.store.getRun(id)?.steps.find(step => step.id === stepId)?.status).toBe('cancelled');
    await vi.waitFor(() => expect(b.store.getRun(queued.id)?.status).toBe('done'), waitOptions);
    expect(semaphore.busy()).toBe(0);
  });

  it.each(modes)('%s revokes capability prepared as Stop arrives before launch', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    const provision = controller.provision.bind(controller);
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
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1), waitOptions);
    releaseSetup();
    await vi.waitFor(() => expect(!p.manager.isActive(id) || launches.mock.calls.length > 0).toBe(true), waitOptions);
    expect(launches.mock.calls.length).toBe(0);
    expect(revoke).toHaveBeenCalled();
    expect(p.store.getRun(id)).toMatchObject({ status: 'cancelled', stopping: undefined, currentStepId: undefined });
    expect(p.manager.isActive(id)).toBe(false);
  });

  it.each(modes)('%s stale setup cannot tear down replacement launch authority', async mode => {
    const p = project(new WorkspaceSemaphore({ initial: { maxParallel: 1 } }));
    // A call-through completion barrier avoids sleeps after releasing setup.
    const method = mode === 'fresh' ? 'execute' : 'runContinuation';
    const execution = vi.spyOn(p.manager as unknown as Record<typeof method, (...args: unknown[]) => Promise<void>>, method);
    const id = start(p, mode);
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1), waitOptions);
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
    let settled = false;
    const completion = Promise.resolve(execution.mock.results[0]!.value).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(settled || launches.mock.calls.length > 0).toBe(true), waitOptions);
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
    await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1), waitOptions);
    expect(launches.mock.calls.length).toBe(0);
    releaseSetup();
    await vi.waitFor(() => expect(p.store.getRun(id)?.status).toBe('waiting'), waitOptions);
    expect(launches).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(launches.mock.calls[0]![0].cezarTools).toEqual(provision.mock.results[0]!.value.descriptor);
    expect(launches.mock.results[0]!.value).not.toBeInstanceOf(Promise);
  });
});
