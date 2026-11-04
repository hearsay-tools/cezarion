import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runInternals } from './run-internals.testkit.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type RunRecord } from '../runs/store.ts';
import { manager, parent, restart, root, store, until } from './worker-wait.testkit.ts';
import { setRunStatus, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

it.each(['delayed diff', 'failed diff'])('cancellation retires pending Finish after %s and preserves human Continue across restart', async mode => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    const settle = runInternals(manager).runSettlement.settleSuccess.bind(runInternals(manager).runSettlement);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let completion: Promise<void> | undefined;
    runInternals(manager).runSettlement.settleSuccess = (id, durable) => completion = (mode === 'delayed diff' ? gate : Promise.resolve()).then(() => settle(id, durable));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      if (mode === 'failed diff') store.updateRun(p.id, { baseBranch: 'nonexistent-ref' });
      expect(manager.finish(p.id)).toBe(true);
      expect(completion).toBeInstanceOf(Promise);
      if (mode === 'failed diff') await until(() => warn.mock.calls.length > 0);
      expect(manager.cancel(p.id)).toBe(true);
      // Read disk without flush: cancellation and retirement are one durable checkpoint.
      const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).find(run => run.id === p.id)!;
      expect(disk.status).toBe('cancelled');
      expect(disk.delegation).not.toHaveProperty('finishRequestedAt');
      release(); await completion?.catch(() => {});
      expect(store.getRun(p.id)?.status).toBe('cancelled');
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      store.updateRun(p.id, { baseBranch: 'main' });
      await restart();
      expect(manager.continueRun(p.id, { text: 'actual human answer mock:hold' }).ok).toBe(true);
      await until(() => store.getRun(p.id)?.status === 'waiting');
    } finally { release(); await completion?.catch(() => {}); warn.mockRestore(); }
  });

it('restart durably reconciles cancelled roots with superseded Finish intent', async () => {
    const p = await parent('mock:cezar-ask'); await until(() => store.getRun(p.id)?.status === 'waiting'); await restart();
    store.commitRootFinishIntent(p.id);
    setRunStatus(store, p.id, RUN_STATUS.cancelled, { finishedAt: new Date().toISOString() });
    store.flush(); const checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
    await restart(false, checkpoint);
    expect(store.getRun(p.id)?.status).toBe('cancelled');
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).find(run => run.id === p.id)!;
    expect(disk.delegation).not.toHaveProperty('finishRequestedAt');
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id)).toMatchObject({ ok: false, error: 'pending human question requires an explicit answer' });
    expect(manager.continueRun(p.id, { text: 'actual human answer mock:hold' }).ok).toBe(true);
    await until(() => store.readEvents(p.id).some(event => event.type === 'human-input-delivered'));
  });
});
