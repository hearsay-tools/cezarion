import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { controlledWire, fixtureUpdateRun, manager, parent, root, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

describe('conversation backlog delivery (#475)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  it('delivers updates from multiple completed senders together at the next safe boundary', async () => {
    const release = join(root, 'release-turn'); const wire = controlledWire({ firstResultGate: release });
    const p = await parent(); await until(wire.initialReceived);
    const a = await worker(p.id); const b = await worker(p.id);
    const session = (manager as unknown as { active: Map<string, { session: AgentSession }> }).active.get(p.id)!.session;
    const send = vi.spyOn(session, 'sendAgentMessage');
    const createdAt = new Date().toISOString();
    const messages = [a, b, a].map((sender, i) => ({ id: randomUUID(), senderRunId: sender.id, recipientRunId: p.id,
      kind: i === 1 ? 'request' as const : 'progress' as const, text: ['Initial result', 'Need an answer', 'Correction: use the newer result'][i]!,
      createdAt, requestHash: 'a'.repeat(64), state: 'accepted' as const,
      ...(i === 1 ? { deadline: new Date(Date.now() - 1).toISOString() } : {}),
    }));
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      store.commitConversation(p.id, { messages: messages.slice(0, i + 1), outcomes: [] }, { recipientRunId: p.id,
        input: { id: m.id, source: 'agent', parentRunId: p.id, text: m.text, createdAt,
          conversation: { senderRunId: m.senderRunId, recipientRunId: p.id, kind: m.kind } } });
    }
    manager.reconcileWorkerWaits();
    fixtureUpdateRun(a.id, { status: 'done' }); fixtureUpdateRun(b.id, { status: 'done' });
    manager.deliverConversationInput(p.id);
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).toBe(false);
    try {
      writeFileSync(release, 'go');
      await until(() => store.getRun(p.id)?.agentInputs?.every(input => !!input.deliveredAt) === true);
      const accepted = send.mock.calls.filter((_, i) => send.mock.results[i]?.value !== false);
      expect(accepted).toHaveLength(1);
      const payload = JSON.stringify(accepted[0]);
      for (const message of messages) { expect(payload).toContain(message.id); expect(payload).toContain(message.text); }
      expect(new Set(store.getRun(p.id)?.agentInputs?.map(input => input.deliveredAt)).size).toBe(1);
      expect(store.getRun(p.id)?.delegation).toMatchObject({ conversation: { outcomes: [{ requestId: messages[1]!.id, status: 'timed-out' }] } });
      expect(payload).toContain('timed-out');
    } finally { writeFileSync(release, 'go'); }
  });
});
