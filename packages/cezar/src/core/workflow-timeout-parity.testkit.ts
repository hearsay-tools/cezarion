import { partitionParity, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { expect, vi } from 'vitest';
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

const PARTS: Readonly<Record<string, readonly string[]>> = {
  "defaults": [
    "claude T1",
    "claude T6",
    "codex T1",
    "codex T6",
    "cursor T1",
    "cursor T6",
    "omp T1",
    "omp T6",
    "opencode T1",
    "opencode T6",
    "pi T1",
    "pi T6"
  ],
  "explicit-zero": [
    "claude T2",
    "codex T2",
    "cursor T2",
    "omp T2",
    "opencode T2",
    "pi T2"
  ],
  "authored-and-standalone": [
    "claude T3",
    "claude T4",
    "claude T5",
    "codex T3",
    "codex T4",
    "codex T5",
    "cursor T3",
    "cursor T4",
    "cursor T5",
    "omp T3",
    "omp T4",
    "omp T5",
    "opencode T3",
    "opencode T4",
    "opencode T5",
    "pi T3",
    "pi T4",
    "pi T5"
  ]
};

export function describeWorkflowTimeoutParity(part: ParityPart, collect?: ParityCollector): void {
  const { describe, it } = partitionParity(part, PARTS, collect);
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

}
