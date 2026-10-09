import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { historyPaths } from '../runs/history-file.ts';
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { RunManager } from './run.ts';
import { cleanupCheckpoint, seedSettledFamily } from './delegation-reconcile.testkit.ts';

describe('terminal delegation checkpoint reconciliation (#661)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let a: ReturnType<typeof seedSettledFamily>;
  let b: ReturnType<typeof seedSettledFamily>;
  beforeEach(() => {
    vi.stubEnv('CEZ_DELEGATION', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-reconcile-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    a = seedSettledFamily(store, root); b = seedSettledFamily(store, root);
    manager = new RunManager(store, root);
  });
  afterEach(() => {
    manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['parent', 'worker'] as const)('%s checkpoint projects its family without reading unrelated histories', target => {
    const reads = vi.spyOn(store, 'readEvents');
    if (target === 'worker') cleanupCheckpoint(store, a.workerId);
    else store.commitDelegation([{ id: a.parentId, delegation: store.getRun(a.parentId)!.delegation! }]);
    expect(reads.mock.calls.map(([id]) => id)).not.toContain(b.parentId);
    expect(reads.mock.calls.map(([id]) => id)).not.toContain(b.workerId);
    for (const id of [a.parentId, a.workerId]) {
      expect(store.readEvents(id).some(e => e.type === 'conversation-message' && e.projectionId === `conversation-message:${a.messageId}:not-delivered`)).toBe(true);
    }
  });

  it.each(['0', undefined])('does not enter checkpoint reconciliation when CEZ_DELEGATION=%s', flag => {
    vi.stubEnv('CEZ_DELEGATION', flag);
    const reconcile = vi.spyOn(manager, 'reconcileWorkerWaits');
    const reads = vi.spyOn(store, 'readEvents');
    cleanupCheckpoint(store, a.workerId);
    // Retained-result publication updates the terminal parent through this same
    // checkpoint channel; it must not restart global projection either.
    store.commitDelegation([{ id: a.parentId, delegation: store.getRun(a.parentId)!.delegation! }]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(store.getRun(a.workerId)?.delegation).toHaveProperty('destroy.phase', 'terminating');
  });

  it('retains global reconciliation for recovery and explicit callers', () => {
    // The full pass recovery runs (#779): settled families are no longer in memory, and the
    // pass over live families would skip them.
    manager.reconcileAllWorkerFamilies();
    for (const family of [a, b]) expect(store.readEvents(family.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });

  it.each(['boot', 'adopt'] as const)('%s recovery awaits cold family facts before projections', async mode => {
    manager.dispose(); store.close();
    const dataDir = join(root, '.ai/cezar');
    for (const family of [a, b]) for (const id of [family.parentId, family.workerId]) {
      rmSync(historyPaths(dataDir, id).facts, { force: true });
    }
    store = RunStore.open(dataDir, { keepLive: true });
    manager = new RunManager(store, root);
    const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
    if (mode === 'boot') await manager.recover();
    else expect(await manager.adoptOrphanedRun(a.parentId)).toBe(true);
    expect(joins).not.toHaveBeenCalled();
    for (const id of [a.parentId, a.workerId]) {
      expect(store.readEvents(id).some(e => e.type === 'conversation-message')).toBe(true);
    }
    store.close();
  });

  it('does not let the queue watchdog revive a family awaiting recovery facts', async () => {
    store.updateRun(a.parentId, { status: 'queued' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = store.prepareRecoveryFacts.bind(store);
    vi.spyOn(store, 'prepareRecoveryFacts').mockImplementationOnce(async family => {
      await gate; await prepare(family);
    });
    const before = store.readEvents(a.parentId);
    const recovery = manager.recover(a.parentId);
    try {
      await manager.rescueStalledQueue();
      expect(store.readEvents(a.parentId)).toEqual(before);
      expect(store.getRun(a.parentId)?.status).toBe('queued');
    } finally {
      manager.dispose(); release(); await recovery;
    }
  });

  it.each(['dispose', 'failure', 'ready'] as const)('holds reconciliation until readiness and releases the recovery guard on %s', async outcome => {
    manager.dispose(); store.close();
    const dataDir = join(root, '.ai/cezar');
    store = RunStore.open(dataDir, { keepLive: true });
    manager = new RunManager(store, root);
    let release!: () => void;
    let reject!: (reason: Error) => void;
    const gate = new Promise<void>((yes, no) => { release = yes; reject = no; });
    const prepare = store.prepareRecoveryFacts.bind(store);
    vi.spyOn(store, 'prepareRecoveryFacts').mockImplementationOnce(async family => {
      await gate;
      await prepare(family);
    });
    const recovery = manager.recover(a.parentId);
    // The watchdog/global and delegation-checkpoint paths must not project this family yet.
    manager.reconcileWorkerWaits(a.parentId);
    store.commitDelegation([{ id: a.parentId, delegation: store.getRun(a.parentId)!.delegation! }]);
    expect(store.readEvents(a.parentId).some(e => e.type === 'conversation-message')).toBe(false);
    if (outcome === 'dispose') manager.dispose();
    if (outcome === 'failure') {
      const rejected = expect(recovery).rejects.toThrow('facts failed');
      reject(new Error('facts failed'));
      await rejected;
      // A retry must enter recovery, rather than finding a stranded in-flight scope.
      await manager.recover(a.parentId);
    } else { release(); await recovery; }
    expect(store.readEvents(a.parentId).some(e => e.type === 'conversation-message')).toBe(outcome !== 'dispose');
    store.close();
  });

  it.each(['dispose', 'failure', 'foreign', 'completed'] as const)('selected starting-proof readiness retains guard and rechecks %s', async outcome => {
    manager.dispose();
    const generation = store.commitWorkerExecutionStart(a.workerId);
    store.flush(); store.close();
    const dataDir = join(root, '.ai/cezar');
    // Prior-boot proof makes exit conclusive, independent of ambient process enumeration.
    writeFileSync(join(dataDir, 'runs', `${a.workerId}.processes.json`), JSON.stringify({
      generation, controller: { pid: 2147483001, startToken: 'old-boot:100' }, processes: [],
    }));
    store = RunStore.open(dataDir, { keepLive: true }); manager = new RunManager(store, root);
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = store.prepareTranscriptFacts.bind(store);
    vi.spyOn(store, 'prepareTranscriptFacts').mockImplementation(async ids => {
      const selected = [...ids];
      if (selected.includes(a.workerId)) {
        expect(selected).toContain(a.parentId); expect(selected).not.toContain(b.workerId);
        entered(); await gate;
        if (outcome === 'failure') throw Error('selected facts failed');
      }
      await prepare(selected);
    });
    const settlement = vi.spyOn(manager, 'settleOrphanedWorkerExecution');
    const recovery = manager.recover();
    const rejection = outcome === 'failure' ? expect(recovery).rejects.toThrow('selected facts failed') : undefined;
    await ready;
    manager.reconcileWorkerWaits(); await manager.rescueStalledQueue();
    expect(settlement).not.toHaveBeenCalled();
    expect(store.readWorkerExecution(a.workerId)).toMatchObject({ phase: 'starting', generation });
    if (outcome === 'dispose') manager.dispose();
    if (outcome === 'foreign') {
      const refusal = store.writeRefusal.bind(store);
      vi.spyOn(store, 'writeRefusal').mockImplementation(id => id === a.workerId ? 'RUN_IN_USE_ELSEWHERE' : refusal(id));
    }
    if (outcome === 'completed') expect(store.commitWorkerExecutionComplete(a.workerId, generation)).toBe(true);
    release(); if (rejection) await rejection; else await recovery;
    expect(settlement).not.toHaveBeenCalled();
    expect(store.readWorkerExecution(a.workerId)?.phase).toBe(outcome === 'completed' ? 'complete' : 'starting');
    expect(store.readEvents(a.workerId).some(e => e.type === 'lifecycle' && /execution was finalized/.test(String(e.message)))).toBe(false);
    expect((manager as unknown as { recoveryFactsPending: boolean }).recoveryFactsPending).toBe(false);
    store.close();
  });

  it('reconciles only the families with a live member when no family is named', () => {
    store.updateRun(b.workerId, { status: 'running' });
    manager.reconcileWorkerWaits();
    expect(store.readEvents(a.parentId).some(e => e.type === 'conversation-message')).toBe(false);
    expect(store.readEvents(b.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });

  it.each(['family', 'full', 'live'] as const)('does not lose a %s request emitted during reconciliation', scope => {
    // A live family is reached by the unnamed pass; the settled one only by name or the full pass.
    if (scope === 'live') store.updateRun(b.workerId, { status: 'running' });
    const append = store.appendEvent.bind(store);
    let changed = false;
    vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
      if (!changed && id === a.parentId && event.type === 'conversation-message') {
        changed = true;
        if (scope === 'family') cleanupCheckpoint(store, b.workerId);
        else if (scope === 'full') manager.reconcileAllWorkerFamilies();
        else manager.reconcileWorkerWaits();
      }
      return append(id, event);
    });
    cleanupCheckpoint(store, a.workerId);
    expect(changed).toBe(true);
    expect(store.readEvents(b.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });
});

// A finished family is only in runs.db since #779, so a boot repair reaches it only if open loads
// one of its members. Each case seeds what an older controller could leave on a cancelled root
// with no conversation and no live member, the family the sweeps over every run used to reach.
describe('restart repairs on a settled family without a conversation (#779)', () => {
  let root: string;
  let dataDir: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-settled-repair-')); dataDir = join(root, '.ai/cezar'); });
  afterEach(async () => { await drainFixtureManagers(root); rmSync(root, { recursive: true, force: true }); });

  /** A cancelled root with a finished worker, `leftover` written on the root's delegation. */
  function seedCancelledRoot(leftover: (store: RunStore, parentId: string, workerId: string) => void): { parentId: string; workerId: string } {
    const seed = RunStore.open(dataDir);
    const parent = seed.createRun({ title: 'legacy parent', task: 'history', workflow: 'quick-task', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    seed.updateStep(parent.id, 'work', { status: 'done', sessionId: 'previous-session', backend: 'claude' });
    seed.updateRun(parent.id, { status: 'waiting', runner: 'claude', delegation: { role: 'root', permissions: [], receipts: [] } });
    const workerId = randomUUID();
    const worker = seed.createOwnedRun({ title: 'legacy worker', task: 'history', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(), {
      role: 'worker', parentRunId: parent.id, permissions: [], workspace: {
        ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
        path: join(root, 'workers', workerId), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: '0'.repeat(40),
      },
    }, 'a'.repeat(64));
    seed.updateRun(worker.id, { status: 'done' });
    leftover(seed, parent.id, worker.id);
    seed.updateRun(parent.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    seed.close();
    return { parentId: parent.id, workerId: worker.id };
  }

  async function reboot<T>(body: (store: RunStore, manager: RunManager) => T | Promise<T>): Promise<T> {
    const store = RunStore.open(dataDir, { keepLive: true });
    const manager = createFixtureManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    try {
      await manager.recover();
      return await body(store, manager);
    } finally {
      manager.dispose();
      store.close();
    }
  }

  // Older controllers could cancel a root and leave its Finish intent behind. Until the intent is
  // cleared, Continue refuses the root ("parent finish is pending") and its workers through it.
  it('clears a stale Finish intent at boot, lets the root go and Continue admits it', async () => {
    const { parentId, workerId } = seedCancelledRoot((store, id) => store.commitRootFinishIntent(id));
    expect(readPersistedRuns(dataDir).find(run => run.id === parentId)).toMatchObject({ status: 'cancelled', delegation: { finishRequestedAt: expect.any(String) } });
    await reboot((store, manager) => {
      expect(store.getRun(parentId)?.status).toBe('cancelled');
      expect(store.getRun(parentId)?.delegation).not.toHaveProperty('finishRequestedAt');
      store.flush();
      expect(readPersistedRuns(dataDir).find(run => run.id === parentId)?.delegation).not.toHaveProperty('finishRequestedAt');
      // Repaired, the root is finished like any other and leaves memory with its family.
      expect(store.heldIds()).not.toContain(parentId);
      expect(store.heldIds()).not.toContain(workerId);
      expect(manager.continueRun(parentId, { text: 'Pick it back up' }, true)).toEqual({ ok: true });
    });
  });

  // The other repair a settled family's sweep made: a wait left on a finished parent is withdrawn.
  // The `wait` clause of `isLiveRecord` is what loads the root for it.
  it('withdraws a wait left on a cancelled root at boot and lets the root go', async () => {
    const waitId = randomUUID();
    const { parentId } = seedCancelledRoot((store, id, workerId) => store.commitDelegation([{ id, delegation: {
      role: 'root', permissions: [], receipts: [],
      wait: { id: waitId, workerIds: [workerId], outcomes: [], deadline: new Date(Date.now() + 3_600_000).toISOString(), phase: 'parked' },
    } }]));
    await reboot((store) => {
      const delegation = store.getRun(parentId)?.delegation;
      expect(delegation).not.toHaveProperty('wait');
      expect(delegation).toMatchObject({ lastWait: { id: waitId, phase: 'wake-pending' } });
      store.flush();
      expect(store.heldIds()).not.toContain(parentId);
    });
  });
});
