import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlledWire, manager, parent, restart, root, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';

describe('request wait during a parent-resumed opening turn', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('does not treat the opening instruction as a new interruption, including after recovery', async () => {
    const release = join(root, 'opening-turn'); writeFileSync(release, 'go');
    controlledWire({ firstResultGate: release });
    const p = await parent('mock:ask');
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    rmSync(release);
    const now = new Date().toISOString();
    const request = { id: randomUUID(), senderRunId: w.id, recipientRunId: p.id, kind: 'request' as const,
      text: 'Need a decision from parent', createdAt: now, deadline: new Date(Date.now() + 600_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const };
    const opening = { ...request, id: randomUUID(), senderRunId: p.id, recipientRunId: w.id, text: 'Continue the task' };
    const input = { id: opening.id, source: 'agent' as const, parentRunId: p.id, text: opening.text, createdAt: now,
      conversation: { senderRunId: p.id, recipientRunId: w.id, kind: 'request' as const } };
    try {
      expect(manager.continueRun(w.id, { text: opening.text }, true, { rootId: p.id, state: { messages: [request, opening], outcomes: [] }, input }).ok).toBe(true);
      await until(() => (manager as unknown as { active: Map<string, { sessionEverOpened?: boolean }> }).active.get(w.id)?.sessionEverOpened === true);
      const wait = manager.registerRequestWait(w.id, { requestIds: [request.id], timeoutSeconds: 600 });
      expect(wait.phase).toBe('registered');
      expect(store.getRun(w.id)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
      writeFileSync(release, 'go');
      await until(() => waitOf(store.getRun(w.id))?.phase === 'parked');
      expect(waitOf(store.getRun(w.id))).toMatchObject({ id: wait.id, requestIds: [request.id] });
      expect(store.getRun(p.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
      expect(store.getRun(w.id)?.agentInputs?.[0]?.deliveredAt).toBeTruthy();
      await restart();
      expect(waitOf(store.getRun(w.id))).toMatchObject({ id: wait.id, phase: 'parked' });
      const update = { ...opening, id: randomUUID(), kind: 'progress' as const, text: 'New information after park' };
      store.commitConversation(p.id, { messages: [request, opening, update], outcomes: [] }, { recipientRunId: w.id,
        input: { ...input, id: update.id, text: update.text, conversation: { ...input.conversation, kind: 'progress' } } });
      manager.reconcileWorkerWaits();
      expect(waitOf(store.getRun(w.id))).toMatchObject({ id: wait.id, phase: 'wake-pending', reason: 'message', wakeId: update.id });
    } finally { writeFileSync(release, 'go'); }
  });
});
