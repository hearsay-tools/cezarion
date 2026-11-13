import { partitionParity, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { expect, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveSeam, waitFor, WORKFLOW_TIMEOUT_CRITERIA } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';
import { workflowDefSchema } from '../workflows/types.ts';

// Compress only the deadline, not the runner, manager, clock or native wire.
// Every adapter's hold scenario lasts at least 500ms. The unfixed manager
// leaves the default enabled and kills that non-final step before its check.
vi.mock('./runner-runtime.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./runner-runtime.ts')>(),
  DEFAULT_RUN_TIMEOUT_MS: 150,
}));

// T1, T2, T3, T5 and T6 test which deadline Squawk passes (`step.timeoutMs ?? 0`,
// workflows/run/step-session.ts) and what a timed-out step does, and run on the shared runner set.
// T7 is their seam row: each runner applies a set `spec.timeoutMs` in place of its own default.
// T4 and T7 run on every runner (core/parity-classes.testkit.ts).
// The family's class drops the cells a runner does not run before a part is chosen.
const cells = (...rows: string[]) => RUNNER_IDS.flatMap(runner => rows.map(row => `${runner} ${row}`));
const PARTS: Readonly<Record<string, readonly string[]>> = {
  defaults: cells('T1', 'T6'),
  'explicit-zero': cells('T2', 'T7'),
  'authored-and-standalone': cells('T3', 'T4', 'T5'),
};

export function describeWorkflowTimeoutParity(part: ParityPart, collect?: ParityCollector): void {
  const { describe, it } = partitionParity(part, PARTS, collect, 'workflow-timeout');
describe('workflow wall-clock policy — #470', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of WORKFLOW_TIMEOUT_CRITERIA) {
      it(`${backend} ${criterion.id} ${criterion.name}`, async () => {
        if (criterion.id === 'T7') {
          // The runner owns how it applies the deadline Squawk passes: zero means none, a longer limit
          // outlives its own default (compressed to 150 ms above; every hold lasts 500 ms), and a
          // shorter one ends the turn with a timed-out error.
          for (const timeoutMs of [0, 15_000]) {
            const observed = await driveSeam(backend, criterion.scenario, { spec: { timeoutMs } });
            expect(observed.v1.filter(e => e.type === 'error'), `timeoutMs ${timeoutMs}`).toEqual([]);
            expect(observed.v1.some(e => e.type === 'turn-end'), `timeoutMs ${timeoutMs}`).toBe(true);
          }
          const killed = await driveSeam(backend, criterion.scenario, { spec: { timeoutMs: 100 } });
          expect(killed.v1.some(e => e.type === 'error' && /timed out/.test(e.message))).toBe(true);
          return;
        }
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
