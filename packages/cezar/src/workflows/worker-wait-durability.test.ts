import { InputDelivery } from './run/input-delivery.ts';
import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { RunStore, type RunRecord } from '../runs/store.ts';
import * as runnerFactory from '../core/runner-factory.ts';
import { collectWorkerEvidence } from '../delegation/results.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { currentUsage } from '../core/process-usage.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

import {
  bookkeeping, captureState, checkpoint, collect, controlledWire, executions, fixtureUpdateRun,
  manager, parent, queuedWake, register, reopenRuntime, restart, root, semaphore, setFailureState,
  store, terminal, timeline, track, until, useWorkerWaitFixture, waitOf, lastWaitOf, workerEntryOf, worker,
} from './worker-wait.testkit.ts';
import { blockRunWrites, readPersistedRuns, readPersistedText } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('restart delivers a destroyed worker wake instead of stranding a parked parent', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    fixtureUpdateRun(w.id, { status: 'done' });
    const delegation = store.getRun(w.id)!.delegation;
    if (delegation?.role !== 'worker') throw Error('worker fixture');
    store.commitDelegation([{ id: w.id, delegation: { ...delegation,
      destroy: { requestedAt: new Date().toISOString(), phase: 'complete', remaining: [] } } }]);
    store.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar'));
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.agentInputs?.some(input => input.id === wait.id && !!input.deliveredAt) === true);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id,
      outcomes: [{ workerId: w.id, status: 'done' }] });
  });

  it('a recovered worker wait whose wake input is a queued reply delivers the reply body and the receipt once', async () => {
    // A legacy full-inbox wait took an accepted reply's id as its wake id; the upgrade keeps it as
    // `wakeInputId` (hearsay-tools/cezarion#1235). The reply is still the worker's message.
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    store.flush();
    const replyId = randomUUID(); const body = 'The parser module, reply body marker';
    const disk = readPersistedRuns(join(root, '.ai/cezar')).map(row => {
      if (row.id !== p.id) return row;
      const entry = row.waits.find((found: { id: string }) => found.id === wait.id);
      return { ...row, waits: row.waits.filter((found: { id: string }) => found.id !== wait.id),
        delegation: { ...row.delegation, wait: { id: wait.id, workerIds: [w.id], revisions: entry.revisions, deadline: entry.deadline,
          phase: 'wake-pending', reason: 'outcome', outcomes: [{ workerId: w.id, status: 'done', observedAt: new Date().toISOString() }], wakeId: replyId } },
        agentInputs: [...row.agentInputs ?? [], { id: replyId, source: 'agent', parentRunId: p.id, text: body, createdAt: new Date().toISOString(),
          conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'reply', requestId: randomUUID() } }] };
    });
    const submit = vi.spyOn(InputDelivery.prototype, 'submitAgentInput');
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.lastWaits?.some(found => found.id === wait.id && found.phase === 'delivered') === true);
    const sent = submit.mock.calls.map(([, , content]) => (content as Array<{ text: string }>).map(part => part.text).join('\n'));
    const carrying = sent.filter(text => text.includes(body));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.split(body)).toHaveLength(2);
    expect(carrying[0]).toContain(`Worker wait ${wait.id} (terminal outcome)`);
    expect(sent.filter(text => text.includes(`Worker wait ${wait.id}`))).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === replyId && input.deliveredAt)).toHaveLength(1);
  });

  it('a deadline write failure is contained and retried without losing intent or capacity', async () => {
    // This fault exercises only deadline persistence, never an unrelated live turn.
    const release = join(root, 'release-deadline-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived); const w = await worker(p.id);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const wait = register(p.id, [w.id], 1); // registered: still counts as an executing turn
    const busy = semaphore.busy(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.flush(); const dataDir = join(root, '.ai/cezar'); const disk = readPersistedText(dataDir);
    const unblock = blockRunWrites(dataDir);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(readPersistedText(dataDir)).toBe(disk);
      expect(store.getRun(p.id)?.agentInputs ?? []).toEqual([]);
      expect(semaphore.busy()).toBe(busy);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { unblock(); }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
    expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wait.id });
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
    expect(semaphore.busy()).toBe(busy); warn.mockRestore();
  });

  // hearsay-tools/cezarion#1235: a human message withdraws no list wait; it is accepted beside it.
  it('a queued human message preserves admission, FIFO, attachments and the owed wait without answering an ask on acceptance', async () => {
    const { p, w, wait } = await queuedWake();
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
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
    expect(store.getRun(p.id)?.agentInputs?.map(input => [input.id, input.deliveredAt])).toEqual([[wait.id, undefined]]);
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

  it('a failed queued human message checkpoint publishes no wait, wake, message or admission changes', async () => {
    const { p } = await queuedWake(); store.flush();
    const snapshot = JSON.stringify(store.getRun(p.id));
    const release = blockRunWrites(join(root, '.ai/cezar'));
    try {
      expect(() => manager.enqueueMessage(p.id, [{ type: 'text', text: 'must not be accepted' }])).toThrow();
      expect(JSON.stringify(store.getRun(p.id))).toBe(snapshot);
      expect(semaphore.busy()).toBe(1);
    } finally { release(); }
  });

  for (const crash of ['before-delivery', 'after-delivery', 'checkpoint-failure'] as const) {
    // hearsay-tools/cezarion#1235: accepted durably beside the owed wait, which it no longer withdraws.
    it(`startup human message ${crash}: ${crash === 'checkpoint-failure' ? 'stops delivery and preserves the replay ID' : 'survives restart without double folding or lost input'}`, async () => {
      const { p, w, wait } = await queuedWake();
      const engine = manager as unknown as { agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown> };
      const real = engine.agentEnvForStep.bind(manager);
      let release!: () => void; let entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      engine.agentEnvForStep = async (id, ...args) => {
        if (id === p.id) { entered = true; await gate; }
        return real(id, ...args);
      };
      manager.cancel(w.id); await until(() => entered);
      let checkpoint: unknown[];
      try {
        expect(manager.deferMessage(p.id, [{ type: 'text', text: 'startup human update' },
          { type: 'file', mediaType: 'application/pdf', data: 'YQ==' }])).toBe(true);
        expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending' });
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        store.flush(); checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
        if (crash === 'checkpoint-failure') {
          const commit = store.commitOutcome.bind(store);
          store.commitOutcome = (...args) => {
            if (![args[1]].flat().some(outcome => outcome.kind === 'message-delivered')) return commit(...args);
            const unblock = blockRunWrites(join(root, '.ai/cezar'));
            try { return commit(...args); } finally { unblock(); }
          };
        }
      } finally { release(); }
      await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('startup human update')));
      if (crash === 'checkpoint-failure') {
        // hearsay-tools/cezarion#1233/#1235: the result is still owed, so the failed session counts a
        // failed wake delivery and the run waits for the retry instead of settling `failed`.
        await until(() => store.getRun(p.id)?.error?.includes('human input delivery checkpoint failed') === true);
        expect(store.getRun(p.id)).toMatchObject({ status: 'waiting', waitDeliveryFailures: 1 });
        expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup human update');
        expect(store.readEvents(p.id).filter(event => event.type === 'user-message' && String(event.text).includes('startup human update'))).toHaveLength(1);
        return;
      }
      if (crash === 'after-delivery') {
        expect(store.getRun(p.id)?.queuedMessages?.some(message => message.text === 'startup human update')).not.toBe(true);
        store.flush(); checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
      }
      const eventStart = store.readEvents(p.id).length;
      await restart(false, checkpoint!);
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const afterRestart = store.readEvents(p.id).slice(eventStart).filter(event => event.type === 'user-message');
      const mentions = afterRestart.flatMap(event => String(event.text).match(/startup human update/g) ?? []);
      expect(mentions).toHaveLength(crash === 'before-delivery' ? 1 : 0);
      if (crash === 'before-delivery') expect(afterRestart.find(event => String(event.text).includes('startup human update'))?.images).toHaveLength(1);
      // The owed result reached the agent: the wait is delivered, not withdrawn.
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(lastWaitOf(store.getRun(p.id))).toMatchObject({ id: wait.id });
    });
  }

  it('releases only on yield and admits a live wake behind already queued work', async () => {
    const p = await parent(); const w = await worker(p.id);
    register(p.id, [w.id]); manager.enqueueOwnedRun(w.id);
    expect(store.getRun(w.id)?.status).toBe('queued'); expect(semaphore.busy()).toBe(1);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    await until(() => store.getRun(w.id)?.status === 'running');
    expect(semaphore.busy()).toBe(1); // only child, not parked parent
    const release = join(root, 'release-live-wake-blocker');
    process.env.CEZ_MOCK_RELEASE_FILE = release;
    const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold-gated', runner: 'claude' });
    const explain = () => `worker execution: ${JSON.stringify(store.readWorkerExecution(w.id))}\n${timeline(w.id)}\n${timeline(p.id)}\n${timeline(blocker.id)}`;
    try {
      await until(() => store.getRun(w.id)?.status === 'waiting', explain);
      await until(() => store.getRun(blocker.id)?.status === 'running' &&
        store.readEvents(blocker.id).some(event => event.type === 'turn.started'), explain);
      manager.finish(w.id);
      await until(() => terminal.includes(store.getRun(w.id)?.status ?? ''), explain);
      // Terminal status precedes execution cleanup; only the resolved wait proves the wake is owed.
      // bound: until's 15 s guards execution cleanup and durable wait resolution, not blocker lifetime.
      await until(() => waitOf(store.getRun(p.id))?.phase === 'wake-pending', explain);
      const wake = waitOf(store.getRun(p.id)); expect(wake?.phase).toBe('wake-pending');
      expect(store.getRun(blocker.id)?.status).toBe('running');
      expect(semaphore.busy()).toBe(1);
      expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(p.id)?.agentInputs?.some(i => i.deliveredAt)).not.toBe(true);
      manager.cancel(blocker.id);
      await until(() => !waitOf(store.getRun(p.id)), explain);
      expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
      expect(store.getRun(p.id)?.agentInputs?.[0]).toMatchObject({ id: wake?.wakeId, source: 'lifecycle', parentRunId: p.id, deliveredAt: expect.any(String) });
      expect(store.readEvents(p.id).filter(e => e.type === 'user-message')).toEqual([]);
    } finally { writeFileSync(release, ''); }
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
    // hearsay-tools/cezarion#1235: the entry resolves at its first observation, mid-turn, so the
    // statuses land together in one reconciliation for the result to report every one of them.
    const observe = vi.spyOn(manager, 'reconcileWorkerWaits').mockImplementation(() => {});
    for (const child of children) fixtureUpdateRun(child.run.id, { status: child.status });
    observe.mockRestore(); manager.reconcileWorkerWaits();
    expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('resolved');
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
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(wait.deadline!);
    manager.reconcileWorkerWaits(); vi.useRealTimers();
    await until(() => !waitOf(store.getRun(p.id)));
    expect(store.getRun(w.id)?.status).toBe('waiting');
    expect(store.readEvents(w.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.text).toContain('waiting');
  });

  // hearsay-tools/cezarion#1235: an identical registration returns the open wait, and a question
  // neither withdraws it nor refuses one.
  it('rejects duplicate sets, excessive deadlines and foreign workers; an identical wait stays the open one beside a pending ask', async () => {
    const p = await parent(); const w = await worker(p.id);
    expect(() => register(p.id, [w.id, w.id])).toThrow();
    expect(() => register(p.id, [w.id], 1801)).toThrow();
    expect(() => register(p.id, [randomUUID()])).toThrow();
    const wait = manager.registerWorkerWait(p.id, { workerIds: [w.id] } as never);
    expect(Date.parse(wait.deadline!) - Date.now()).toBeGreaterThan(599_000);
    expect(register(p.id, [w.id]).id).toBe(wait.id);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.sendMessage(p.id, [{ type: 'text', text: 'mock:ask' }]);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
    expect(register(p.id, [w.id]).id).toBe(wait.id);
  });
  it('expires a registered executing parent without freeing its slot or cancelling workers', async () => {
    const p = await parent('mock:slow'); const w = await worker(p.id);
    const wait = register(p.id, [w.id], 1);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(wait.deadline!); manager.reconcileWorkerWaits();
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
      const p = await parent();
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const w = await worker(p.id);
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
    // hearsay-tools/cezarion#1235: a worker entry retires through the wait list's delivery checkpoint.
    const commit = store.commitOutcome.bind(store);
    let retiredStatus: string | undefined;
    store.commitOutcome = (...args) => {
      const committed = commit(...args);
      if (args[0] === p.id && retiredStatus === undefined && [args[1]].flat().some(outcome => outcome.kind === 'delivered') &&
        store.getRun(p.id)?.lastWaits?.some(wait => wait.kind === 'worker' && wait.phase === 'delivered')) {
        const records = readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[];
        retiredStatus = records.find(run => run.id === p.id)?.status;
      }
      return committed;
    };
    register(p.id, [w.id]);
    await until(() => retiredStatus !== undefined);
    expect(retiredStatus).toBe('running');
  });

  it('restart after the delivery checkpoint resumes the parent instead of settling the parked snapshot', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // The old engine's exact crash window, as an older build left it on disk: backend accepted,
    // input receipt committed, but wait retirement and resumeParkedRun's status update had not
    // happened yet. hearsay-tools/cezarion#1235: the wait is `delegation.wait`, not a list entry,
    // and upgrade-on-read reads the run as resumed.
    store.flush();
    const now = new Date().toISOString();
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).map(run => {
      if (run.id !== p.id || run.delegation?.role !== 'root') return run;
      const { waits: _waits, ...legacy } = run;
      return { ...legacy, delegation: { ...run.delegation, wait: { ...wait, phase: 'wake-pending', reason: 'timeout', wakeId: wait.id } },
        agentInputs: [{ id: wait.id, parentRunId: p.id, source: 'lifecycle', text: 'Worker deadline reached', createdAt: now, deliveredAt: now }] };
    });
    expect(disk.find(run => run.id === p.id)).toMatchObject({ status: 'waiting' });
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

  /** A parked parent as an older build left it on disk: its agent worker wait in `delegation.wait`
   *  as `wait`, the list emptied, and `inputs` as its only agent inputs. */
  async function legacyParked(legacyWait: (wait: WorkerWait) => WorkerWait, inputs: (p: RunRecord, w: RunRecord, wait: WorkerWait) => unknown[]) {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    store.flush();
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).map(run => {
      if (run.id !== p.id || run.delegation?.role !== 'root') return run;
      const { waits: _waits, ...legacy } = run;
      return { ...legacy, delegation: { ...run.delegation, wait: legacyWait(wait) }, agentInputs: inputs(p, w, wait) };
    });
    expect(disk.find(run => run.id === p.id)).toMatchObject({ status: 'waiting' });
    return { p, w, wait, disk };
  }

  it('restart delivers the queued wake an upgraded cancelled worker wait left, without reopening the wait', async () => {
    // hearsay-tools/cezarion#1235: an older build cancelled the wait into a `wake-pending` receipt
    // and queued its wake; the parent was still parked, with no session, when it stopped.
    const text = 'Worker wait cancelled, upgraded receipt marker';
    const { p, wait, disk } = await legacyParked(wait => ({ ...wait, phase: 'wake-pending', reason: 'cancelled', wakeId: wait.id }),
      (p, _w, wait) => [{ id: wait.id, parentRunId: p.id, source: 'lifecycle', text, createdAt: new Date().toISOString() }]);
    await restart(false, disk);
    await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt);
    expect(store.getRun(p.id)?.agentInputs).toHaveLength(1);
    expect(store.getRun(p.id)?.lastWaits).toEqual([expect.objectContaining({ id: wait.id, kind: 'worker', phase: 'cancelled' })]);
    expect(store.getRun(p.id)?.waits?.filter(entry => entry.kind === 'worker') ?? []).toEqual([]);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });

  it('restart after a delivered message stand-in resumes the interrupted parent', async () => {
    // The old engine's crash window for a message wake: the provider accepted the message and its
    // delivery was committed, but the stand-in was not yet retired nor the parent resumed.
    const messageId = randomUUID(); const now = new Date().toISOString();
    const { p, disk } = await legacyParked(wait => ({ id: randomUUID(), workerIds: [], outcomes: [], deadline: wait.deadline, phase: 'wake-pending', reason: 'message', wakeId: messageId }),
      (p, w) => [{ id: messageId, parentRunId: p.id, source: 'agent', text: 'Worker progress, delivered before the crash', createdAt: now, deliveredAt: now,
        conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' } }]);
    await restart(false, disk);
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === messageId)).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.[0]?.deliveredAt).toBe(now);
    expect(store.getRun(p.id)?.delegation).not.toHaveProperty('wait');
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

  it('restart after a message stand-in an inbox read acknowledged leaves the parent parked', async () => {
    // An inbox acknowledgement starts no provider turn: there is no interrupted execution to resume.
    const messageId = randomUUID(); const now = new Date().toISOString();
    const claim = { receiptId: randomUUID(), generation: randomUUID(), expiresAt: now, acknowledgedAt: now };
    const { p, disk } = await legacyParked(wait => ({ id: randomUUID(), workerIds: [], outcomes: [], deadline: wait.deadline, phase: 'wake-pending', reason: 'message', wakeId: messageId }),
      (p, w) => [{ id: messageId, parentRunId: p.id, source: 'agent', text: 'Worker progress, read through the inbox', createdAt: now, deliveredAt: now,
        conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' }, inboxClaim: claim }]);
    await restart(false, disk);
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(false);
    expect(manager.isActive(p.id)).toBe(false);
  });

  it('a crash right after the delivery checkpoint recovers a resumed parent that owes nothing', async () => {
    const p = await parent(); const w = await worker(p.id);
    const wait = register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    // hearsay-tools/cezarion#1235: the delivery and the resume are one commit. The disk as that
    // commit left it is the crash image.
    const commit = store.commitOutcome.bind(store);
    let image: unknown[] | undefined;
    store.commitOutcome = (...args) => {
      const committed = commit(...args);
      if (args[0] === p.id && !image && [args[1]].flat().some(outcome => outcome.kind === 'delivered') &&
        store.getRun(p.id)?.lastWaits?.some(wait => wait.phase === 'delivered')) image = readPersistedRuns(join(root, '.ai/cezar'));
      return committed;
    };
    fixtureUpdateRun(w.id, { status: 'done' });
    await until(() => image !== undefined);
    const crashed = (image as RunRecord[]).find(run => run.id === p.id)!;
    expect(crashed).toMatchObject({ status: 'running', lastWaits: [expect.objectContaining({ id: wait.id, phase: 'delivered' })] });
    expect(crashed.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeDefined();
    await restart(false, image);
    await until(() => store.getRun(p.id)?.steps.some(step => step.id === 'continue-1') === true || terminal.includes(store.getRun(p.id)?.status ?? ''));
    expect(store.getRun(p.id)?.steps.some(step => step.id === 'continue-1')).toBe(true);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    expect(waitOf(store.getRun(p.id))).toBeUndefined();
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message')).toEqual([]);
  });

  it('preserves a delegated parent ask across restart and never uses a lifecycle prompt as its answer', async () => {
    const p = await parent('mock:ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(e => e.type === 'ask.requested'));
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    // hearsay-tools/cezarion#1235: upgraded into a list entry, an overdue wait would wake beside the
    // question; one still running keeps this case about the ask.
    const wait: WorkerWait = { id: randomUUID(), workerIds: [w.id], phase: 'parked', deadline: new Date(Date.now() + 600_000).toISOString(), outcomes: [] };
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, wait } }]);
    await restart(); await manager.recover();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(manager.continueRun(p.id).ok).toBe(false);
    expect(store.readEvents(p.id).filter(e => e.type === 'human-input-delivered')).toEqual([]);
    expect(manager.continueRun(p.id, { text: 'Vitest' }).ok).toBe(true);
    // hearsay-tools/cezarion#1235: the answer withdraws nothing; the answered turn parks on the wait.
    await until(() => store.getRun(p.id)?.status === 'waiting' && waitOf(store.getRun(p.id))?.phase === 'parked' &&
      store.readEvents(p.id).some(e => e.type === 'human-input-delivered'));
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, workerIds: [w.id] });
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
      // Its session is still live, which a settled parent never has: back to running before
      // teardown stops it (hearsay-tools/cezarion#1804).
      store.updateRun(p.id, { status: RUN_STATUS.running });
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
    const release = blockRunWrites(join(root, '.ai/cezar'));
    // hearsay-tools/cezarion#1235: an agent worker wait parks through the wait list (`parkOnWaits`).
    const engine = runInternals(manager);
    try {
      expect(() => engine.wakeAdmission.parkOnWaits(p.id, engine.active.get(p.id)!)).toThrow();
      expect(waitOf(store.getRun(p.id))?.phase).toBe('registered');
      expect(semaphore.busy()).toBe(1);
    } finally {
      release();
    }
  });

  it('recovery admits an older queued child before an expired parent wake', async () => {
    const p = await parent(); const w = await worker(p.id, 'mock:slow');
    const explain = (stage: string) => {
      const engine = runInternals(manager);
      return `${stage}\n${JSON.stringify({ ...captureState(), queue: runInternals(manager).line.queue, starting: [...runInternals(manager).line.starting],
        active: [...engine.active.keys()], executions: [...engine.workerExecutions.executions.keys()], workerExecution: store.readWorkerExecution(w.id) })}\n${timeline(p.id)}\n${timeline(w.id)}`;
    };
    // Expire the deadline only after the parent parks; mock startup must not race a 1 s budget.
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked', () => explain('parent wait parks before restart'));
    const entry = workerEntryOf(store.getRun(p.id));
    if (!entry) throw Error('fixture');
    store.commitWait(p.id, { ...entry, deadline: new Date().toISOString() });
    await restart();
    await until(() => store.getRun(w.id)?.status === 'running' || store.getRun(p.id)?.status === 'running',
      () => explain('recovery admits the queued child or parent wake'));
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
        await runInternals(manager).turnBookkeeper.recordTurnEnd(p.id, 'CEZ:TITLE=late disposed callback');
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
