import { runInternals } from './run-internals.testkit.ts';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eventCheckpoint, manager, restart, root, store, until } from './worker-wait.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { WAIT_KIND, WAIT_VIA, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { conversationOf, eventsOf, idleWorker, steer, expectFallbackIntact, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

// hearsay-tools/cezarion#1301: a refused Continue changes nothing, so it supersedes nothing.
  it('a refused Continue leaves the fallback question, its wait and its routed request intact', async () => {
    const f = await idleWorker();
    // A waiting worker whose process is still registered (as one a restart found alive) refuses it.
    const isActive = manager.isActive.bind(manager);
    const inactive = vi.spyOn(manager, 'isActive').mockImplementation(id => id !== f.w.id && isActive(id));
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' })).toEqual({ ok: false, error: 'cannot continue a waiting run' });
    inactive.mockRestore();
    expectFallbackIntact(f, [expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'], askSeq: f.askSeq })], []);
    // A stopped worker under a parent's pending Finish refuses it too.
    manager.requestWorkerStop(f.w.id); expect(await manager.awaitRunTermination(f.w.id, 15_000)).toBe(true);
    await until(() => store.getRun(f.p.id)?.status === 'waiting' && eventsOf(f.w.id, 'human-ask-closed').length === 1);
    store.commitRootFinishIntent(f.p.id);
    // The stop already settled the worker's waits and its open request; the refusal leaves both as they are.
    const waits = structuredClone(store.getRun(f.w.id)?.waits);
    const outcomes = conversationOf(f.p.id)?.outcomes.filter(outcome => outcome.requestId === f.requestId);
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' }, true)).toEqual({ ok: false, error: 'parent finish is pending' });
    expectFallbackIntact(f, waits, outcomes, true);
  });

// hearsay-tools/cezarion#1301: a Continue whose checkpoint fails is refused, so it supersedes nothing.
  it('a Continue refused at its checkpoint leaves the fallback question, its wait and its routed request intact', async () => {
    const f = await idleWorker();
    manager.requestWorkerStop(f.w.id); expect(await manager.awaitRunTermination(f.w.id, 15_000)).toBe(true);
    await until(() => eventsOf(f.w.id, 'human-ask-closed').length === 1);
    const waits = structuredClone(store.getRun(f.w.id)?.waits);
    const outcomes = conversationOf(f.p.id)?.outcomes.filter(outcome => outcome.requestId === f.requestId);
    const fail = vi.spyOn(store, 'commitWorkerContinuation').mockImplementationOnce(() => { throw Error('disk full'); });
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' }, true)).toEqual({ ok: false, error: 'worker execution checkpoint unavailable' });
    expect(fail).toHaveBeenCalledTimes(1);
    expectFallbackIntact(f, waits, outcomes, true);
    await until(() => !manager.isActive(f.w.id));
  });

// hearsay-tools/cezarion#1301: the routed request's outcome and the parent's unread copy are
  // settled before the worker's question closes, so a failed write leaves it all for a retry, and
  // recovery finishes it.
  for (const failing of ['outcome', 'retire'] as const) {
    it(`a failed ${failing} write leaves the fallback question pending, and recovery supersedes it`, async () => {
      const f = await idleWorker();
      const fail = failing === 'outcome'
        ? vi.spyOn(store, 'commitConversation').mockImplementationOnce(() => { throw Error('disk full'); })
        : vi.spyOn(runInternals(manager).workerQuestions, 'retireUnreadParentQuestion')
          .mockImplementationOnce(() => { throw Error('disk full'); });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(steer(f.w.id, f.p.id, 'mock:agent-echo Also lint').result).toBe('queued');
      await until(() => fail.mock.calls.length > 0);
      fail.mockRestore();
      expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([]);
      expect(store.transcriptFacts(f.w.id).pendingAsk?.seq).toBe(f.askSeq);
      expect(store.getRun(f.w.id)?.waits).toEqual([expect.objectContaining({ via: WAIT_VIA['no-wait'], askSeq: f.askSeq })]);
      if (failing === 'outcome') expect(conversationOf(f.p.id)?.outcomes.some(outcome => outcome.requestId === f.requestId) ?? false).toBe(false);
      // A crash now: recovery finds the worker waiting on the question with no process left.
      store.flush();
      const disk = readPersistedRuns(join(root, '.ai/cezar'));
      await restart(false, disk, eventCheckpoint());
      expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq: f.askSeq, reason: 'superseded' })]);
      expect(conversationOf(f.p.id)?.outcomes).toContainEqual(expect.objectContaining({ requestId: f.requestId, status: 'completed-without-reply' }));
      const question = store.getRun(f.p.id)?.agentInputs?.find(input => input.id === f.requestId);
      // The parent no longer owes it: retired from its queue, or no longer awaiting a read.
      expect(!question || !!question.consumedAt || (!!question.deliveredAt && !question.awaitingRead)).toBe(true);
    });
  }
});
