import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { controlledWire, manager, parent, root, semaphore, store, until, useWorkerWaitFixture, waitOf, worker, work } from './worker-wait-claude.testkit.ts';
import type { TimerWaitEntry, Wait } from '@open-mercato/cezar-contract/waits';
import { conversationPair, turnEnds } from './worker-wait-conversations.testkit.ts';

/** The deadline of the run's open timer: `mock:cezar-wait` opens a cezar_wait timer (hearsay-tools/cezarion#2397). */
const timerDeadlineOf = (run?: { waits?: Wait[] | undefined }) => run?.waits?.find((wait): wait is TimerWaitEntry => wait.kind === 'timer' && wait.phase === 'open')?.deadline;

describe('parent and worker conversation waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  // hearsay-tools/cezarion#1235: the message is a wake of its own, and a monitoring park keeps its
  // slot (hearsay-tools/cezarion#1233), so it takes the message at once without a regular slot.
  it('conversation: a monitoring recipient takes its message on the slot its park keeps', async () => {
    const f = await conversationPair();
    const gate = join(root, 'conversation-monitor-gate');
    try {
      const boundaries = turnEnds(f.p.id);
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:cezar-wait' }])).toBe(true);
      await until(() => turnEnds(f.p.id) > boundaries && store.getRun(f.p.id)?.status === 'waiting' && !!timerDeadlineOf(store.getRun(f.p.id)));
      // A real in-flight turn occupies the sole slot until this gate opens.
      controlledWire({ firstResultGate: gate });
      const busy = await worker(f.p.id);
      manager.enqueueOwnedRun(busy.id);
      await until(() => store.getRun(busy.id)?.status === 'running' && semaphore.busy() === 1);
      const id = randomUUID();
      await f.service.send(f.workerCaller, { id, recipientRunId: f.p.id, kind: 'progress', text: 'Progress while monitoring mock:hold', timeoutSeconds: 600 });
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === id)?.deliveredAt);
      expect(semaphore.busy()).toBe(1);
      expect(store.getRun(busy.id)?.status).toBe('running');
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      writeFileSync(gate, 'release');
    } finally { writeFileSync(gate, 'release'); f.close(); }
  });

  it.each(['fresh', 'continuation'] as const)('inbox race at the %s turn boundary preserves a claimed input', async mode => {
    const gate = join(root, 'inbox-turn-gate');
    let p: Awaited<ReturnType<typeof parent>>;
    if (mode === 'fresh') {
      const wire = controlledWire({ firstResultGate: gate });
      p = await parent(); await until(wire.initialReceived);
    } else {
      p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.finish(p.id)).toBe(true); await until(() => !manager.isActive(p.id));
      const wire = controlledWire({ firstResultGate: gate });
      expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
      await until(wire.initialReceived);
    }
    try {
      const first = { id: randomUUID(), parentRunId: p.id, source: agentInputSchema.shape.source.enum.agent, text: 'claimed message', createdAt: new Date().toISOString(),
        conversation: { senderRunId: randomUUID(), recipientRunId: p.id, kind: 'progress' as const } };
      store.commitAgentInputs(p.id, [first]);
      // Seed through the Task 1 store so removing only Task 2 source proves an actual duplicate-delivery race.
      const claim = { receiptId: randomUUID(), generation: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
      store.claimInboxInputs(p.id, [first.id], claim);
      const later = { ...first, id: randomUUID(), text: 'later arrival' };
      store.commitAgentInputs(p.id, [...store.getRun(p.id)!.agentInputs!, later]);
      writeFileSync(gate, 'release');
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(store.getRun(p.id)?.agentInputs?.map(input => input.deliveredAt)).toEqual([undefined, undefined]);
      expect(manager.acknowledgeInbox(p.id, claim.generation, claim.receiptId)).toBe('acknowledged');
      await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === later.id)?.deliveredAt);
    } finally { writeFileSync(gate, 'release'); }
  });

  // hearsay-tools/cezarion#1235: the message wake is the wait list's admission, not a stand-in wait.
  it.each(['queued', 'admitted'] as const)('inbox ACK retires an unsubmitted message wake (%s) without resolving the request', async mode => {
    const f = await conversationPair();
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    const send = vi.spyOn([...work.liveSessions][0]!, 'sendAgentMessage');
    try {
      const first = randomUUID();
      await f.service.send(f.workerCaller, { id: first, recipientRunId: f.p.id, kind: 'request', text: 'Unanswered request mock:hold', timeoutSeconds: 600 });
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(manager.canClaimInboxInput(f.p.id, first)).toBe(true);
      expect(send).not.toHaveBeenCalled();
      if (mode === 'admitted') {
        send.mockReturnValue(false); capacity.mockRestore(); await semaphore.release();
        await until(() => send.mock.calls.some(call => call[1]?.includes(first)));
        expect(store.getRun(f.p.id)?.agentInputs?.find(input => input.id === first)?.deliveredAt).toBeUndefined();
      }
      const before = structuredClone(store.getRun(f.p.id)?.delegation);
      const beforeOutcomes = before?.role === 'root' ? before.conversation?.outcomes : undefined;
      const generation = randomUUID();
      expect(manager.canClaimInboxInput(f.p.id, first)).toBe(true);
      const receipt = manager.reserveInboxInputs(f.p.id, generation, [first])!;
      manager.reconcileWorkerWaits();
      capacity.mockRestore(); await semaphore.release();
      if (mode === 'queued') {
        // The claimed message owes no wake: the queued one is dropped rather than admitted.
        expect(semaphore.busy()).toBe(0);
        expect(send).not.toHaveBeenCalled();
      }
      expect(manager.acknowledgeInbox(f.p.id, generation, receipt.receiptId)).toBe('acknowledged');
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      const attempts = send.mock.calls.length;
      await semaphore.release();
      expect(send).toHaveBeenCalledTimes(attempts);
      expect(semaphore.busy()).toBe(0);
      const after = store.getRun(f.p.id)?.delegation;
      expect(after?.role === 'root' ? after.conversation?.outcomes : undefined).toEqual(beforeOutcomes);
      expect(store.getRun(f.p.id)?.agentInputs?.find(input => input.id === first)?.deliveredAt).toBeDefined();
    } finally { send.mockRestore(); capacity.mockRestore(); f.close(); }
  });

  it('a claimed message cannot interrupt a registered wait or acquire a wake admission', async () => {
    const f = await conversationPair();
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    const send = vi.spyOn([...work.liveSessions][0]!, 'sendAgentMessage');
    try {
      const request = randomUUID();
      await f.service.send(f.parentCaller, { id: request, recipientRunId: f.w.id, kind: 'request', text: 'Waiting for reply mock:hold', timeoutSeconds: 600 });
      const wait = manager.registerRequestWait(f.p.id, { requestIds: [request], timeoutSeconds: 600 });
      const incoming = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: f.p.id, text: 'claimed progress', createdAt: new Date().toISOString(),
        conversation: { senderRunId: f.w.id, recipientRunId: f.p.id, kind: 'progress' as const } };
      store.commitAgentInputs(f.p.id, [incoming]);
      const generation = randomUUID(); const receipt = manager.reserveInboxInputs(f.p.id, generation, [incoming.id])!;
      manager.reconcileWorkerWaits();
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked' });
      expect(send).not.toHaveBeenCalled();
      expect(manager.releaseInbox(f.p.id, generation, receipt.receiptId)).toBe('released');
      // hearsay-tools/cezarion#1235: the released message wakes the run on its own; the wait stays open.
      expect(waitOf(store.getRun(f.p.id))).toMatchObject({ id: wait.id, phase: 'parked' });
      capacity.mockRestore(); await semaphore.release();
      await until(() => send.mock.calls.some(call => call[1]?.includes(incoming.id)));
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === incoming.id)?.deliveredAt);
      expect(waitOf(store.getRun(f.p.id))?.id).toBe(wait.id);
    } finally { send.mockRestore(); capacity.mockRestore(); f.close(); }
  });
});
