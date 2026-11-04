import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from './store.ts';
import { readPersistedRuns, setRunStatus } from './run-store.testkit.ts';

it('seeds a terminal fixture without exit settlement and keeps completion-option durability', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cez-set-status-'));
  const store = RunStore.open(dataDir, { keepLive: true });
  try {
    const run = store.createRun({ title: 'fixture', task: 'fixture', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { autoMergePr: true });
    const seeded = setRunStatus(store, run.id, RUN_STATUS.done, { currentStepId: 'fixture-cursor' });
    expect(seeded).toMatchObject({ status: RUN_STATUS.done, currentStepId: 'fixture-cursor' });
    expect(seeded?.finishedAt).toBeUndefined();
    // Read before flush or close: done with a completion option must commit immediately.
    expect(readPersistedRuns(dataDir)).toEqual([expect.objectContaining({ id: run.id, status: RUN_STATUS.done, currentStepId: 'fixture-cursor' })]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
