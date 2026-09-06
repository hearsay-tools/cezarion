import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const terminal = ['review', 'done', 'failed', 'cancelled'];
async function until(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 }); }
const waitOf = (run: RunRecord | undefined) => run?.delegation?.role === 'root' ? run.delegation.wait : undefined;

describe('worker waits through RunManager', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  let saved: NodeJS.ProcessEnv;
  const bookkeeping: Promise<unknown>[] = [];
  function track() {
    const internals = manager as unknown as { recordTurnEnd(...args: unknown[]): Promise<unknown> };
    const real = internals.recordTurnEnd.bind(manager);
    internals.recordTurnEnd = (...args) => { const result = real(...args); bookkeeping.push(result); return result; };
  }
  beforeEach(() => {
    saved = { ...process.env };
    process.env.CEZ_DRY_RUN = '1'; process.env.CEZ_AUTONAME = '0';
    root = mkdtempSync(join(tmpdir(), 'cez-worker-wait-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, root, { semaphore }); track();
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const run of store.listRuns()) manager.cancel(run.id);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    await Promise.all(bookkeeping.splice(0));
    manager.dispose(); store.flush();
    rmSync(root, { recursive: true, force: true });
    process.env = saved;
  });
  async function parent(task = 'mock:hold') {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task, runner: 'claude' });
    store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(run.id)?.sessionEverOpened === true);
    return run;
  }
  async function worker(parentId: string, task = 'mock:hold') {
    const id = randomUUID();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const workspace = await planOwnedWorkspace(root, id, sha);
    return store.createOwnedRun({ title: 'worker', task, workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', kind: 'agent', name: 'Task' }] }, parentId, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parentId, workspace,
    }, 'a'.repeat(64));
  }
  function register(parentId: string, ids: string[], seconds = 600) {
    return manager.registerWorkerWait(parentId, workerWaitRequestSchema.parse({ workerIds: ids, timeoutSeconds: seconds }));
  }
  async function restart(fakeClock = false) {
    store.flush(); const disk = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
    for (const run of store.listRuns()) manager.cancel(run.id);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    await Promise.all(bookkeeping.splice(0)); manager.dispose(); store.flush();
    writeFileSync(join(root, '.ai/cezar/runs.json'), disk);
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    if (fakeClock) vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    manager = new RunManager(store, root, { semaphore }); track();
    await manager.recover();
  }

  it('releases only on yield and admits a live wake behind already queued work', async () => {
    const p = await parent(); const w = await worker(p.id);
    register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    expect(store.getRun(w.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await until(() => store.getRun(w.id)?.status === 'running');
    expect(semaphore.busy()).toBe(1); // only child, not parked parent
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
    await until(() => store.getRun(w.id)?.status === 'waiting');
    await until(() => store.getRun(blocker.id)?.status === 'running');
    manager.finish(w.id);
    await until(() => terminal.includes(store.getRun(w.id)?.status ?? ''));
    const wake = waitOf(store.getRun(p.id)); expect(wake?.phase).toBe('wake-pending');
    expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
    manager.reconcileWorkerWaits(); manager.queueWorkerWake(p.id); manager.queueWorkerWake(p.id);
    manager.cancel(blocker.id);
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wake?.wakeId, source: 'lifecycle', parentRunId: p.id, deliveredAt: expect.any(String) });
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });

  for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
    it(`observes ${status} before registration, includes all selected statuses and wakes once`, async () => {
      const p = await parent(); const a = await worker(p.id); const b = await worker(p.id);
      store.updateRun(a.id, { status });
      const wait = register(p.id, [a.id, b.id]);
      expect(wait.phase).toBe('wake-pending'); expect(wait.outcomes[0]?.status).toBe(status);
      await until(() => !waitOf(store.getRun(p.id)));
      const inputs = store.getRun(p.id)?.agentInputs;
      expect(inputs).toHaveLength(1);
      expect(inputs?.[0]?.text).toContain(a.id); expect(inputs?.[0]?.text).toContain(status);
      expect(inputs?.[0]?.text).toContain(b.id); expect(inputs?.[0]?.text).toContain('queued');
      expect(store.readEvents(p.id).filter(e => e.type === 'worker-outcome')).toHaveLength(1);
    });
  }
  it('rejects duplicate sets, excessive deadlines, foreign workers, outstanding waits and pending asks', async () => {
    const p = await parent(); const w = await worker(p.id);
    expect(() => register(p.id, [w.id, w.id])).toThrow();
    expect(() => register(p.id, [w.id], 1801)).toThrow();
    expect(() => register(p.id, [randomUUID()])).toThrow();
    const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id] } as never);
    expect(Date.parse(wait.deadline) - Date.now()).toBeGreaterThan(599_000);
    expect(() => register(p.id, [w.id])).toThrow();
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:ask' }]);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(() => register(p.id, [w.id])).toThrow();
  });
  it('expires a registered executing parent without freeing its slot or cancelling workers', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    const wait = register(p.id, [w.id], 1);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wait.deadline); manager.reconcileWorkerWaits();
    expect(waitOf(store.getRun(p.id))?.phase).toBe('wake-pending');
    expect(semaphore.busy()).toBe(1); expect(store.getRun(w.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
  });
  it('rebuilds a parked deadline on restart, expires without cancelling the queued child', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await restart(true);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(waitOf(store.getRun(p.id))?.phase).toBe('wake-pending');
    vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs?.[0]?.id).toBe(wait.id);
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  for (const phase of ['registered', 'parked', 'wake-pending'] as const) {
    it(`restart reconciles ${phase} before generic waiting settlement and deduplicates recovery`, async () => {
      const p = await parent(); const w = await worker(p.id);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase, deadline: new Date().toISOString(), outcomes: [] };
      const delegation = store.getRun(p.id)!.delegation!;
      if (delegation.role !== 'root') throw Error('fixture');
      store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
      await restart(); await manager.recover();
      await until(() => !waitOf(store.getRun(p.id)));
      expect(store.getRun(p.id)?.agentInputs?.filter(i => i.id === wait.id)).toHaveLength(1);
      expect(store.getRun(p.id)?.steps.filter(s => s.id.startsWith('continue-'))).toHaveLength(1);
      expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
      // The continued handler must also park before DONE/monitoring behavior.
      const again = register(p.id, [w.id]);
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      expect(again.id).not.toBe(wait.id);
    });
  }
  it('preserves a delegated parent ask across restart and never uses a lifecycle prompt as its answer', async () => {
    const p = await parent('mock:ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase: 'parked', deadline: new Date().toISOString(), outcomes: [] };
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
    await restart(); await manager.recover();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(manager.continueRun(p.id).ok).toBe(false);
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id, { text: 'Vitest' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toHaveLength(1);
  });
  for (const status of ['review', 'done', 'failed', 'cancelled'] as const) {
    it(`parent ${status} clears wait and cancels unfinished children, preserving terminal artifacts`, async () => {
      const p = await parent(); const w = await worker(p.id); const done = await worker(p.id);
      store.updateRun(done.id, { status: 'review' }); register(p.id, [w.id]);
      store.updateRun(p.id, { status });
      await until(() => store.getRun(w.id)?.status === 'cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined(); expect(store.getRun(done.id)?.status).toBe('review');
      expect(store.getRun(w.id)?.delegation?.role).toBe('worker');
    });
  }
  it('persists lifecycle continuation origin through a queued restart', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    manager.finish(p.id); await until(() => !manager.isActive(p.id));
    const blocker = await parent('mock:slow');
    expect(manager.continueRun(p.id, { text: 'internal restart' }, true).ok).toBe(true);
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'lifecycle' });
    reopened.flush();
    manager.cancel(blocker.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
  });
  it('controller disposal does not cascade or clear durable waits', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // Stop fixture processes only AFTER disposal; disposal itself must not mutate records.
    const active = (manager as unknown as { active: Map<string, { session?: { interrupt(): void } }> }).active;
    const sessions = [...active.values()].map(s => s.session);
    manager.dispose();
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id); expect(store.getRun(w.id)?.status).toBe('queued');
    for (const session of sessions) session?.interrupt();
    await until(() => terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
});
