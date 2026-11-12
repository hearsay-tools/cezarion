import { testHome } from '../home/test-home.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-claude.testkit.ts';

import { existsSync } from 'node:fs';
import { delegationStateSchema } from '@open-mercato/cezar-contract/delegation';


import { describe, expect, it, vi } from 'vitest';

import { workerCleanupInternals } from './service.testkit.ts';

import { DelegationService } from './service.ts';

import { f, linux, cadence, settled, destroyOf, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

/** Resolves once every operation already queued on the service's serialization `key` settled. */
function serializedAfter(service: DelegationService, key: string): Promise<void> {
  const serialized = Reflect.get(service, 'serialized') as (key: string, operation: () => Promise<void>) => Promise<void>;
  return serialized.call(service, key, async () => {});
}

describe('destroy backoff recovery', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

  it.runIf(linux)("an explicit destroy cut off by project replacement leaves the replacement's retry armed", async () => {
    await cadence();
    const { workerId } = await settled();
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    vi.spyOn(f.manager, 'awaitRunTermination').mockReturnValue(gate);
    const explicit = f.service.destroy(f.caller, { workerId });
    await vi.waitFor(() => expect(destroyOf(workerId)?.phase).toBe('terminating'), { timeout: 10_000 });
    const replacementManager = createFixtureManager(f.store, f.root);
    const detachReplacement = f.service.registerProject({ home: testHome(), id: 'project', root: f.root, store: f.store, manager: replacementManager });
    const armed = () => [...workerCleanupInternals(f.service)].some(cleanup => cleanup.destroyRetryTimers.get('project')?.has(workerId));
    try {
      f.service.armDestroyRetries('project');
      expect(armed()).toBe(true);
      release(false);
      await explicit.catch(() => undefined);
      expect(armed()).toBe(true);
    } finally { detachReplacement(); replacementManager.dispose(); }
  });

  it('a thrown attempt records why, and the next tick attempts in full', async () => {
    await cadence();
    const { workerId } = await settled(false);
    vi.spyOn(f.store, 'readEventsAsync').mockRejectedValueOnce(new Error('transcript unreadable'));
    await expect(f.service.destroy(f.caller, { workerId })).rejects.toThrow('transcript unreadable');
    expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', remaining: ['worktree', 'branch'], error: 'transcript unreadable' });
    // Nothing a tick can observe explains a throw, so it is never skipped: the next tick completes.
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
  });

  it('a restart resumes the backoff from the persisted next attempt (guard)', async () => {
    const { workerId, workspace } = await settled(false);
    const run = f.store.getRun(workerId)!;
    if (run.delegation?.role !== 'worker') throw Error('worker');
    f.store.commitDelegation([{ id: workerId, delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'incomplete',
      remaining: ['worktree', 'branch'] } } }]);
    // One instant for the persisted attempt and the restarted service's clock: no wall time passes between them.
    const restartedAt = Date.now();
    f.store.commitDestroyRetry(workerId, { attempts: 7, nextAt: new Date(restartedAt + 2_000).toISOString() });
    const restarted = new DelegationService({ backoff: { fastMs: 40, fastCount: 3, capMs: 5_000 }, now: () => restartedAt });
    const detach = restarted.registerProject({ home: testHome(), id: 'project', root: f.root, store: f.store, manager: f.manager });
    try {
      const [cleanup] = workerCleanupInternals(restarted);
      const timers = vi.spyOn(globalThis, 'setTimeout');
      restarted.armDestroyRetries('project');
      const armed = cleanup?.destroyRetryTimers.get('project')?.get(workerId);
      const delay = timers.mock.calls[timers.mock.results.findIndex(result => result.value === armed)]?.[1];
      timers.mockRestore();
      // The first tick waits out the persisted next attempt, 2 s out, not the 40 ms floor.
      expect(delay).toBe(2_000);
      expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', retry: { attempts: 7 } });
      expect(existsSync(workspace.path)).toBe(true);
    } finally { detach(); }
  });

  it.runIf(linux)('two stuck workers of one parent keep one result pointer each', async () => {
    await cadence();
    const a = await settled(), b = await settled();
    for (const { workerId } of [a, b]) await f.service.destroy(f.caller, { workerId });
    await vi.waitFor(() => { for (const { workerId } of [a, b]) expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(3); }, { timeout: 10_000 });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('root');
    expect(parent.delegation.results?.map(entry => entry.workerId).sort()).toEqual([a.workerId, b.workerId].sort());
    for (const { workerId } of [a, b]) expect(f.store.readWorkerResult(f.parent.id, workerId)).toMatchObject({ workerId });
  });

  it.runIf(linux)('keeps retry state beside the worker delegation, so the stored delegation is what an older cezar parses', async () => {
    await cadence();
    const { workerId } = await settled();
    await f.service.destroy(f.caller, { workerId });
    await vi.waitFor(() => expect(f.store.getRun(workerId)?.destroyRetry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const run = f.store.getRun(workerId)!;
    if (run.delegation?.role !== 'worker') throw Error('worker');
    // The pre-hearsay-tools/cezarion#879 destroy keys exactly: a strict reader that has never heard of retries still parses it.
    expect(Object.keys(run.delegation.destroy!).sort()).toEqual(['error', 'phase', 'remaining', 'requestedAt']);
    expect(delegationStateSchema.safeParse(run.delegation).success).toBe(true);
    expect(await f.service.inspect(f.caller, { workerId })).toMatchObject({ destroy: { phase: 'incomplete', retry: { attempts: run.destroyRetry!.attempts } } });
  });

  it.runIf(linux)('a tick cut off by project replacement writes nothing afterwards (guard)', async () => {
    await cadence();
    const { workerId, holder } = await settled();
    await f.service.destroy(f.caller, { workerId });
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const termination = vi.spyOn(f.manager, 'awaitRunTermination').mockReturnValue(gate);
    // The holder exits, so the next tick makes a full attempt; hold it inside termination.
    await holder!.close();
    await vi.waitFor(() => expect(termination).toHaveBeenCalled(), { timeout: 10_000 });
    const before = structuredClone(destroyOf(workerId));
    const replacementManager = createFixtureManager(f.store, f.root);
    const detachReplacement = f.service.registerProject({ home: testHome(), id: 'project', root: f.root, store: f.store, manager: replacementManager });
    const writes = vi.spyOn(f.store, 'commitDelegation'), retries = vi.spyOn(f.store, 'commitDestroyRetry');
    try {
      release(true);
      // The cut-off tick holds the worker's serialization key until it returns; the next operation
      // on that key runs after every write the tick could make.
      await serializedAfter(f.service, `worker:project:${workerId}`);
      expect(writes).not.toHaveBeenCalled();
      expect(retries).not.toHaveBeenCalled();
      expect(destroyOf(workerId)).toEqual(before);
    } finally { detachReplacement(); replacementManager.dispose(); }
  });
});
