import { captureSessions } from './runner-session-capture.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_AUTO_CONTINUES, WORKER_FALLBACK_HEADER, WORKER_FALLBACK_REPLY_NOTE } from './run.ts';
import { delegatingParent, manager, parent, root, store, until, worker } from './worker-wait.testkit.ts';
import { readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import type { RunOutcome } from '../runs/outcome-commit.ts';
import type { RunRecord } from '../runs/store.ts';
import { conversationOf, eventsOf, squawkAnswered, noHumanCard, idleWorker, steer, askedPair, answered, said, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

// hearsay-tools/cezarion#1301: Cezar's fallback question does not hold what the plain park let
  // through. A parent's steer supersedes it and is charged as its reply would be.
  it("a parent's steer supersedes the worker's fallback question and resolves its routed request", async () => {
    const f = await idleWorker();
    const wakes = store.getRun(f.w.id)?.automaticWakes ?? 0;
    const sent = steer(f.w.id, f.p.id, 'mock:agent-echo Also lint');
    await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === sent.id)?.deliveredAt);
    expect(eventsOf(f.w.id, 'human-ask-closed')[0]).toMatchObject({ askSeq: f.askSeq, reason: 'superseded' });
    expect(conversationOf(f.p.id)?.outcomes).toContainEqual(expect.objectContaining({ requestId: f.requestId, status: 'completed-without-reply' }));
    expect(store.readEvents(f.w.id).filter(event => event.type === 'note' && String(event.message).startsWith(WORKER_FALLBACK_REPLY_NOTE))[0])
      .toMatchObject({ message: `${WORKER_FALLBACK_REPLY_NOTE} (${wakes + 1}/${MAX_AUTO_CONTINUES})` });
    expect(answered(f.w.id)).toEqual([]);
    await until(() => said(f.w.id, 'Also lint'));
  });

// hearsay-tools/cezarion#1805: the fallback reply's charge never commits apart from the delivery
  // it pays for. A refused commit retries the whole batch, so no committed row reads the wake spent
  // with the reply undelivered.
  it("a refused fallback reply commit keeps the reply's charge with its delivery", async () => {
    const { p, service, callerFor } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const wakes = store.getRun(w.id)?.automaticWakes ?? 0;
    const commit = store.commitOutcome.bind(store);
    let refusals = 0;
    vi.spyOn(store, 'commitOutcome').mockImplementation((...args: Parameters<typeof store.commitOutcome>) => {
      const charged = ([args[1]].flat() as RunOutcome[]).some(outcome => outcome.kind === 'charged');
      if (args[0] === w.id && charged && !refusals++) throw Error('disk full');
      return commit(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const commits = recordCommits(join(root, '.ai/cezar'));
    const replyId = randomUUID();
    const requestId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    await service.send(callerFor(p.id), { id: replyId, recipientRunId: w.id, kind: 'reply', requestId, text: `${WORKER_FALLBACK_HEADER}: cez-dev`, timeoutSeconds: 600 });
    await until(() => answered(w.id).length === 1);
    expect(refusals).toBeGreaterThan(0);
    store.flush();
    const delivered = (row: RunRecord) => !!row.agentInputs?.find(input => input.id === replyId)?.deliveredAt;
    commits.expectEveryCommit(w.id, row => { return (row.automaticWakes ?? 0) === wakes || delivered(row); }, 'the reply\'s charge and its delivery');
    const disk = (readPersistedRuns(join(root, '.ai/cezar')) as RunRecord[]).find(run => run.id === w.id)!;
    expect({ wakes: disk.automaticWakes, delivered: delivered(disk) }).toEqual({ wakes: wakes + 1, delivered: true });
  });

// hearsay-tools/cezarion#2410: the stop closes Cezar's fallback question with the worker, so the
  // Continue that follows finds nothing to supersede and proceeds.
  it('a Continue on a stopped worker proceeds after the stop closed its fallback question', async () => {
    const f = await idleWorker();
    manager.requestWorkerStop(f.w.id); expect(await manager.awaitRunTermination(f.w.id, 15_000)).toBe(true);
    await until(() => eventsOf(f.w.id, 'human-ask-closed').length === 1);
    expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq: f.askSeq, reason: 'worker-stopped' })]);
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' }, true)).toEqual({ ok: true });
    expect(eventsOf(f.w.id, 'human-ask-closed')).toHaveLength(1);
    await until(() => store.getRun(f.w.id)?.status === 'waiting');
  });

it("a worker's own question still holds a parent's steer", async () => {
    const sessionOf = captureSessions();
    const f = await askedPair();
    try {
      const send = vi.spyOn(sessionOf(f.w.id), 'sendAgentMessage');
      const sent = steer(f.w.id, f.p.id, 'mock:agent-echo Also lint');
      expect(sent.result).toBe('queued');
      // Nothing was submitted: the steer waits for the answer, and the question stands.
      expect(send).not.toHaveBeenCalled();
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === sent.id)?.deliveredAt).toBeUndefined();
      expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([]);
      expect(hasPendingAsk(store, f.w.id)).toBe(true);
    } finally { f.close(); }
  });

// A root without the steer grant cannot reply (service.send refuses it), so it cannot take the
  // question; provisioned roots hold every grant, so only an older or narrowed record reaches this.
  it('answers the worker for the parent when the parent may not message its workers', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:cezar-ask'); manager.enqueueOwnedRun(w.id);
    await until(() => squawkAnswered(w.id).length === 1);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ reason: 'the parent may not message its workers' })]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    noHumanCard(w.id);
  });
});
