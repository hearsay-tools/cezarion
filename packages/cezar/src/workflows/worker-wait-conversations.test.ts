import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import {
  checkpoint, controlledWire, manager, parent, restart, root, semaphore,
  store, until, useWorkerWaitFixture, waitOf, worker,
} from './worker-wait.testkit.ts';

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  async function conversationPair() {
    process.env.CEZ_DELEGATION = '1';
    const p = await parent();
    const metadata = store.getRun(p.id)!.delegation!;
    if (metadata.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: p.id, delegation: { ...metadata, permissions: [...metadata.permissions, 'steer'] } }]);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const credentials = new CredentialRegistry();
    const callers = [p, w].map(run => credentials.authenticate(credentials.issue('project', run.id, randomUUID()))!);
    const service = new DelegationService();
    service.registerProject({ id: 'project', root, store, manager });
    return { p, w, service, parentCaller: callers[0]!, workerCaller: callers[1]!, close: () => credentials.close() };
  }

  it('conversation: worker request wait releases capacity and explicit parent reply wakes exactly once', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      expect(semaphore.busy()).toBe(0);
      const reply = { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply' as const, requestId: id, text: 'The parser. mock:hold', timeoutSeconds: 600 };
      await f.service.send(f.parentCaller, reply);
      await until(() => !waitOf(store.getRun(f.w.id)));
      await f.service.send(f.parentCaller, reply);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === reply.id)).toHaveLength(1);
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied', replyId: reply.id })]);
    } finally { f.close(); }
  });

  it('conversation: reply before registration satisfies request wait and is retained after retirement', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Early question mock:hold', timeoutSeconds: 600 });
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: id, text: 'Early reply mock:hold', timeoutSeconds: 600 });
      await until(() => store.getRun(f.w.id)?.status === 'waiting' && !waitOf(store.getRun(f.w.id)) && !!store.getRun(f.w.id)?.agentInputs?.every(input => input.deliveredAt));
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      expect(wait.reason).toBe('outcome');
      await until(() => !waitOf(store.getRun(f.w.id)));
      const metadata = store.getRun(f.w.id)?.delegation;
      expect(metadata && metadata.role !== 'invalid' && metadata.lastWait?.requestOutcomes).toEqual([expect.objectContaining({ requestId: id, status: 'replied' })]);
    } finally { f.close(); }
  });

  it('conversation: incoming question interrupts a parked wait without settling its obligation', async () => {
    const f = await conversationPair();
    try {
      const first = randomUUID();
      await f.service.send(f.workerCaller, { id: first, recipientRunId: f.p.id, kind: 'request', text: 'Need module mock:hold', timeoutSeconds: 600 });
      manager.registerRequestWait(f.w.id, { requestIds: [first], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await until(() => store.getRun(f.p.id)?.status === 'waiting');
      const second = randomUUID();
      await f.service.send(f.parentCaller, { id: second, recipientRunId: f.w.id, kind: 'request', text: 'Which options? mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.w.id)));
      const metadata = store.getRun(f.w.id)?.delegation;
      expect(metadata && metadata.role !== 'invalid' && metadata.lastWait?.reason).toBe('message');
      const rootState = store.getRun(f.p.id)?.delegation;
      expect(rootState?.role === 'root' && rootState.conversation?.outcomes).toEqual([]);
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === second)?.deliveredAt).toBeTruthy();
    } finally { f.close(); }
  });

  it('conversation: request deadlines settle without registering a wait or polling', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Deadline question mock:hold', timeoutSeconds: 1 });
      await until(() => {
        const rootState = store.getRun(f.p.id)?.delegation;
        return rootState?.role === 'root' && rootState.conversation?.outcomes.some(outcome => outcome.requestId === id && outcome.status === 'timed-out') === true;
      });
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(store.getRun(f.p.id)?.status).not.toBe('cancelled');
    } finally { f.close(); }
  });

  it('conversation: restart restores a worker request wait, deadline, and one wake receipt', async () => {
    const f = await conversationPair();
    try {
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'request', text: 'Recovery question mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.p.id)) && !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [id], timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.w.id))?.phase === 'parked');
      await restart();
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      expect(waitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, requestIds: [id], deadline: wait.deadline, phase: 'parked' });
      manager.cancelWorkerWait(f.w.id, wait.id);
      checkpoint('conversation-cancel-wait');
      await until(() => !waitOf(store.getRun(f.w.id)));
      checkpoint('conversation-wake-retired');
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
      manager.reconcileWorkerWaits(); manager.reconcileWorkerWaits();
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
    checkpoint('conversation-test-complete');
    } finally { f.close(); }
  });

  it('conversation: parent waits for replies from two workers without treating the first as an interruption', async () => {
    const f = await conversationPair(); const credentials = new CredentialRegistry();
    try {
      const secondWorker = await worker(f.p.id);
      manager.enqueueOwnedRun(secondWorker.id);
      await until(() => store.getRun(secondWorker.id)?.status === 'waiting');
      const secondCaller = credentials.authenticate(credentials.issue('project', secondWorker.id, randomUUID()))!;
      const first = randomUUID(); const second = randomUUID();
      await f.service.send(f.parentCaller, { id: first, recipientRunId: f.w.id, kind: 'request', text: 'First check mock:hold', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: second, recipientRunId: secondWorker.id, kind: 'request', text: 'Second check mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds: [first, second], mode: 'all', timeoutSeconds: 600 });
      await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
      await f.service.send(f.workerCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: first, text: 'First result mock:hold', timeoutSeconds: 600 });
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked', requestOutcomes: [expect.objectContaining({ requestId: first, status: 'replied' })] });
      await f.service.send(secondCaller, { id: randomUUID(), recipientRunId: f.p.id, kind: 'reply', requestId: second, text: 'Second result mock:hold', timeoutSeconds: 600 });
      await until(() => !waitOf(store.getRun(f.p.id)));
      const metadata = store.getRun(f.p.id)?.delegation;
      expect(metadata?.role === 'root' && metadata.lastWait).toMatchObject({ id: wait.id, reason: 'outcome', requestOutcomes: [expect.objectContaining({ requestId: first }), expect.objectContaining({ requestId: second })] });
      expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.id === wait.id && input.deliveredAt)).toHaveLength(1);
    } finally { credentials.close(); f.close(); }
  });

  it('conversation: a full queue of 32 replies can admit an all-request wake without losing a message', async () => {
    const f = await conversationPair();
    const engine = manager as unknown as { pump(): Promise<void> };
    const pump = vi.spyOn(engine, 'pump').mockResolvedValue();
    const submissions = vi.spyOn(manager as unknown as { submitAgentInput(runId: string, state: unknown, content: Array<{ type: string; text: string }>, id: string): boolean }, 'submitAgentInput');
    try {
      const requestIds = Array.from({ length: 32 }, () => randomUUID());
      for (const id of requestIds) await f.service.send(f.parentCaller, { id, recipientRunId: f.w.id, kind: 'request', text: 'Batch question mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds, mode: 'all', timeoutSeconds: 600 });
      const replyIds: string[] = [];
      for (const requestId of requestIds) {
        const id = randomUUID(); replyIds.push(id);
        await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'reply', requestId, text: 'Batch answer mock:hold', timeoutSeconds: 600 });
      }
      const queued = store.getRun(f.p.id)?.agentInputs ?? [];
      expect(queued.filter(input => !input.deliveredAt)).toHaveLength(32);
      expect(queued.map(input => input.id)).toEqual(replyIds);
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'outcome', wakeId: replyIds.at(-1) });
      expect(queued.at(-1)?.text).toBe('Batch answer mock:hold');
      pump.mockRestore();
      await engine.pump();
      await vi.waitFor(() => {
        expect(store.getRun(f.p.id)?.agentInputs?.filter(input => input.deliveredAt).map(input => input.id)).toEqual(replyIds);
        expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      }, { timeout: 60_000, interval: 20 });
      expect(store.getRun(f.p.id)?.delegation).toMatchObject({ lastWait: { id: wait.id, reason: 'outcome', requestOutcomes: expect.arrayContaining(requestIds.map(requestId => expect.objectContaining({ requestId, status: 'replied' }))) } });
      const delivered = submissions.mock.calls.filter((call, index) => call[0] === f.p.id && submissions.mock.results[index]?.value === true);
      expect(delivered.map(call => call[3])).toEqual(replyIds);
      expect(delivered.at(-1)?.[2][0]?.text).toContain(`Wait ${wait.id} (outcome); request outcomes:`);
      expect(delivered.at(-1)?.[2][0]?.text).toContain('Batch answer mock:hold');
    } finally { pump.mockRestore(); submissions.mockRestore(); f.close(); }
  }, 90_000);

  it('conversation: a monitoring recipient queues its message until scheduler capacity is available', async () => {
    const f = await conversationPair();
    const gate = join(root, 'conversation-monitor-gate');
    try {
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:monitoring' }])).toBe(true);
      await until(() => store.getRun(f.p.id)?.activity === 'monitoring');
      // A real in-flight turn occupies the sole slot until this gate opens.
      controlledWire({ firstResultGate: gate });
      const busy = await worker(f.p.id);
      manager.enqueueOwnedRun(busy.id);
      await until(() => store.getRun(busy.id)?.status === 'running' && semaphore.busy() === 1);
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Progress while monitoring mock:hold', timeoutSeconds: 600 });
      expect(semaphore.busy()).toBe(1);
      expect(store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt).toBeUndefined();
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ reason: 'message', phase: 'wake-pending', wakeId: id });
      writeFileSync(gate, 'release');
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
    } finally { writeFileSync(gate, 'release'); f.close(); }
  });

});
