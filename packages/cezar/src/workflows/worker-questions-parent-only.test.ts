import { describe, expect, it } from 'vitest';
import { eventCheckpoint, manager, restart, store, toolGenerationOf, until } from './worker-wait-claude.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { eventsOf, askedPair, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

it('keeps a routed question parent-only', async () => {
    const f = await askedPair();
    try {
      const refusals = () => eventsOf(f.w.id, 'note').filter(event => event.message === 'This question was sent to the parent task; answer it there.');
      expect(manager.sendMessage(f.w.id, [{ type: 'text', text: 'mock:agent-echo human answer' }])).toBe(false);
      expect(refusals()).toHaveLength(1);
      expect(eventsOf(f.w.id, 'human-input-delivered')).toEqual([]);
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('human answer'))).toBe(false);
    } finally { f.close(); }
  });

it('refuses a human Continue on a routed question whose session is gone', async () => {
    const f = await askedPair();
    f.close();
    await restart(false, undefined, eventCheckpoint());
    await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
    expect(manager.continueRun(f.w.id, { text: 'human answer' })).toEqual({ ok: false, error: 'This question was sent to the parent task; answer it there.' });
    expect(eventsOf(f.w.id, 'human-input-delivered')).toEqual([]);
  });

// hearsay-tools/cezarion#1301: the question's delivery turn ended with a live worker, so its
  // re-check timer is open and a blocked done parks on it with the refusal as a note. With no wait
  // open, the blocked done gets the questions refusal as a nudge, without the will-wait sentence:
  // waiting on the worker would deadlock, as the worker waits on this parent.
  // hearsay-tools/cezarion#2397: cezar_done answers the agent itself while a worker question is
  // unanswered: the refusal names the reply command, and no wait opens on that worker.
  it('refuses cezar_done on an unanswered worker question with the reply command, never a wait on that worker', async () => {
    const f = await askedPair();
    try {
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === f.questionId)?.deliveredAt && store.getRun(f.p.id)?.status === 'waiting');
      const answer = await manager.squawkToolHandlers(f.p.id, toolGenerationOf(f.p.id)).finishTurn({}, new AbortController().signal);
      expect(answer).toMatchObject({ ok: false, code: 'worker_questions', workers: [{ worker_id: f.w.id, reason: 'question' }] });
      expect(answer.ok === false && answer.message).toContain(`hsq message reply ${f.w.id} '<answer>' --id <new-UUID> --request-id ${f.questionId}`);
      expect(store.getRun(f.p.id)?.status).toBe(RUN_STATUS.waiting);
      expect(store.getRun(f.p.id)?.waits?.filter(wait => wait.kind === 'worker') ?? []).toEqual([]);
      expect(store.getRun(f.p.id)?.delegation).not.toHaveProperty('completion');
      expect(manager.finishBlockedReason(f.p.id)).toContain(f.w.id);
    } finally { f.close(); }
  });
});
