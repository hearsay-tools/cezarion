import { expect } from 'vitest';
import { store, useWorkerWaitFixture, waitOf } from './worker-wait-claude.testkit.ts';

export const parkedOnWorkers = (runId: string) =>
  store.getRun(runId)?.status === 'waiting' && waitOf(store.getRun(runId))?.phase === 'parked';

export const expectLegacyFinishRefused = (parentId: string) => {
    const run = store.getRun(parentId)!;
    expect(['queued', 'waiting', 'running']).toContain(run.status);
    expect(run.delegation).not.toHaveProperty('finishRequestedAt');
    expect(run.agentInputs?.some(input => input.source === 'lifecycle' && input.text.startsWith('Workers are still live:'))).toBe(true);
  };

export function useWorkerCapacityFixture() {
useWorkerWaitFixture();
}
