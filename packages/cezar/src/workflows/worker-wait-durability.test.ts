import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { withDelayedCommand } from '../core/owned-input-delivery.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

import {
  bookkeeping, captureState, checkpoint, collect, controlledWire, executions, fixtureUpdateRun,
  manager, parent, queuedWake, register, reopenRuntime, restart, root, semaphore, setFailureState,
  store, terminal, track, until, useWorkerWaitFixture, waitOf, worker,
} from './worker-wait.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('a deadline write failure is contained and retried without losing intent or capacity', async () => {
    // This fault exercises only deadline persistence, never an unrelated live turn.
    const release = join(root, 'release-deadline-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const wait = register(p.id, [w.id], 1); // registered: still counts as an executing turn
    const busy = semaphore.busy(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.flush(); const diskPath = join(root, '.ai/cezar/runs.json'); const disk = readFileSync(diskPath, 'utf8');
    const tmpPath = `${diskPath}.tmp`; mkdirSync(tmpPath);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(readFileSync(diskPath, 'utf8')).toBe(disk);
      expect(store.getRun(p.id)?.agentInputs ?? []).toEqual([]);
      expect(semaphore.busy()).toBe(busy);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { rmSync(tmpPath, { recursive: true }); }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
    expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wait.id });
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
    expect(semaphore.busy()).toBe(busy); warn.mockRestore();
  });

  it('queued human withdrawal preserves admission, FIFO and attachments without answering an ask on acceptance', async () => {
    const { p, w } = await queuedWake();
    // Earlier human amendments and a current ask must not disappear when the
    // lifecycle opening is superseded. Acceptance alone is not answer delivery.
    store.updateRun(p.id, { queuedMessages: [{ id: randomUUID(), text: 'earlier human update', createdAt: new Date().toISOString() }] });
    store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    const queued = manager.enqueueMessage(p.id, [{ type: 'text', text: 'new human update' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
      { type: 'file', mediaType: 'application/pdf', data: 'Yg==' }]);
    expect(queued?.images).toHaveLength(2);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs).toEqual([]);
    expect(store.getRun(p.id)?.continuationMessage?.origin).toBe('human');
    expect(store.getRun(p.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.continuationMessage?.origin).toBe('human'); reopened.flush();
    manager.cancel(w.id);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const opening = store.readEvents(p.id).find(event => event.type === 'user-message');
    expect(String(opening?.text).match(/new human update/g)).toHaveLength(1);
    expect(String(opening?.text).indexOf('earlier human update')).toBeLessThan(String(opening?.text).indexOf('new human update'));
    expect(opening?.images).toEqual(queued?.images);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
  });

  it('a failed queued human withdrawal publishes no wait, wake, message or admission changes', async () => {
    const { p } = await queuedWake(); store.flush();
    const snapshot = JSON.stringify(store.getRun(p.id));
    const diskPath = join(root, '.ai/cezar/runs.json'); const disk = readFileSync(diskPath, 'utf8');
    rmSync(diskPath); mkdirSync(diskPath);
    try {
      expect(() => manager.enqueueMessage(p.id, [{ type: 'text', text: 'must not be accepted' }])).toThrow();
      expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
      expect(semaphore.busy()).toBe(1);
    } finally { rmSync(diskPath, { recursive: true }); writeFileSync(diskPath, disk); }
  });

  for (const crash of ['before-delivery', 'after-delivery', 'checkpoint-failure'] as const) {
    it(`startup human withdrawal ${crash}: ${crash === 'checkpoint-failure' ? 'stops delivery and preserves the replay ID' : 'survives restart without double folding or lost input'}`, async () => {
      const { p, w } = await queuedWake();
      const engine = manager as unknown as { agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown> };
      const real = engine.agentEnvForStep.bind(manager);
      let release!: () => void; let entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      engine.agentEnvForStep = async (id, ...args) => {
        if (id === p.id) { entered = true; await gate; }
        return real(id, ...args);
      };
      manager.cancel(w.id); await until(() => entered);
      let checkpoint: string;
      try {
        expect(manager.deferMessage(p.id, [{ type: 'text', text: 'startup human update' },
          { type: 'file', mediaType: 'application/pdf', data: 'YQ==' }])).toBe(true);
        expect(waitOf(store.getRun(p.id))).toBeUndefined();
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        store.flush(); checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
        if (crash === 'checkpoint-failure') {
          const commit = store.commitQueuedMessageDelivery.bind(store);
          store.commitQueuedMessageDelivery = (...args) => {
            const tmpPath = join(root, '.ai/cezar/runs.json.tmp'); mkdirSync(tmpPath);
            try { commit(...args); } finally { rmSync(tmpPath, { recursive: true }); }
          };
        }
      } finally { release(); }
      await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('startup human update')));
      if (crash === 'checkpoint-failure') {
        await until(() => store.getRun(p.id)?.status === 'failed');
        expect(store.getRun(p.id)?.error).toContain('human input delivery checkpoint failed');
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        expect(store.readEvents(p.id).filter(event => event.type === 'user-message' && String(event.text).includes('startup human update'))).toHaveLength(1);
        return;
      }
      if (crash === 'after-delivery') {
        expect(store.getRun(p.id)?.queuedMessages?.some(message => message.text === 'startup human update')).not.toBe(true);
        store.flush(); checkpoint = readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8');
      }
      const eventStart = store.readEvents(p.id).length;
      await restart(false, checkpoint!);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const afterRestart = store.readEvents(p.id).slice(eventStart).filter(event => event.type === 'user-message');
      const mentions = afterRestart.flatMap(event => String(event.text).match(/startup human update/g) ?? []);
      expect(mentions).toHaveLength(crash === 'before-delivery' ? 1 : 0);
      if (crash === 'before-delivery') expect(afterRestart.find(event => String(event.text).includes('startup human update'))?.images).toHaveLength(1);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    });
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
      fixtureUpdateRun(a.id, { status });
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
  it('delivers all 32 terminal outcomes within the input bound without dropping durable summaries', async () => {
    const p = await parent(); checkpoint('32-parent-open'); const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const w = await worker(p.id); ids.push(w.id); checkpoint(`32-created-${i + 1}`);
      fixtureUpdateRun(w.id, { status: 'failed', error: '\u0000'.repeat(4_000) });
    }
    checkpoint('32-before-register'); const wait = register(p.id, ids); checkpoint('32-registered');
    expect(wait.outcomes).toHaveLength(32);
    expect(wait.outcomes.every(outcome => outcome.summary?.length === 4_000)).toBe(true);
    await until(() => !waitOf(store.getRun(p.id)));
    const input = store.getRun(p.id)?.agentInputs?.[0];
    expect(input?.text.length).toBeLessThanOrEqual(100_000);
    for (const id of ids) expect(input?.text).toContain(id);
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(32);
  });

  it('observes completion between registration and park and reports every selected status', async () => {
    // Hold the real wire's first result until every real Git fixture exists.
    // A fixed playback delay cannot establish this ordering on a loaded host.
    const release = join(root, 'release-first-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived);
    const statuses = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const;
    const children = [];
    for (const status of statuses) children.push({ run: await worker(p.id), status });
    const wait = register(p.id, children.map(child => child.run.id));
    expect(wait.phase).toBe('registered');
    for (const child of children) fixtureUpdateRun(child.run.id, { status: child.status });
    writeFileSync(release, 'release');
    await until(() => !waitOf(store.getRun(p.id)));
    const input = store.getRun(p.id)?.agentInputs?.[0];
    for (const child of children) expect(input?.text).toContain(JSON.stringify({ workerId: child.run.id, status: child.status }));
    expect(input?.id).toBe(wait.id);
    expect(store.readEvents(p.id).filter(event => event.type === 'worker-outcome')).toHaveLength(4);
  });

  for (const mode of ['fresh', 'continuation'] as const) {
    for (const marker of ['mock:done', 'mock:monitoring', 'mock:ask'] as const) {
      it(`${mode}: worker wait precedes ${marker} except that a human ask wins`, async () => {
        const p = await parent(mode === 'fresh' ? marker : 'mock:hold');
        if (mode === 'continuation') {
          await until(() => store.getRun(p.id)?.status === 'waiting');
          manager.finish(p.id); await until(() => !manager.isActive(p.id));
          store.updateRun(p.id, { autonomous: true });
          expect(manager.continueRun(p.id, { text: marker }).ok).toBe(true);
          await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(p.id)?.sessionEverOpened === true);
        }
        const w = await worker(p.id); const wait = register(p.id, [w.id]);
        if (marker === 'mock:ask') {
          await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
          expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
          expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
        } else {
          await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
          expect(store.getRun(p.id)?.activity).toBeUndefined();
          expect(store.getRun(p.id)?.status).toBe('waiting');
          expect(semaphore.busy()).toBe(0);
          expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('autonomous — continuing'))).toBe(false);
        }
      });
    }
  }

  it('a parent timeout leaves a waiting child human question unanswered', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:ask');
    const wait = register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    await until(() => store.readEvents(w.id).some(event => event.type === 'ask.requested'));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(wait.deadline);
    manager.reconcileWorkerWaits(); vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).toBe('waiting');
    expect(store.readEvents(w.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.text).toContain('waiting');
  });

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
    const p = await parent(); checkpoint('deadline-parent-open'); const w = await worker(p.id); checkpoint('deadline-worker-created');
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    checkpoint('deadline-before-restart'); await restart(true); checkpoint('deadline-recovered');
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
    await vi.advanceTimersByTimeAsync(600_000); checkpoint('deadline-timer-fired');
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
  it('retiring a delivered wait durably records the resumed status in the same snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    fixtureUpdateRun(w.id, { status: 'done' });
    const commit = store.commitWorkerWaitWithdrawal.bind(store);
    let retiredStatus: string | undefined;
    store.commitWorkerWaitWithdrawal = (...args) => {
      commit(...args);
      if (args[0] === p.id) {
        const records = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[];
        retiredStatus = records.find(run => run.id === p.id)?.status;
      }
    };
    register(p.id, [w.id]);
    await until(() => retiredStatus !== undefined);
    expect(retiredStatus).toBe('running');
  });

  it('restart after the delivery checkpoint resumes the parent instead of settling the parked snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    // Exact crash window: backend accepted, input receipt committed, but wait
    // retirement and resumeParkedRun's status update have not happened yet.
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait: { ...wait, phase: 'wake-pending', wakeId: wait.id } } }]);
    store.commitAgentInputs(p.id, [{ id: wait.id, parentRunId: p.id, source: 'lifecycle',
      text: 'Worker deadline reached', createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() }]);
    await restart();
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

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
  for (const status of ['done', 'failed', 'cancelled'] as const) {
    it(`parent ${status} clears wait and cancels unfinished children, preserving terminal artifacts`, async () => {
      const p = await parent(); const w = await worker(p.id); const done = await worker(p.id);
      fixtureUpdateRun(done.id, { status: 'review' }); register(p.id, [w.id]);
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
  it('backend activity restores an executing parent slot without withdrawing its durable wait', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const engine = manager as unknown as {
      active: Map<string, unknown>;
      makeUiSink(runId: string, stepId: string): unknown;
      handleRunnerUiEvent(runId: string, state: unknown, sink: unknown, event: unknown): void;
    };
    engine.handleRunnerUiEvent(p.id, engine.active.get(p.id), engine.makeUiSink(p.id, 'task'), {
      type: 'turn.started', turnId: randomUUID(),
    });
    expect(store.getRun(p.id)?.status).toBe('running');
    expect(semaphore.busy()).toBe(1);
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
  });

  it('does not release capacity before the parked intent reaches disk', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    register(p.id, [w.id]); store.flush();
    const diskPath = join(root, '.ai/cezar/runs.json');
    const disk = readFileSync(diskPath, 'utf8');
    rmSync(diskPath); mkdirSync(diskPath);
    const engine = manager as unknown as { active: Map<string, unknown>; parkWorkerWait(id: string, state: unknown): boolean };
    try {
      expect(() => engine.parkWorkerWait(p.id, engine.active.get(p.id))).toThrow();
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(semaphore.busy()).toBe(1);
    } finally {
      rmSync(diskPath, { recursive: true }); writeFileSync(diskPath, disk);
    }
  });

  it('recovery admits an older queued child before an expired parent wake', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    register(p.id, [w.id], 1);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root' || !delegation.wait) throw Error('fixture');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait: { ...delegation.wait, deadline: new Date().toISOString() } } }]);
    await restart();
    await until(() => store.getRun(w.id)?.status === 'running' || store.getRun(p.id)?.status === 'running');
    expect(store.getRun(w.id)?.status).toBe('running');
    expect(store.getRun(p.id)?.status).toBe('queued');
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
  });

  for (const mode of ['fresh', 'continuation'] as const) {
    for (const completion of ['result', 'error'] as const) {
      it(`${mode}: disposal ignores late ${completion} and restart retains the wait and children`, async () => {
        const p = await parent();
        if (mode === 'continuation') {
          await until(() => store.getRun(p.id)?.status === 'waiting');
          manager.finish(p.id); await until(() => !manager.isActive(p.id));
          expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
          await until(() => store.getRun(p.id)?.status === 'waiting');
        }
        const w = await worker(p.id); const wait = register(p.id, [w.id]);
        await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
        await Promise.all(bookkeeping.splice(0));
        const state = (manager as unknown as { active: Map<string, { session: { end(): void; sendMessage(content: unknown[]): boolean } }> }).active.get(p.id)!;
        await until(() => currentUsage(p.id) !== undefined);
        manager.dispose();
        const snapshot = JSON.stringify(store.getRun(p.id));
        await manager.recordTurnEnd(p.id, 'CEZ:TITLE=late disposed callback');
        if (completion === 'error') state.session.sendMessage([{ type: 'text', text: 'mock:auth-error' }]);
        else state.session.end();
        await Promise.all(executions.splice(0));
        expect(store.getRun(p.id)?.status).toBe('waiting');
        expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
        expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
        expect(currentUsage(p.id)).toBeUndefined();
        store.flush();
        reopenRuntime();
        await manager.recover();
        expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
        expect(store.getRun(w.id)?.status).not.toBe('cancelled');
      });
    }
  }

  for (const intent of ['cancel'] as const) {
    it(`explicit ${intent} before disposal is not resurrected on restart`, async () => {
      const p = await parent(); const w = await worker(p.id);
      register(p.id, [w.id]); await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      manager[intent](p.id); manager.dispose();
      await Promise.all(executions.splice(0));
      expect(store.getRun(p.id)?.status).toBe(intent === 'cancel' ? 'cancelled' : 'done');
      await Promise.all(bookkeeping.splice(0));
      store.flush();
      reopenRuntime();
      await manager.recover();
      expect(store.getRun(w.id)?.status).toBe('cancelled');
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
    });
  }

  it('controller disposal does not cascade or clear durable waits', async () => {
    const p = await parent(); const w = await worker(p.id); const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // Stop fixture processes only AFTER disposal; disposal itself must not mutate records.
    const active = (manager as unknown as { active: Map<string, { session?: { interrupt(): void } }> }).active;
    const sessions = [...active.values()].map(s => s.session);
    manager.dispose();
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id); expect(store.getRun(w.id)?.status).toBe('queued');
    for (const session of sessions) session?.interrupt();
    await Promise.all(executions.splice(0));
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).toBe('queued');
  });
});
