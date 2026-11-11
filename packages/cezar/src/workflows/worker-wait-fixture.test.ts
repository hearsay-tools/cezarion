import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WorkerOperation } from '@open-mercato/cezar-contract';
import { isAuthenticatedCaller } from '../delegation/credentials.ts';
import { captureState, delegatingParent, parent, semaphore, store, useWorkerWaitFixture } from './worker-wait-claude.testkit.ts';

describe('service-ready worker-wait fixture (hearsay-tools/cezarion#1752)', () => {
  useWorkerWaitFixture();

  it.each<{ permissions: WorkerOperation[] }>([{ permissions: [] }, { permissions: ['wait'] }, { permissions: ['spawn', 'wait', 'steer', 'inspect'] }])('opts in with exact permissions $permissions', async ({ permissions }) => {
    const f = await delegatingParent({ permissions });
    expect(store.getRun(f.p.id)?.delegation).toMatchObject({ role: 'root', permissions });
    const caller = f.callerFor(f.p.id);
    expect(isAuthenticatedCaller(caller)).toBe(true);
    expect(f.callerFor(f.p.id)).toBe(caller);
    expect(caller).toMatchObject({ projectId: 'project', runId: f.p.id });
    if (permissions.includes('inspect')) expect(await f.service.list(caller)).toMatchObject({ workers: [] });
    else await expect(f.service.list(caller)).rejects.toMatchObject({ code: 'denied_scope' });
    f.close(); f.close();
    expect(isAuthenticatedCaller(caller)).toBe(false);
    expect(() => f.callerFor(f.p.id)).toThrow('closed');
    await expect(f.service.list(caller)).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('builds the low-level parent with spawn and wait only', async () => {
    const p = await parent();
    expect(store.getRun(p.id)?.delegation).toMatchObject({ role: 'root', permissions: ['spawn', 'wait'] });
  });

  it('reports each startup predicate and step session when the parent start wait times out (hearsay-tools/cezarion#3042)', async () => {
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    onTestFinished(() => capacity.mockRestore());
    // Exercise the failed predicate and its diagnostic path without spending the hang guard.
    const waitFor = vi.spyOn(vi, 'waitFor').mockImplementationOnce(async callback => callback());
    try {
      await expect(parent()).rejects.toThrow(/"toolGenerationPresent":false/);
      const dump = JSON.parse(JSON.stringify(captureState()));
      expect(dump.runs).toEqual([expect.objectContaining({
        active: true, toolGenerationPresent: false, hasSessionId: false,
        steps: [{ id: 'task', sessionId: null }],
        events: expect.stringContaining('events of run'),
      })]);
      expect(dump.ownedOperations).toEqual(expect.any(Array));
    } finally {
      waitFor.mockRestore();
    }
  });
});
