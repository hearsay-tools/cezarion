import { describe, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveSeam, waitFor, withOwnedInputRun, WORKFLOW_TIMEOUT_CRITERIA } from './harness-parity.testkit.ts';
import { workflowDefSchema } from '../workflows/types.ts';

// Compress only the deadline, not the runner, manager, clock or native wire.
// Every adapter's hold scenario lasts at least 500ms. The unfixed manager
// leaves the default enabled and kills that non-final step before its check.
vi.mock('./runner-runtime.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./runner-runtime.ts')>(),
  DEFAULT_RUN_TIMEOUT_MS: 150,
}));

describe('workflow wall-clock policy — #470', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of WORKFLOW_TIMEOUT_CRITERIA) {
      it(`${backend} ${criterion.id} ${criterion.name}`, async () => {
        if (criterion.id === 'T4') {
          const observed = await driveSeam(backend, criterion.scenario, { spec: { timeoutMs: undefined } });
          expect(observed.v1.some(e => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
          return;
        }
        if (criterion.id === 'T6') {
          await withOwnedInputRun(backend, criterion.scenario, async ({ store, manager, runId }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => ['waiting', 'failed'].includes(store.getRun(runId)?.status ?? ''));
            expect(store.getRun(runId)?.status).toBe('waiting');
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            expect(store.getRun(runId)?.error).toBeUndefined();
          });
          return;
        }
        const workflowDef = workflowDefSchema.parse({ name: 'deadline-test', source: 'file', steps: [
          { id: 'implement', prompt: '{{task}}',
            ...(criterion.id === 'T2' ? { timeoutMs: 0 } : criterion.id === 'T3' ? { timeoutMs: 150 } : criterion.id === 'T5' ? { timeoutMs: 15_000 } : {}) },
          { id: 'verify', command: 'test -f a.txt' },
        ] });
        await withOwnedInputRun(backend, criterion.scenario, async ({ store, manager, runId }) => {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => ['done', 'review', 'failed'].includes(store.getRun(runId)?.status ?? ''));
          await waitFor(() => !manager.isActive(runId));
          const run = store.getRun(runId)!;
          if (criterion.id === 'T3') {
            expect(run.status).toBe('failed');
            expect(run.error).toContain('timed out');
            expect(run.steps[0]?.status).toBe('failed');
            expect(store.readEvents(runId).some(e => e.type === 'check-output')).toBe(false);
          } else {
            expect(run.error).toBeUndefined();
            expect(run.steps.map(s => s.status)).toEqual(['done', 'done']);
            expect(store.readEvents(runId).filter(e => e.type === 'check-output')).toMatchObject([
              { stepId: 'verify', exitCode: 0 },
            ]);
          }
        }, { workflowDef });
      }, 30_000);
    }
  }
});
