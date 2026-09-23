import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unregisterRunProcess } from '../core/process-usage.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const workflow: WorkflowDef = {
  name: 'startup-cancel', source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};
const fixture = fileURLToPath(new URL('./__fixtures__/codex-no-turn.mjs', import.meta.url));
const waitOptions = { timeout: 5000, interval: 10 };
const processExited = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
};

// Keep RunManager, its factory, the Codex adapter, JSON-RPC and OS process real.
// The only substitute is a tiny app-server that never acknowledges initialize.
// A call-through scheduler spy below is only an admission-complete barrier.
// Before #493 even an exited child left bootstrap/result pending, so Stop kept
// the run active, its composer stopping, and another project's task queued.
describe('Stop before the first Codex turn (#493)', { timeout: 15_000 }, () => {
  const projects: Array<{ root: string; store: RunStore; manager: RunManager }> = [];

  function project(semaphore: WorkspaceSemaphore) {
    const root = mkdtempSync(join(tmpdir(), 'cez-codex-startup-'));
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { semaphore });
    const result = { root, store, manager };
    projects.push(result);
    return result;
  }

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_CODEX_BIN', fixture);
    vi.stubEnv('CEZ_AUTONAME', '0');
  });

  afterEach(async () => {
    try {
      for (const { root, manager, store } of projects.splice(0)) {
        // Also clean up on the intentionally-red baseline: its result never
        // settles even after SIGTERM has physically terminated the child.
        for (const record of store.listRuns()) manager.cancel(record.id);
        const ready = join(root, '.codex-startup-ready');
        if (existsSync(ready)) {
          const pid = Number(readFileSync(ready, 'utf8'));
          await vi.waitFor(() => expect(processExited(pid)).toBe(true), waitOptions);
        }
        for (const record of store.listRuns()) unregisterRunProcess(record.id);
        manager.dispose();
        store.flush();
        rmSync(root, { recursive: true, force: true });
      }
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

  it.each(['fresh', 'Continue'] as const)('%s cancellation settles after real exit and admits another project', async mode => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    const a = project(semaphore);
    const b = project(semaphore);
    let runId: string;
    if (mode === 'fresh') {
      runId = a.manager.startRun(workflow, { task: 'wait before the first turn', runner: 'codex', worktree: false }).id;
    } else {
      const prior = a.store.createRun({
        title: 'resume', task: 'resume', workflow: workflow.name, runner: 'codex',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      a.store.updateStep(prior.id, 'task', { status: 'done', sessionId: 'prior-thread', backend: 'codex' });
      a.store.updateRun(prior.id, { status: 'done', workflowDef: workflow });
      expect(a.manager.continueRun(prior.id)).toEqual({ ok: true });
      runId = prior.id;
    }
    const ready = join(a.root, '.codex-startup-ready');
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), waitOptions);
    const pid = Number(readFileSync(ready, 'utf8'));
    const stepId = a.store.getRun(runId)!.currentStepId!;
    expect(a.store.getRun(runId)).toMatchObject({ status: 'running', tokensUsed: 0 });
    expect(a.store.readEvents(runId).some(event => ['session', 'turn.started', 'turn-end', 'text'].includes(event.type))).toBe(false);

    const admission = vi.spyOn(b.manager as unknown as { pump(): Promise<void> }, 'pump');
    const queued = b.manager.startRun({ name: 'next', source: 'built-in', steps: [{ id: 'check', command: 'true' }] }, { task: 'next project', worktree: false });
    // Observe B's real initial sweep finishing while capacity is unavailable.
    // Otherwise that still-pending sweep could admit B without a release wake,
    // and a broken cross-project broadcast would pass this test accidentally.
    await vi.waitFor(() => expect(admission).toHaveBeenCalled(), waitOptions);
    await Promise.all(admission.mock.results.map(result => result.value));
    expect(b.store.getRun(queued.id)?.status).toBe('queued');
    expect(semaphore.busy()).toBe(1);

    expect(a.manager.cancel(runId)).toBe(true);
    expect(a.store.getRun(runId)?.stopping).toBe(true);
    expect(a.manager.continueRun(runId).ok).toBe(false);
    await vi.waitFor(() => expect(processExited(pid)).toBe(true), waitOptions);
    await vi.waitFor(() => expect(a.store.getRun(runId)?.status).toBe('cancelled'), waitOptions);
    expect(a.store.getRun(runId)).toMatchObject({ currentStepId: undefined, stopping: undefined, finishedAt: expect.any(String) });
    expect(a.store.getRun(runId)?.steps.find(step => step.id === stepId)?.status).toBe('cancelled');
    expect(a.manager.isActive(runId)).toBe(false);
    expect(a.store.readEvents(runId).filter(event => event.type === 'lifecycle' && event.message === 'run cancelled')).toHaveLength(1);
    expect(a.store.readEvents(runId)).toContainEqual(expect.objectContaining({ type: 'session.ended', reason: 'cancelled' }));
    expect(a.store.readEvents(runId)).toContainEqual(expect.objectContaining({ type: 'note', message: 'Codex startup: waiting for initialize' }));

    // Nothing pokes pump/refresh: RunManager's actual teardown must broadcast
    // the released slot through the shared workspace semaphore.
    await vi.waitFor(() => expect(b.store.getRun(queued.id)?.status).toBe('done'), waitOptions);
    expect(b.manager.isActive(queued.id)).toBe(false);
    expect(semaphore.busy()).toBe(0);
  });
});
