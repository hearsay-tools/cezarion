import { testHome } from '../home/test-home.testkit.ts';
import {
  RUN_STATUS,
  STEP_KIND,
  STEP_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { TrackedWork } from './run/tracked-work.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRunStatus, readPersistedRuns, seedRuns } from '../runs/run-store.testkit.ts';
import { historyPaths } from '../runs/history-file.ts';
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { RunStore } from '../runs/store.ts';
import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, QUEUE_WATCHDOG_MS, RunManager } from './run.ts';
import { cleanupCheckpoint, seedSettledFamily } from './delegation-reconcile.testkit.ts';
import { createRunner } from '../core/runner-factory.ts';

describe('terminal delegation checkpoint reconciliation (#661)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let a: ReturnType<typeof seedSettledFamily>;
  let b: ReturnType<typeof seedSettledFamily>;
  beforeEach(() => {

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    root = mkdtempSync(join(tmpdir(), 'cez-reconcile-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    a = seedSettledFamily(store, root); b = seedSettledFamily(store, root);
    manager = new RunManager(store, root, { createRunner, home: testHome() });
  });
  afterEach(() => {
    manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['parent', 'worker'] as const)('%s checkpoint projects its family and leaves unrelated families unreconciled', target => {
    if (target === 'worker') cleanupCheckpoint(store, a.workerId);
    else store.commitDelegation([{ id: a.parentId, delegation: store.getRun(a.parentId)!.delegation! }]);
    for (const id of [a.parentId, a.workerId]) {
      expect(store.readEvents(id).some(e => e.type === 'conversation-message' && e.projectionId === `conversation-message:${a.messageId}:not-delivered`)).toBe(true);
    }
    for (const id of [b.parentId, b.workerId]) {
      expect(store.readEvents(id).some(e => e.type === 'conversation-message')).toBe(false);
    }
  });

  it('retains global reconciliation for recovery and explicit callers', async () => {
    // The full pass recovery runs (#779): settled families are no longer in memory, and the
    // pass over live families would skip them.
    await manager.recover();
    for (const family of [a, b]) expect(store.readEvents(family.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });

  it('leaves fallback conversation families readable and unchanged during boot recovery', async () => {
    manager.dispose(); store.close();
    renameSync(join(root, '.ai/cezar'), join(root, '.ai/squawk'));
    mkdirSync(join(root, '.ai/cezar'), { recursive: true }); // Keep Squawk as fallback.
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { createRunner, home: testHome() });
    const writes = vi.spyOn(store, 'commitConversation');
    const prepare = vi.spyOn(store, 'prepareRecoveryFacts');
    const before = store.readEvents(a.parentId);
    await manager.recover();
    store.flush();
    expect(store.getRun(a.parentId)).toBeDefined();
    expect(store.readEvents(a.parentId)).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    expect(prepare.mock.calls).not.toContainEqual([a.parentId]);
    expect(existsSync(join(root, '.ai/cezar/runs.db'))).toBe(false);
    expect(store.isFallbackRun(a.parentId)).toBe(true);
    expect(store.isFallbackRun(a.workerId)).toBe(true);
  });

  it('leaves a mixed legacy/fallback family untouched at boot until an explicit control adopts it', async () => {
    manager.dispose();
    setRunStatus(store, a.parentId, RUN_STATUS.running);
    setRunStatus(store, a.workerId, RUN_STATUS.running);
    store.close();
    const primary = join(root, '.ai/cezar');
    const fallback = join(root, '.ai/squawk');
    const records = readPersistedRuns(primary);
    const worker = records.find(run => run.id === a.workerId)!;
    seedRuns(primary, records.filter(run => run.id !== a.workerId));
    seedRuns(fallback, [worker]);
    const history = join(fallback, 'runs', `${a.workerId}.ndjson`);
    // Seed evidence through the public history layout, without opening a fallback store.
    mkdirSync(join(fallback, 'runs'), { recursive: true });
    writeFileSync(history, '{"seq":1,"type":"text","text":"fallback evidence"}\n');
    const databaseBytes = readFileSync(join(fallback, RUNS_DB_FILE));
    const historyBytes = readFileSync(history);
    const rootRow = () => {
      const db = new DatabaseSync(join(primary, RUNS_DB_FILE), { readOnly: true });
      try { return db.prepare('SELECT data, revision FROM runs WHERE id = ?').get(a.parentId); } finally { db.close(); }
    };
    const rootBefore = rootRow();
    store = RunStore.open(primary, { keepLive: true });
    manager = new RunManager(store, root, { createRunner, home: testHome() });
    vi.spyOn(manager, 'continueRun').mockReturnValue({ ok: false, error: 'fixture stops agent launch' });
    expect(store.listWorkersOf(a.parentId).map(run => run.id)).toContain(a.workerId);
    await manager.recover();
    store.flush();
    // Automatic recovery treats the whole family as read only: both runs keep their stored status.
    expect(store.runOwnership(a.parentId)).toBe('fallback');
    expect(store.getRun(a.parentId)?.status).toBe(RUN_STATUS.running);
    expect(store.getRun(a.workerId)?.status).toBe(RUN_STATUS.running);
    expect(store.listRuns().map(run => run.id)).toEqual([]);
    expect(rootRow()).toEqual(rootBefore);
    const db = new DatabaseSync(join(primary, RUNS_DB_FILE), { readOnly: true });
    try { expect(db.prepare('SELECT id FROM runs WHERE id = ?').get(a.workerId)).toBeUndefined(); }
    finally { db.close(); }
    expect(readFileSync(join(fallback, RUNS_DB_FILE))).toEqual(databaseBytes);
    expect(readFileSync(history)).toEqual(historyBytes);
    // An explicit control adopts the family, then the existing orphan adoption recovers it.
    expect(store.adoptFallbackFamily(a.parentId)).toBe(true);
    expect(await manager.adoptOrphanedRun(a.parentId, { stop: true })).toBe(true);
    store.flush();
    expect(store.isFallbackRun(a.workerId)).toBe(false);
    expect(store.getRun(a.parentId)?.status).not.toBe(RUN_STATUS.running);
    expect(readFileSync(join(fallback, RUNS_DB_FILE))).toEqual(databaseBytes);
    expect(readFileSync(history)).toEqual(historyBytes);
  });

  it.each(['boot', 'adopt'] as const)('%s recovery awaits cold family facts before projections', async mode => {
    manager.dispose(); store.close();
    const dataDir = join(root, '.ai/cezar');
    for (const family of [a, b]) for (const id of [family.parentId, family.workerId]) {
      rmSync(historyPaths(dataDir, id).facts, { force: true });
    }
    store = RunStore.open(dataDir, { keepLive: true });
    manager = new RunManager(store, root, { createRunner, home: testHome() });
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
    manager.dispose();
    const work = new TrackedWork();
    manager = new RunManager(store, root, { createRunner, home: testHome(), work });
    const tracked = vi.spyOn(work, 'track');
    setRunStatus(store, a.parentId, RUN_STATUS.queued);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = store.prepareRecoveryFacts.bind(store);
    vi.spyOn(store, 'prepareRecoveryFacts').mockImplementationOnce(async family => {
      await gate; await prepare(family);
    });
    const before = store.readEvents(a.parentId);
    const recovery = manager.recover(a.parentId);
    try {
      await vi.advanceTimersByTimeAsync(QUEUE_WATCHDOG_MS);
      const rescues = tracked.mock.calls.filter(([label]) => label === 'rescueStalledQueue');
      expect(rescues).toHaveLength(1);
      await rescues[0]![1];
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
    manager = new RunManager(store, root, { createRunner, home: testHome() });
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
    store = RunStore.open(dataDir, { keepLive: true });
    const work = new TrackedWork();
    manager = new RunManager(store, root, { createRunner, home: testHome(), work });
    const tracked = vi.spyOn(work, 'track');
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
    manager.reconcileWorkerWaits(); await vi.advanceTimersByTimeAsync(QUEUE_WATCHDOG_MS);
    const rescues = tracked.mock.calls.filter(([label]) => label === 'rescueStalledQueue');
    expect(rescues).toHaveLength(1);
    await rescues[0]![1];
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
    store.close();
  });

  it('reconciles only the families with a live member when no family is named', () => {
    setRunStatus(store, b.workerId, RUN_STATUS.running);
    manager.reconcileWorkerWaits();
    expect(store.readEvents(a.parentId).some(e => e.type === 'conversation-message')).toBe(false);
    expect(store.readEvents(b.parentId).some(e => e.type === 'conversation-message')).toBe(true);
  });

  it.each(['family', 'live'] as const)('does not lose a %s request emitted during reconciliation', scope => {
    // A live family is reached by the unnamed pass; the settled one by its checkpoint.
    if (scope === 'live') setRunStatus(store, b.workerId, RUN_STATUS.running);
    const append = store.appendEvent.bind(store);
    let changed = false;
    vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => {
      if (!changed && id === a.parentId && event.type === 'conversation-message') {
        changed = true;
        if (scope === 'family') cleanupCheckpoint(store, b.workerId);
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
    const parent = seed.createRun({ title: 'legacy parent', task: 'history', workflow: 'quick-task', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
    seed.updateStep(parent.id, 'work', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    setRunStatus(seed, parent.id, RUN_STATUS.waiting, { runner: 'claude', delegation: { role: 'root', permissions: [], receipts: [] } });
    const workerId = randomUUID();
    const worker = seed.createOwnedRun({ title: 'legacy worker', task: 'history', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(), {
      role: 'worker', parentRunId: parent.id, permissions: [], workspace: {
        ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
        path: join(root, 'workers', workerId), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: '0'.repeat(40),
      },
    }, 'a'.repeat(64));
    setRunStatus(seed, worker.id, RUN_STATUS.done);
    leftover(seed, parent.id, worker.id);
    setRunStatus(seed, parent.id, RUN_STATUS.cancelled, { finishedAt: new Date().toISOString() });
    seed.close();
    return { parentId: parent.id, workerId: worker.id };
  }

  async function reboot<T>(body: (store: RunStore, manager: RunManager) => T | Promise<T>): Promise<T> {
    const store = RunStore.open(dataDir, { keepLive: true });
    const manager = createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
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
    expect(readPersistedRuns(dataDir).find(run => run.id === parentId)).toMatchObject({ status: RUN_STATUS.cancelled, delegation: { finishRequestedAt: expect.any(String) } });
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

  // hearsay-tools/cezarion#1301: an older build accepted a root's Finish behind its live workers and
  // stored the intent. With the old engine's completion park gone, recovery settles that Finish
  // as a done blocked by its workers: the intent is cleared and the root is owed the refusal a
  // closed session gets, the queued lifecycle input its next session takes.
  it('routes a stored Finish intent behind a live worker to the completion refusal at boot', async () => {
    const seed = RunStore.open(dataDir);
    const parent = seed.createRun({ title: 'legacy parent', task: 'history', workflow: 'quick-task', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
    seed.updateStep(parent.id, 'work', { status: STEP_STATUS.waiting, sessionId: 'previous-session', backend: 'claude' });
    setRunStatus(seed, parent.id, RUN_STATUS.waiting, { runner: 'claude', delegation: { role: 'root', permissions: [], receipts: [] } });
    const workerId = randomUUID();
    seed.createOwnedRun({ title: 'live worker', task: 'history', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(), {
      role: 'worker', parentRunId: parent.id, permissions: [], workspace: {
        ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
        path: join(root, 'workers', workerId), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: '0'.repeat(40),
      },
    }, 'a'.repeat(64));
    seed.commitRootFinishIntent(parent.id);
    seed.close();
    await reboot(async (store) => {
      await vi.waitFor(() => expect(store.getRun(parent.id)?.agentInputs?.some(input => input.source === 'lifecycle')).toBe(true), { timeout: 15_000 }); // bound: recovery settles the Finish asynchronously
      const run = store.getRun(parent.id)!;
      expect(run.delegation).not.toHaveProperty('finishRequestedAt');
      expect(['done', 'review']).not.toContain(run.status);
      expect(run.agentInputs).toEqual([expect.objectContaining({ source: 'lifecycle', text: expect.stringContaining(`Workers are still live: ${workerId}.`) })]);
      expect(run.agentInputs?.[0]?.text).toContain(COMPLETION_WILL_WAIT);
      expect(run.waits ?? []).toEqual([]);
      expect(store.readEvents(parent.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toBe(true);
    });
  });

  // The other repair a settled family's sweep made: a wait left on a finished parent is withdrawn.
  // Since hearsay-tools/cezarion#1235 the store upgrades the agent's wait into an open list entry,
  // whose `waits` clause of `isLiveRecord` loads the root, and boot recovery cancels it.
  it('withdraws a wait left on a cancelled root at boot and lets the root go', async () => {
    const waitId = randomUUID();
    const { parentId } = seedCancelledRoot((store, id, workerId) => store.commitDelegation([{ id, delegation: {
      role: 'root', permissions: [], receipts: [],
      wait: { id: waitId, workerIds: [workerId], outcomes: [], deadline: new Date(Date.now() + 3_600_000).toISOString(), phase: 'parked' },
    } }]));
    // Only builds before hearsay-tools/cezarion#1301 wrote `delegation.wait`, and their live predicate
    // stored such a row as live; this build's predicate no longer reads the field.
    const db = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    db.prepare('UPDATE runs SET live = 1 WHERE id = ?').run(parentId);
    db.close();
    await reboot((store) => {
      const root = store.getRun(parentId);
      expect(root?.delegation).not.toHaveProperty('wait');
      expect(root?.waits ?? []).toEqual([]);
      expect(root?.lastWaits).toEqual([expect.objectContaining({ id: waitId, kind: WAIT_KIND.worker, phase: WAIT_PHASE.cancelled })]);
      store.flush();
      expect(store.heldIds()).not.toContain(parentId);
    });
  });
});
