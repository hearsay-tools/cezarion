import { testHome } from '../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';

import { existsSync, readdirSync } from 'node:fs';

import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { scheduledDestroyAttempts, workerCleanupInternals } from './service.testkit.ts';
import { WORKTREE_LOCK_BUSY_ERROR } from './workspace.ts';
import { DelegationService } from './service.ts';

import { f, linux, cadence, settled, destroyOf, listings, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

describe('destroy backoff cadence', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

  it.runIf(linux)('a held destroy runs one full attempt, then skips the ticks that would see the same', async () => {
    await cadence();
    const { workerId } = await settled();
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    // That attempt stopped the fixture's queued worker and wrote the removal's checkpoint before it met
    // the holder; neither is a change, because the key is taken where the attempt decides.
    const reads = vi.spyOn(f.store, 'readEventsAsync');
    const scans = listings();
    const results = dirname(f.store.workerResultSnapshotPath(f.parent.id, workerId, randomUUID()));
    const snapshots = readdirSync(results).sort();
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(4), { timeout: 10_000 });
    // No transcript read, no /proc scan, no snapshot written: nothing it could see changed.
    expect(reads).not.toHaveBeenCalled();
    expect(listings()).toBe(scans);
    expect(readdirSync(results).sort()).toEqual(snapshots);
    expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', remaining: ['worktree', 'branch'] });
  });

  it.runIf(linux)("a project's automatic full attempts run one at a time", async () => {
    const a = await settled(), b = await settled();
    for (const run of [a, b]) {
      const current = f.store.getRun(run.workerId)!;
      if (current.delegation?.role !== 'worker') throw Error('worker');
      f.store.commitDelegation([{ id: run.workerId, delegation: { ...current.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'incomplete', remaining: ['worktree', 'branch'] } } }]);
    }
    // After a restart nothing has been observed yet, so both first ticks attempt in full, at the same moment.
    let inFlight = 0, most = 0;
    const termination = f.manager.awaitRunTermination.bind(f.manager);
    vi.spyOn(f.manager, 'awaitRunTermination').mockImplementation(async (...args) => {
      most = Math.max(most, ++inFlight);
      // bound: not a wait on the product. It holds each termination open for 150 ms, so a second attempt that started at the same 40 ms tick would overlap it and raise `most` above 1.
      try { await sleep(150); return await termination(...args); } finally { inFlight--; }
    });
    const restarted = new DelegationService({ backoff: { fastMs: 40, fastCount: 3, capMs: 300 }, attentionAttempts: 5 });
    const detach = restarted.registerProject({ home: testHome(), id: 'project', root: f.root, store: f.store, manager: f.manager });
    try {
      restarted.armDestroyRetries('project');
      await vi.waitFor(() => { for (const { workerId } of [a, b]) expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(1); }, { timeout: 10_000 });
      expect(most).toBe(1);
      for (const { workerId } of [a, b]) expect(destroyOf(workerId)?.error).not.toBe(WORKTREE_LOCK_BUSY_ERROR);
    } finally { detach(); }
  });

  it.runIf(linux)('asks for attention at the threshold, then waits at least the cap', async () => {
    await cadence();
    const { workerId } = await settled();
    // When each retry state was written: the wait is measured from there, not from whenever a poll notices it.
    const written: Array<{ at: number; attempts: number; nextAt: string; needsAttention?: true | undefined }> = [];
    const commit = f.store.commitDestroyRetry.bind(f.store);
    vi.spyOn(f.store, 'commitDestroyRetry').mockImplementation((id, retry) => {
      if (retry) written.push({ at: Date.now(), ...retry });
      return commit(id, retry);
    });
    await f.service.destroy(f.caller, { workerId });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.needsAttention).toBe(true), { timeout: 10_000 });
    const first = written.find(entry => entry.needsAttention)!;
    expect(first.attempts).toBe(5);
    // Attempt 5 is the first capped delay (300 ms); jitter only stretches it.
    expect(Date.parse(first.nextAt) - first.at).toBeGreaterThanOrEqual(290);
    expect(destroyOf(workerId)).toMatchObject({ phase: 'incomplete', remaining: ['worktree', 'branch'] });
  });

  it.runIf(linux)('a holder that exits inside the fast window lets the destroy complete within it', async () => {
    await cadence({ fastMs: 200, fastCount: 5, capMs: 2_000 });
    const { workerId, workspace, holder } = await settled();
    await f.service.destroy(f.caller, { workerId });
    // Past the fixture's one real change (review -> cancelled): from here every tick skips, so
    // only the holder's exit can start the next full attempt.
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const reached = destroyOf(workerId)!.retry!.attempts;
    const writes = vi.spyOn(f.store, 'commitDestroyRetry');
    const full = scheduledDestroyAttempts(f.service);
    await holder!.close();
    // "Within the fast window" is counted in ticks below, not in wall clock: the window promises the
    // exit is noticed at the next fast tick, which the 10 s bound covers many times over (one 200 ms tick,
    // a readlink and a stat-only check). The full attempt that tick starts is real Git and `/proc` work,
    // awaited rather than timed: at load ~90 it outlasted 5 s and was caught mid-`cleaning`
    // (hearsay-tools/cezarion#1109).
    await vi.waitFor(() => expect(full.length).toBeGreaterThan(0), { timeout: 10_000 });
    await full[0];
    expect(destroyOf(workerId)).toEqual({ requestedAt: expect.any(String), phase: 'complete', remaining: [] });
    // A completed destroy drops the run's retry state too.
    expect(f.store.getRun(workerId)?.destroyRetry).toBeUndefined();
    const attempts = writes.mock.calls.map(([, retry]) => retry?.attempts ?? 0);
    // The next tick after the exit attempts in full and completes, inside the five fast ticks.
    expect(Math.max(reached, ...attempts)).toBeLessThanOrEqual(Math.min(reached + 1, 5));
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)('Clean up resets the backoff: a full attempt now, and the next tick at the fast cadence', async () => {
    await cadence({ fastMs: 1_000, fastCount: 0, capMs: 5_000 }, 1);
    const { workerId } = await settled();
    await f.service.destroy(f.caller, { workerId });
    // The first tick reaches attention at once; the next one is four seconds out.
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.needsAttention).toBe(true), { timeout: 10_000 });
    const reads = vi.spyOn(f.store, 'readEventsAsync');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    expect(await f.service.destroyForHuman('project', workerId)).toMatchObject({ state: 'incomplete' });
    const [cleanup] = workerCleanupInternals(f.service);
    const armed = cleanup?.destroyRetryTimers.get('project')?.get(workerId);
    const delay = timers.mock.calls[timers.mock.results.findIndex(result => result.value === armed)]?.[1];
    timers.mockRestore();
    expect(reads).toHaveBeenCalledOnce();
    expect(destroyOf(workerId)?.retry).toBeUndefined();
    // The re-armed tick runs at the 1 s fast cadence, not four seconds out.
    expect(delay).toBe(1_000);
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBe(1), { timeout: 10_000, interval: 20 });
  });
});
