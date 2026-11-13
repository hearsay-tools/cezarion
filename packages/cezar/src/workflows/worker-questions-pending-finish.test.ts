import { captureSessions } from './runner-session-capture.testkit.ts';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COMPLETION_NUDGE_NOTE } from './run.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { delegatingParent, manager, register, root, semaphore, store, until, waitOf, worker } from './worker-wait.testkit.ts';
import { WAIT_KIND, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { gate, thenSay, toolCall } from './waits-parity.testkit.ts';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { conversationOf, eventsOf, closedAs, noHumanCard, steeringParent, askedPair, expectSettledParentRefusal, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

// The turn end's completion gate still holds a done the tool accepted when a worker's question
  // arrives later in that turn (`deferParentCompletion`). The question is owed input then, so the
  // refusal is a note, beside an open wait or not, and the question reaches the parent's next
  // turn; never a wait on that worker, and no completion nudge beside owed input.
  for (const besideWait of [true, false]) it(`holds a cezar_done accepted before a worker question arrives: a refusal note${besideWait ? ' beside an open wait' : ''}, the question delivered, never a wait on that worker`, async () => {
    // The worker asks while the parent's turn holds its slot.
    const sessionOf = captureSessions();
    const accepted = new Set<string>();
    const handlers = vi.mocked(manager.squawkToolHandlers).getMockImplementation()!;
    vi.mocked(manager.squawkToolHandlers).mockImplementation((id, generation) => {
      const tools = handlers(id, generation);
      return { ...tools, finishTurn: async (...args) => {
        const result = await tools.finishTurn(...args);
        if (result.ok) accepted.add(id);
        return result;
      } };
    });
    vi.spyOn(semaphore, 'maxParallel').mockReturnValue(2);
    const { p, close } = await delegatingParent({ task: 'mock:hold', permissions: ['spawn', 'wait', 'steer'] });
    try {
      await until(() => store.getRun(p.id)?.status === 'waiting');
      const session = sessionOf(p.id);
      const sent: string[] = [];
      const real = session.sendAgentMessage.bind(session);
      session.sendAgentMessage = ((content, ...rest) => {
        sent.push(content.map(block => block.type === 'text' ? block.text : '').join('\n'));
        return real(content, ...rest);
      }) as AgentSession['sendAgentMessage'];
      const opened = join(root, `gate-${randomUUID()}`);
      const timer = toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'Re-check the worker.' });
      expect(manager.sendMessage(p.id, [{ type: 'text', text: `${besideWait ? `${timer} ` : ''}${toolCall('cezar_done', {})} ${gate(opened)} ${thenSay('All done.')}` }])).toBe(true);
      await until(() => accepted.has(p.id));
      const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
      await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
      const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
      writeFileSync(opened, '');
      const refusal = `hsq message reply ${w.id} '<answer>' --id <new-UUID> --request-id ${questionId}`;
      const refusedNotes = () => eventsOf(p.id, 'note').filter(event => String(event.message).startsWith('Completion blocked: ') && String(event.message).includes(refusal));
      const nudges = () => eventsOf(p.id, 'note').filter(event => String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
      await until(() => refusedNotes().length === 1 && !!store.getRun(p.id)?.agentInputs?.find(input => input.id === questionId)?.deliveredAt && store.getRun(p.id)?.status === 'waiting');
      expect(nudges()).toEqual([]);
      expect(sent.filter(text => text.includes(refusal))).toEqual([]);
      // The agent's own timer stays; without it, only the timer live workers open.
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === WAIT_KIND.timer && wait.phase === 'open' && wait.via === WAIT_VIA.cezar_wait)).toHaveLength(besideWait ? 1 : 0);
      expect(waitOf(store.getRun(p.id))).toBeUndefined();
      expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'worker') ?? []).toEqual([]);
      expect(manager.finishBlockedReason(p.id)).toContain(w.id);
    } finally { close(); }
  });

// hearsay-tools/cezarion#2410: a worker's question has one addressee. When the parent is cancelled,
  // the question closes with it and the worker is cancelled; no human answers it, and no Continue
  // brings the worker back for the next family pass to cancel again.
  it('closes a routed question with its cancelled parent and refuses Continue on the worker', async () => {
    const f = await askedPair();
    f.close();
    const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
    manager.cancel(f.p.id);
    await until(() => closedAs(f.w.id).length === 1 && store.getRun(f.w.id)?.status === 'cancelled');
    expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq, reason: 'parent-stopped' })]);
    expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: requestOutcomeSchema.shape.status.enum.cancelled })]);
    noHumanCard(f.w.id);
    await until(() => !manager.isActive(f.w.id));
    expectSettledParentRefusal(f.w.id, f.p.id, 'cancelled');
    // The issue's reproduction: a later write to the parent starts a family pass, and the worker
    // stays as it is.
    store.setArchived(f.p.id, true);
    manager.reconcileWorkerWaits();
    expect(store.getRun(f.w.id)?.status).toBe('cancelled');
    expect(eventsOf(f.w.id, 'human-ask-closed')).toHaveLength(1);
  });

it('wakes a parent parked on its worker when the worker asks, within maxParallel', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask');
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === questionId)?.deliveredAt);
    expect(semaphore.busy()).toBeLessThanOrEqual(1);
  });
});
