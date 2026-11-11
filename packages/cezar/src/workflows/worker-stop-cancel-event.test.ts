import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import * as processes from '../core/process-usage.ts';
import { manager, parent, store, until, useWorkerWaitFixture, worker, work } from './worker-wait-claude.testkit.ts';

/**
 * Slice S7, Table B row B12 (.ai/specs/2026-11-03-run-store-owns-exits.md): a worker Stop writes
 * the cancellation's one lifecycle event through its `stop-worker` exit.
 */

const pids = new Map<string, number>();
const liveSession = (id: string) => [...work.liveSessions].find(session => session.pid === pids.get(id) && session.open);

const cancellations = (id: string) => store.readEvents(id)
  .filter(event => event.type === 'lifecycle' && /cancelled/.test(String(event.message))).map(event => event.message);

// Real Git, native mock sessions and process shutdown share this budget.
describe('a worker Stop and its cancellation event', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    pids.clear();
    const register = processes.registerRunProcess;
    vi.spyOn(processes, 'registerRunProcess').mockImplementation((id, pid) => { pids.set(id, pid); register(id, pid); });
  });

  it('a queued worker says it was cancelled while queued, once', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    await until(() => !!liveSession(blocker.id));
    const queued = await worker(p.id);
    manager.enqueueOwnedRun(queued.id);
    expect(store.getRun(queued.id)?.status).toBe(RUN_STATUS.queued);
    expect(manager.cancel(queued.id)).toBe(true);
    expect(store.getRun(queued.id)?.status).toBe(RUN_STATUS.cancelled);
    expect(cancellations(queued.id)).toEqual(['cancelled while queued']);
    manager.cancel(blocker.id);
    // bound: a mock session ends within a second of its interrupt; 15 s covers a loaded host.
    await manager.awaitRunTermination(blocker.id, 15_000);
  });

  it('a transcript that refuses the event does not stop the Stop: the live worker is still interrupted', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:slow');
    manager.enqueueOwnedRun(w.id);
    await until(() => !!liveSession(w.id));
    const interrupt = vi.spyOn(liveSession(w.id)!, 'interrupt');
    const append = store.appendEvent.bind(store);
    const refused = vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
      if (event.type === 'lifecycle' && event.message === 'run cancelled') throw new Error('ENOSPC: no space left on device');
      return append(id, event);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => manager.requestWorkerStop(w.id)).not.toThrow();
      expect(interrupt).toHaveBeenCalledOnce();
      expect(store.getRun(w.id)?.status).toBe(RUN_STATUS.cancelled);
      // bound: a mock session ends within a second of its interrupt; 15 s covers a loaded host.
      expect(await manager.awaitRunTermination(w.id, 15_000)).toBe(true);
      expect(manager.isActive(w.id)).toBe(false);
    } finally { refused.mockRestore(); warn.mockRestore(); }
  });
});
