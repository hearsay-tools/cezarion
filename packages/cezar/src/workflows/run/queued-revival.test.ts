import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, makeRunRecord, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../../runs/store.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';
import { TrackedWork } from './tracked-work.ts';
import { reviveQueuedRun, type QueuedRevivalHost } from './queued-revival.ts';
import type { RunModuleContext } from './types.ts';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

// hearsay-tools/squawk#3337: a queued fresh-session retry revives as its continuation, never as the job.
it('revives a queued continuation with no earlier session as that continuation', async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-queued-revival-'));
  const store = RunStore.open(root);
  const context = { createRunner: noRunners, home: testHome(), store, dataDir: root, repoRoot: root,
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false } as RunModuleContext;
  const steps = [
    makeStepState({ id: 'build', kind: STEP_KIND.agent, status: STEP_STATUS.failed, backend: 'claude' }),
    makeStepState({ id: 'verify', kind: STEP_KIND.agent, status: STEP_STATUS.pending }),
    makeStepState({ id: 'continue-1', kind: STEP_KIND.agent, status: STEP_STATUS.pending, synthetic: 'continuation' }),
  ];
  const created = store.createRun({ title: 'held', task: 'build it', workflow: 'quick-task', steps: [] });
  const run = makeRunRecord({ id: created.id, status: RUN_STATUS.queued, runner: 'codex', steps, workflowResumeStepId: 'build', autoResumeReason: 'provider-error',
    continuationMessage: { id: 'continue-1', text: 'A provider error stopped this step. Your instructions: build it', origin: 'lifecycle', createdAt: new Date().toISOString() } });
  const enqueueContinuation = vi.fn(); const enqueueJob = vi.fn();
  const host = { isActive: () => false, workerExecutionStopped: () => false, isSyntheticContinuation: (_run: unknown, step: { synthetic?: string }) => step.synthetic === 'continuation',
    workerStep: () => undefined, resumableSessionId: () => undefined, restartContinuationPrompt: 'Continue.', enqueueContinuation, enqueueJob,
    reviveWorkflow: async () => null } as unknown as QueuedRevivalHost;
  await reviveQueuedRun(context, host, run, 'queue watchdog');
  expect(enqueueJob).not.toHaveBeenCalled();
  expect(enqueueContinuation).toHaveBeenCalledWith(run.id, expect.objectContaining({ stepId: 'continue-1', sessionId: undefined, backend: 'claude',
    prompt: expect.stringContaining('Your instructions: build it') }));
});
