import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectGeneration } from '../delegation/process-liveness.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { DelegationService } from '../delegation/service.ts';
import { uuidFrom } from '../delegation/questions.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, WORKER_FALLBACK_HEADER, WORKER_FALLBACK_QUESTION, WORKER_FALLBACK_REPLY_NOTE } from './run.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { bookkeeping, delegatingParent, eventCheckpoint, fixtureUpdateRun, manager, parent, register, restart, root, semaphore, spendWorkerBudget, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import type { RunOutcome } from '../runs/outcome-commit.ts';
import type { RunRecord } from '../runs/store.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';

/** #505 PR B: a worker's question goes to its owning parent, not to the human. */
describe('worker questions route to the parent (#505)', { timeout: 45_000 }, () => {
  // afterEach runs in reverse registration order: keep process scoping alive
  // through the fixture's real session/autosave shutdown, then restore mocks.
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
  useWorkerWaitFixture();
  const conversationOf = (rootId: string) => { const d = store.getRun(rootId)?.delegation; return d?.role === 'root' ? d.conversation : undefined; };
  const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter(event => event.type === type);
  /** Cezar answered the worker's question for a live parent that could not take it (hearsay-tools/cezarion#2410). */
  const cezarAnswered = (runId: string) => eventsOf(runId, 'human-input-delivered').filter(event => event.source === 'cezar');
  const closedAs = (runId: string) => eventsOf(runId, 'human-ask-closed').map(event => event.reason);
  /** No worker question of this run is on a human card: none fell back, and a pending one (a later
   *  "Worker idle" question, for one) belongs to the parent or to Cezar. */
  const noHumanCard = (runId: string) => {
    expect(eventsOf(runId, 'worker-question-fallback')).toEqual([]);
    if (hasPendingAsk(store, runId)) expect(runInternals(manager).workerQuestions.answeredElsewhere(runId)).toBe(true);
  };
  /** A root that may message its workers, as provisioned roots are. */
  async function steeringParent(task = 'mock:hold') {
    const p = await parent(task);
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
    return p;
  }

  it("sends a worker's CEZ:ASK question to its active parent as a request", async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const ask = eventsOf(w.id, 'ask.requested')[0]!;
    const routed = eventsOf(w.id, 'worker-question-routed')[0]!;
    expect(routed).toMatchObject({ askSeq: ask.seq, parentRunId: p.id });
    const message = conversationOf(p.id)?.messages.find(m => m.id === routed.messageId);
    expect(message).toMatchObject({ kind: 'request', senderRunId: w.id, recipientRunId: p.id, question: { questions: expect.any(Array) } });
    // hearsay-tools/cezarion#1808: the request carries the ask as the worker's event stored it, field for field.
    expect(message?.question).toStrictEqual({ questions: ask.questions, ...(ask.context === undefined ? {} : { context: ask.context }) });
    expect(message?.deadline).toBeUndefined();
    expect(store.getRun(p.id)?.agentInputs?.some(input => input.id === message!.id)).toBe(true);
    await until(() => store.getRun(w.id)?.status === 'waiting');
  });

  /** A parent whose last free inbox slot an open peer request holds: 31 undelivered plain inputs
   *  (nothing wakes it) and one request to another root task (hearsay-tools/cezarion#1990). */
  async function parentAtLastSlot(service: DelegationService, callerFor: (id: string) => import('../delegation/credentials.ts').Caller, parentId: string) {
    const now = new Date().toISOString();
    fixtureUpdateRun(parentId, { agentInputs: Array.from({ length: 31 }, () => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: parentId, text: 'queued', createdAt: now })) });
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    store.updateRun(peer.id, { status: RUN_STATUS.running, delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const request = await service.send(callerFor(parentId), { id: randomUUID(), recipientRunId: peer.id, kind: 'request', text: 'Which versions?', timeoutSeconds: 600 });
    const reply = () => service.send(callerFor(peer.id), { id: randomUUID(), recipientRunId: parentId, kind: 'reply', requestId: request.message.id, text: 'zod 4', timeoutSeconds: 600 });
    return { reply, undelivered: () => store.getRun(parentId)?.agentInputs?.filter(input => !input.deliveredAt).length ?? 0 };
  }

  // hearsay-tools/cezarion#2410: a live parent that cannot take the question does not pass it to a
  // human. Cezar answers the worker with the reason.
  it("answers the worker for the parent when an open peer request holds the parent's last inbox slot, and the reply still fits", async () => {
    const { p, service, callerFor } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const slot = await parentAtLastSlot(service, callerFor, p.id);
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => cezarAnswered(w.id).length === 1);
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ askSeq, reason: 'the parent conversation is at capacity' })]);
    expect(cezarAnswered(w.id)[0]).toMatchObject({ askSeq });
    noHumanCard(w.id);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(slot.undelivered()).toBe(31);
    expect((await slot.reply()).outcome).toMatchObject({ status: 'replied' });
    expect(slot.undelivered()).toBe(32);
  });

  // hearsay-tools/cezarion#1990 review: a peer that sends first under the question's deterministic ID
  // keeps its ID and its sender; Cezar answers the worker (hearsay-tools/cezarion#2410).
  it('answers the worker for the parent when a peer message took its ID first', async () => {
    const { p, service, callerFor } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const routing = runInternals(manager).workerQuestions;
    const route = vi.spyOn(routing, 'routeWorkerQuestion').mockImplementation(() => {});
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'ask.requested').length === 1);
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    const id = uuidFrom(`worker-question:${w.id}:${askSeq}`);
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    store.updateRun(peer.id, { status: RUN_STATUS.running, delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    await service.send(callerFor(peer.id), { id, recipientRunId: p.id, kind: 'progress', text: 'Peer progress first', timeoutSeconds: 600 });
    expect(route).toHaveBeenCalledWith(w.id);
    route.mockRestore();
    routing.routeWorkerQuestion(w.id);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ askSeq, reason: expect.stringContaining('already in use') })]);
    await until(() => cezarAnswered(w.id).length === 1);
    noHumanCard(w.id);
    expect(conversationOf(p.id)?.messages.some(message => message.question) ?? false).toBe(false);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === id)).toEqual([
      expect.objectContaining({ text: 'Peer progress first', conversation: expect.objectContaining({ senderRunId: peer.id, relationship: 'peer' }) })]);
  });

  /** 32 undelivered inputs fill the parent's inbox (plain input, so nothing wakes it). */
  const fillInbox = (parentId: string) => {
    const now = new Date().toISOString();
    fixtureUpdateRun(parentId, { agentInputs: Array.from({ length: 32 }, () => ({ id: randomUUID(), source: 'agent' as const, parentRunId: parentId, text: 'queued', createdAt: now })) });
  };

  it('answers the worker for the parent when the parent cannot take another message, once', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => cezarAnswered(w.id).length === 1);
    const askSeq = eventsOf(w.id, 'ask.requested')[0]!.seq;
    const answer = store.getRun(w.id)?.agentInputs?.filter(input => input.purpose === 'undelivered-question');
    expect(answer).toEqual([expect.objectContaining({ source: 'lifecycle', deliveredAt: expect.any(String), text: expect.stringContaining(`Not delivered to your parent task ${p.id}: the parent conversation is at capacity.`) })]);
    // The answer carries its automatic-wake charge, so asking again cannot loop past the budget.
    expect(store.getRun(w.id)?.automaticWakes).toBeGreaterThanOrEqual(1);
    // Routing again finds the queued answer: no second answer and no second event.
    runInternals(manager).workerQuestions.routeWorkerQuestion(w.id);
    expect(store.getRun(w.id)?.agentInputs?.filter(input => input.purpose === 'undelivered-question')).toHaveLength(1);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ askSeq })]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    noHumanCard(w.id);
  });

  it('closes the question without an answer when the worker spent its automatic-wake budget', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id, 'mock:ask'); spendWorkerBudget(w.id); manager.enqueueOwnedRun(w.id);
    await until(() => closedAs(w.id).length === 1);
    expect(closedAs(w.id)).toEqual(['undeliverable']);
    expect(cezarAnswered(w.id)).toEqual([]);
    expect(store.getRun(w.id)?.agentInputs?.some(input => input.purpose === 'undelivered-question') ?? false).toBe(false);
    noHumanCard(w.id);
  });

  // The guard for an ask no request can carry: every writer validates the ask today, so the event
  // is seeded here to pin that the guard answers the worker and never asks a human.
  it('answers the worker when its question is not a valid request', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask');
    const routing = runInternals(manager).workerQuestions;
    const route = vi.spyOn(routing, 'routeWorkerQuestion').mockImplementation(() => {});
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'ask.requested').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const asked = eventsOf(w.id, 'ask.requested')[0]!;
    store.appendEvent(w.id, { type: 'ask.requested', requestId: randomUUID(), questions: asked.questions, context: 'x'.repeat(20_001) });
    route.mockRestore();
    routing.routeWorkerQuestion(w.id);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ reason: 'the question is not a valid request' })]);
    await until(() => cezarAnswered(w.id).length === 1);
    noHumanCard(w.id);
  });

  // hearsay-tools/cezarion#1301: a worker's second turn end with no wait or done asks its parent. A
  // parent that cannot take Cezar's own question closes it, with no answer that would wake the worker
  // again, and the worker parks (hearsay-tools/cezarion#2410).
  it("closes Cezar's idle question when the parent cannot take it, and the worker parks", async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fillInbox(p.id);
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => closedAs(w.id).length === 1 && store.getRun(w.id)?.status === 'waiting');
    const ask = eventsOf(w.id, 'ask.requested');
    expect(ask).toEqual([expect.objectContaining({ questions: [{ header: WORKER_FALLBACK_HEADER, question: WORKER_FALLBACK_QUESTION(w.id) }] })]);
    expect(eventsOf(w.id, 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq: ask[0]!.seq, reason: 'undeliverable' })]);
    expect(cezarAnswered(w.id)).toEqual([]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    noHumanCard(w.id);
  });

  it('a budget-spent worker plain-parks without routing', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); spendWorkerBudget(w.id); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'turn-end').length > 0 && store.getRun(w.id)?.status === 'waiting');
    expect(eventsOf(w.id, 'ask.requested')).toEqual([]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages ?? []).toEqual([]);
    expect(store.getRun(w.id)?.waits ?? []).toEqual([]);
  });

  /** A worker whose second no-wait turn end routed Cezar's fallback question to its parent. */
  async function idleWorker() {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1 && store.getRun(w.id)?.status === 'waiting');
    return { p, w, askSeq: eventsOf(w.id, 'ask.requested')[0]!.seq, requestId: String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId) };
  }
  const steer = (workerId: string, parentRunId: string, text: string) => {
    const id = randomUUID();
    return { id, result: manager.steerWorker(workerId, { id, source: 'agent', parentRunId, text, createdAt: new Date().toISOString() }) };
  };

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
    commits.expectEveryCommit(w.id, row => (row.automaticWakes ?? 0) === wakes || delivered(row), 'the reply\'s charge and its delivery');
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

  /** The fallback question stands, or closed only as the stop closed it, and the worker's waits and
   *  its request's outcomes are as given. */
  function expectFallbackIntact(f: Awaited<ReturnType<typeof idleWorker>>, waits: unknown, outcomes: unknown, stopped = false) {
    expect(eventsOf(f.w.id, 'human-ask-closed').map(event => event.reason)).toEqual(stopped ? ['worker-stopped'] : []);
    expect(store.transcriptFacts(f.w.id).pendingAsk?.seq).toBe(stopped ? undefined : f.askSeq);
    expect(store.getRun(f.w.id)?.waits).toEqual(waits);
    expect(conversationOf(f.p.id)?.outcomes.filter(outcome => outcome.requestId === f.requestId)).toEqual(outcomes);
  }

  // hearsay-tools/cezarion#1301: a refused Continue changes nothing, so it supersedes nothing.
  it('a refused Continue leaves the fallback question, its wait and its routed request intact', async () => {
    const f = await idleWorker();
    // A waiting worker whose process is still registered (as one a restart found alive) refuses it.
    const isActive = manager.isActive.bind(manager);
    const inactive = vi.spyOn(manager, 'isActive').mockImplementation(id => id !== f.w.id && isActive(id));
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' })).toEqual({ ok: false, error: 'cannot continue a waiting run' });
    inactive.mockRestore();
    expectFallbackIntact(f, [expect.objectContaining({ kind: 'human', source: 'cezar', via: 'no-wait', askSeq: f.askSeq })], []);
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
      expect(store.getRun(f.w.id)?.waits).toEqual([expect.objectContaining({ via: 'no-wait', askSeq: f.askSeq })]);
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

  it("a worker's own question still holds a parent's steer", async () => {
    const f = await askedPair();
    try {
      const sent = steer(f.w.id, f.p.id, 'mock:agent-echo Also lint');
      expect(sent.result).toBe('queued');
      // Nothing was submitted: the steer waits for the answer, and the question stands.
      expect((manager as unknown as { active: Map<string, { agentInputFlight?: unknown }> }).active.get(f.w.id)?.agentInputFlight).toBeUndefined();
      expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([]);
      expect(hasPendingAsk(store, f.w.id)).toBe(true);
    } finally { f.close(); }
  });

  // A root without the steer grant cannot reply (service.send refuses it), so it cannot take the
  // question; provisioned roots hold every grant, so only an older or narrowed record reaches this.
  it('answers the worker for the parent when the parent may not message its workers', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => cezarAnswered(w.id).length === 1);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ reason: 'the parent may not message its workers' })]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    noHumanCard(w.id);
  });

  /** A parent and a worker that has asked; the question is routed and the worker waits. */
  async function askedPair(parentTask = 'mock:hold') {
    const { p, service, callerFor, close } = await delegatingParent({ task: parentTask, permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    const parentCaller = callerFor(p.id), workerCaller = callerFor(w.id);
    const reply = (text: string, id = randomUUID()) => service.send(parentCaller!, { id, recipientRunId: w.id, kind: 'reply', requestId: questionId, text, timeoutSeconds: 600 });
    return { p, w, questionId, service, parentCaller: parentCaller!, workerCaller: workerCaller!, reply, close };
  }
  const answered = (runId: string) => eventsOf(runId, 'human-input-delivered').filter(event => event.source === 'parent');
  const said = (runId: string, text: string) => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(text));

  it('a correlated parent reply unblocks the worker without human input', async () => {
    const f = await askedPair();
    try {
      const reply = randomUUID();
      await f.reply('mock:agent-echo Use the parser', reply);
      await until(() => answered(f.w.id).length === 1);
      expect(answered(f.w.id)[0]).toMatchObject({ askSeq: eventsOf(f.w.id, 'ask.requested')[0]!.seq });
      await until(() => said(f.w.id, 'Use the parser'));
      expect(store.getRun(f.w.id)?.agentInputs?.find(input => input.id === reply)?.deliveredAt).toBeDefined();
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('Use the parser'))).toBe(false);
    } finally { f.close(); }
  });

  it("retires the answer's wake so later messages still reach the worker", async () => {
    const f = await askedPair();
    try {
      // The answer's turn runs ~25 s, so anything sent now must steer it, not wait it out.
      await f.reply('mock:slow Use the parser');
      await until(() => answered(f.w.id).length === 1);
      expect(waitOf(store.getRun(f.w.id))).toBeUndefined();
      const later = randomUUID();
      await f.service.send(f.parentCaller, { id: later, recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Also lint', timeoutSeconds: 600 });
      await until(() => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === later)?.deliveredAt);
    } finally { f.close(); }
  });

  it('progress and follow-ups never answer a pending worker question', async () => {
    const f = await askedPair();
    try {
      const request = randomUUID(); const progress = randomUUID(); const followUp = randomUUID();
      await f.service.send(f.parentCaller, { id: request, recipientRunId: f.w.id, kind: 'request', text: 'mock:agent-echo Also check lint', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: progress, recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Still thinking', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: followUp, recipientRunId: f.w.id, kind: 'follow-up', requestId: request, text: 'mock:agent-echo Only src', timeoutSeconds: 600 });
      manager.deliverConversationInput(f.w.id);
      // hearsay-tools/cezarion#1235: a pending question no longer holds them; they reach the
      // worker beside it, and none of them answers it.
      const beside = () => store.getRun(f.w.id)?.agentInputs?.filter(input => [request, progress, followUp].some(id => id === input.id)) ?? [];
      await until(() => beside().length === 3 && beside().every(input => !!input.deliveredAt));
      await until(() => said(f.w.id, 'Only src'));
      expect(answered(f.w.id)).toEqual([]);
      await until(() => store.getRun(f.w.id)?.status === 'waiting' && hasPendingAsk(store, f.w.id) === true);
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
    } finally { f.close(); }
  });

  async function replyAfterRestart(crashed: boolean, holdResources = false) {
    const f = await askedPair();
    f.close();
    const parentIdle = async () => {
      // Routing and recovery can wake the parent. Finish that turn's real Git
      // bookkeeping before testing a one-shot reply into a quiescent worktree.
      // Recovery leaves a monitoring park inactive on its persisted timer (hearsay-tools/cezarion#1233).
      await until(() => runInternals(manager).line.waiting.has(f.p.id) || (!manager.isActive(f.p.id) && !!monitoringWakeOf(store.getRun(f.p.id))));
      await Promise.all(bookkeeping);
    };
    await parentIdle();
    const files = eventCheckpoint();
    if (crashed) {
      // #469: restore the worker's pre-cancel `starting` proof, as a real crash leaves it, with a dead controller.
      const proof = join(root, '.ai/cezar/runs', `${f.w.id}.execution.json`), record = proof.replace(/\.execution\.json$/, '.processes.json');
      expect(store.readWorkerExecution(f.w.id)?.phase).toBe('starting');
      const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.once('exit', resolve));
      files.set(proof, readFileSync(proof, 'utf8'));
      files.set(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), controller: { pid: dead.pid, startToken: '1' } }));
    }
    await restart(false, undefined, files);
    const credentials = new CredentialRegistry();
    let releaseHolder: (() => Promise<void>) | undefined;
    try {
      const parentCaller = credentials.authenticate(credentials.issue('project', f.p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ id: 'project', root, store, manager });
      // Recovery resumes the parent; the worker's session stays closed on its pending question.
      await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
      await parentIdle();
      expect(manager.isActive(f.w.id)).toBe(false);
      if (holdResources) {
        await until(() => store.readWorkerExecution(f.w.id)?.phase === 'complete');
        const delegation = store.getRun(f.w.id)!.delegation!;
        if (delegation.role !== 'worker') throw Error('missing worker');
        const holder = spawn(process.execPath, ['-e', "console.log('ready'); process.stdin.resume()"], {
          cwd: delegation.workspace.path, stdio: ['pipe', 'pipe', 'ignore'],
        });
        const exited = once(holder, 'exit');
        releaseHolder = async () => { holder.stdin.end(); await exited; };
        await once(holder.stdout, 'data');
        const resourcesSafe = store.workerResourcesSafe.bind(store);
        // Release a real holder only after the first resource check sees it.
        // Without the pre-reply wait, admission refuses the one-shot answer;
        // closing the holder afterward cannot turn that refusal into success.
        vi.spyOn(store, 'workerResourcesSafe').mockImplementation((...args) => {
          const safe = resourcesSafe(...args);
          if (args[0] === f.w.id && !safe) holder.stdin.end();
          return safe;
        });
      }
      if (crashed) {
        // This case answers after the crashed execution has no possible process
        // holders. Inactive only proves our manager released it: the real #469
        // scan can still see transient Git children or unreadable same-user host
        // processes. Recovery may already have finalized the execution, but that
        // does not prove its resources can be reused (hearsay-tools/cezarion#732).
        // Wait for that physical precondition without finalizing the proof,
        // suppressing any PIDs, or retrying the answer under test.
        await until(() => {
          const orphan = runInternals(manager).orphans.orphanedWorkerGeneration(f.w.id);
          if (orphan) return inspectGeneration(orphan).liveness === 'gone';
          const proof = store.readWorkerExecution(f.w.id);
          const delegation = store.getRun(f.w.id)?.delegation;
          return proof?.phase === 'complete' && delegation?.role === 'worker' &&
            store.workerResourcesSafe(f.w.id, proof.generation, delegation.workspace.resourceId);
        });
      }
      await service.send(parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: f.questionId, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('Use the parser'))).toBe(false);
    } finally { await releaseHolder?.(); credentials.close(); }
  }
  it('a parent reply answers the worker after a restart', () => replyAfterRestart(false));
  it('a parent reply answers the worker after a crash left its execution starting (#469)', () => replyAfterRestart(true));
  it('waits for reusable resources when recovery already completed the crashed execution (hearsay-tools/cezarion#732)', () => replyAfterRestart(true, true));

  // hearsay-tools/cezarion#1235: the worker's question reaches the parent beside the parent's own
  // pending question, which stays the human's to answer.
  it('delivers a worker question beside the parent\'s own pending question, which stays answerable', async () => {
    process.env.CEZ_DELEGATION = '1';
    const p = await steeringParent('mock:ask'); await until(() => eventsOf(p.id, 'ask.requested').length === 1 && store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    const question = () => store.getRun(p.id)?.agentInputs?.find(input => input.id === questionId);
    expect(question()).toBeDefined();
    await until(() => !!question()?.deliveredAt);
    expect(eventsOf(p.id, 'human-input-delivered')).toEqual([]);
    await until(() => store.getRun(p.id)?.status === 'waiting' && hasPendingAsk(store, p.id) === true);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    await until(() => eventsOf(p.id, 'human-input-delivered').length === 1);
    const human = eventsOf(p.id, 'human-input-delivered');
    expect(human).toHaveLength(1);
    expect(human[0]!.source).toBeUndefined();
  });

  it('refuses a second reply to an answered question', async () => {
    const f = await askedPair();
    try {
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
      await expect(f.reply('mock:agent-echo Use the lexer')).rejects.toSatisfy(error =>
        error instanceof DelegationPolicyError && error.message === 'This question was already answered');
      expect(answered(f.w.id)).toHaveLength(1);
    } finally { f.close(); }
  });

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
  it('holds parent completion on an unanswered worker question: a note beside an open wait, else the questions refusal nudge, never a wait on that worker', async () => {
    const f = await askedPair();
    try {
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === f.questionId)?.deliveredAt && store.getRun(f.p.id)?.status === 'waiting');
      const engine = manager as unknown as { active: Map<string, { session: AgentSession; ciGeneration: string }> };
      const session = engine.active.get(f.p.id)!.session;
      const sent: string[] = [];
      const real = session.sendAgentMessage.bind(session);
      session.sendAgentMessage = ((content, ...rest) => {
        sent.push(content.map(block => block.type === 'text' ? block.text : '').join('\n'));
        return real(content, ...rest);
      }) as AgentSession['sendAgentMessage'];
      const refusal = `cez message reply ${f.w.id} '<answer>' --id <new-UUID> --request-id ${f.questionId}`;
      const refusedNotes = () => eventsOf(f.p.id, 'note').filter(event => String(event.message).startsWith('Completion blocked: ') && String(event.message).includes(refusal));
      const nudges = () => eventsOf(f.p.id, 'note').filter(event => String(event.message).startsWith(COMPLETION_NUDGE_NOTE));
      const [timer] = store.getRun(f.p.id)?.waits ?? [];
      expect(timer).toMatchObject({ kind: 'timer', via: 'monitoring-line', phase: 'open' });
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:done' }])).toBe(true);
      await until(() => refusedNotes().length === 1 && store.getRun(f.p.id)?.status === 'waiting');
      expect(nudges()).toEqual([]);
      expect(sent.filter(text => text.includes(refusal))).toEqual([]);
      const cancelled = await manager.cezarToolHandlers(f.p.id, engine.active.get(f.p.id)!.ciGeneration).cancelWait({ wait_id: timer!.id }, new AbortController().signal);
      expect(cancelled).toMatchObject({ cancelled: true });
      expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:done' }])).toBe(true);
      await until(() => nudges().length === 1);
      expect(nudges().map(event => event.message)).toEqual([`${COMPLETION_NUDGE_NOTE} (1/${MAX_AUTO_CONTINUES}): worker_questions`]);
      const nudge = sent.filter(text => text.includes(refusal));
      expect(nudge).toHaveLength(1);
      expect(nudge[0]).not.toContain(COMPLETION_WILL_WAIT);
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
      expect(store.getRun(f.p.id)?.waits?.filter(wait => wait.kind === 'worker') ?? []).toEqual([]);
      expect(store.getRun(f.p.id)?.delegation).not.toHaveProperty('completion');
      expect(manager.finishBlockedReason(f.p.id)).toContain(f.w.id);
    } finally { f.close(); }
  });

  /** Continue on the worker is refused, naming its settled parent, and changes nothing. */
  const expectSettledParentRefusal = (workerId: string, parentId: string, status: string) => {
    const before = JSON.stringify(store.getRun(workerId));
    const events = store.readEvents(workerId).length;
    expect(manager.continueRun(workerId, { text: 'mock:agent-echo human answer' })).toEqual({ ok: false, error: `Parent task ${parentId} is ${status}; continue the parent before its worker.` });
    expect(JSON.stringify(store.getRun(workerId))).toBe(before);
    expect(store.readEvents(workerId)).toHaveLength(events);
  };

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
    process.env.CEZ_DELEGATION = '1';
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask');
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    await until(() => !!store.getRun(p.id)?.agentInputs?.find(input => input.id === questionId)?.deliveredAt);
    expect(semaphore.busy()).toBeLessThanOrEqual(1);
  });

  // A crash after the parent's cancellation committed, before the family pass that ends its workers.
  it('closes a routed question on recovery when the parent was cancelled before the crash', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'cancelled';
    await restart(false, disk, events);
    await until(() => closedAs(f.w.id).length === 1 && store.getRun(f.w.id)?.status === 'cancelled' && !manager.isActive(f.w.id));
    expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
    expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: requestOutcomeSchema.shape.status.enum.cancelled })]);
    noHumanCard(f.w.id);
    expectSettledParentRefusal(f.w.id, f.p.id, 'cancelled');
  });

  it('answers the worker after a crash between accepting the reply and delivering it', async () => {
    const f = await askedPair();
    f.close();
    // The accepted reply, committed exactly as the service does, before any delivery attempt.
    const id = randomUUID(); const now = new Date().toISOString();
    const attribution = { senderRunId: f.p.id, recipientRunId: f.w.id, kind: 'reply' as const, requestId: f.questionId };
    const state = conversationOf(f.p.id)!;
    store.commitConversation(f.p.id, { messages: [...state.messages, { id, ...attribution, text: 'mock:agent-echo Use the parser', createdAt: now, requestHash: 'c'.repeat(64), state: 'accepted' }],
      outcomes: [...state.outcomes, { requestId: f.questionId, status: 'replied', observedAt: now, replyId: id }] },
    { recipientRunId: f.w.id, input: { id, source: 'agent', parentRunId: f.p.id, text: 'mock:agent-echo Use the parser', createdAt: now, conversation: attribution } });
    await restart(false, undefined, eventCheckpoint());
    await until(() => answered(f.w.id).length === 1);
    await until(() => said(f.w.id, 'Use the parser'));
  });

  // A reply accepted before the parent's cancellation, then a crash before the family pass: recovery
  // closes the question with its parent and the reply never reaches the worker.
  it('closes a routed question on recovery when an accepted reply waited and the parent was cancelled', async () => {
    const f = await askedPair();
    f.close();
    const id = randomUUID(); const now = new Date().toISOString();
    const attribution = { senderRunId: f.p.id, recipientRunId: f.w.id, kind: 'reply' as const, requestId: f.questionId };
    const state = conversationOf(f.p.id)!;
    store.commitConversation(f.p.id, { messages: [...state.messages, { id, ...attribution, text: 'mock:agent-echo Use the parser', createdAt: now, requestHash: 'c'.repeat(64), state: 'accepted' }],
      outcomes: [...state.outcomes, { requestId: f.questionId, status: 'replied', observedAt: now, replyId: id }] },
    { recipientRunId: f.w.id, input: { id, source: agentInputSchema.shape.source.enum.agent, parentRunId: f.p.id, text: 'mock:agent-echo Use the parser', createdAt: now, conversation: attribution } });
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'cancelled';
    await restart(false, disk, events);
    await until(() => closedAs(f.w.id).length === 1 && store.getRun(f.w.id)?.status === 'cancelled' && !manager.isActive(f.w.id));
    expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
    expect(answered(f.w.id)).toEqual([]);
    expect(said(f.w.id, 'Use the parser')).toBe(false);
    expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.id === id) ?? false).toBe(false);
    noHumanCard(f.w.id);
  });

  // The worker's own routing marker keeps the question the parent's when the parent's ledger cannot
  // be read; recovery cannot route it there again, so Cezar answers it and no human does.
  it('answers a routed question for the parent when the parent record cannot be read after a restart', async () => {
    const f = await askedPair();
    f.close();
    const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'unknown-status';
    await restart(false, disk, events);
    expect(store.isUnreadable(f.p.id)).toBe(true);
    // The mock asks again after the answer; each question it raises gets Cezar's answer.
    await until(() => cezarAnswered(f.w.id).length >= 1);
    expect(eventsOf(f.w.id, 'worker-question-undelivered')[0]).toMatchObject({ askSeq, reason: 'the parent record cannot be read' });
    expect(cezarAnswered(f.w.id)[0]).toMatchObject({ askSeq });
    expect(eventsOf(f.w.id, 'human-input-delivered').filter(event => event.source !== 'cezar')).toEqual([]);
    noHumanCard(f.w.id);
  });

  it('refuses human input on a routed question whose parent record cannot be read', () => {
    const routing = runInternals(manager).workerQuestions;
    const ask = { seq: 3, requestId: 'r', questions: [], routedMessageId: randomUUID() };
    const worker = { id: randomUUID(), delegation: { role: 'worker' as const } };
    vi.spyOn(store, 'getRun').mockImplementation(id => (id === worker.id ? worker : undefined) as never);
    vi.spyOn(store, 'transcriptFacts').mockReturnValue({ pendingAsk: ask } as never);
    // routedAsk cannot load the parent's message, yet the question stays the parent's.
    expect(routing.routedAsk(worker.id)).toBeUndefined();
    expect(routing.answeredElsewhere(worker.id)).toBe(true);
  });

  // Cezar's answer queued for a routed question still answers it once the parent's ledger reads
  // again (here it always reads): the parent-reply lookup must not hide it.
  it("delivers Cezar's queued answer to a routed question whose parent reads", async () => {
    const f = await askedPair();
    try {
      const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
      runInternals(manager).workerQuestions.answerUndelivered(f.w.id, askSeq, 'the parent record cannot be read');
      await until(() => cezarAnswered(f.w.id).length === 1);
      expect(cezarAnswered(f.w.id)[0]).toMatchObject({ askSeq });
      noHumanCard(f.w.id);
    } finally { f.close(); }
  });

  it("waits for capacity before a parent's answer resumes the worker", async () => {
    const f = await askedPair();
    try {
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
      await until(() => store.getRun(blocker.id)?.status === 'running' && semaphore.busy() === 1);
      let peak = 0;
      const sample = setInterval(() => { peak = Math.max(peak, semaphore.busy()); }, 5);
      try {
        await f.reply('mock:agent-echo Use the parser');
        // Another message while the answer waits for admission must not deliver it early.
        await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Still here', timeoutSeconds: 600 });
        // bound: negative window. An early delivery would happen in the pump the message above kicked, a few event-loop turns away; 300 ms covers them.
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(answered(f.w.id)).toEqual([]);
        // Freeing the slot admits the worker, and the held answer goes in.
        manager.cancel(blocker.id);
        await until(() => answered(f.w.id).length === 1);
      } finally { clearInterval(sample); }
      expect(peak).toBeLessThanOrEqual(1);
    } finally { f.close(); }
  });

  it('records the routing on recovery when the crash fell between the question and its event', async () => {
    const f = await askedPair();
    f.close();
    // Drop the routing event from the checkpoint; the committed question stays.
    const events = eventCheckpoint();
    for (const [path, content] of events) events.set(path, content.split('\n').filter(line => !line.includes('"worker-question-routed"')).join('\n'));
    await restart(false, undefined, events);
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-routed')[0]).toMatchObject({ messageId: f.questionId });
    const credentials = new CredentialRegistry();
    try {
      const parentCaller = credentials.authenticate(credentials.issue('project', f.p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ id: 'project', root, store, manager });
      await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
      await service.send(parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: f.questionId, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
      await until(() => answered(f.w.id).length === 1);
    } finally { credentials.close(); }
  });

  it('routes the question on recovery when the crash fell before it reached the parent', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    for (const [path, content] of events) events.set(path, content.split('\n').filter(line => !line.includes('"worker-question-routed"')).join('\n'));
    type DiskRun = { id: string; agentInputs?: Array<{ id: string }> | undefined; delegation?: { conversation?: { messages: Array<{ id: string }> } } };
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as DiskRun[];
    for (const run of disk) if (run.id === f.p.id) {
      run.agentInputs = run.agentInputs?.filter(input => input.id !== f.questionId);
      const conversation = run.delegation?.conversation;
      if (conversation) conversation.messages = conversation.messages.filter(message => message.id !== f.questionId);
    }
    await restart(false, disk, events);
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-routed')[0]).toMatchObject({ messageId: f.questionId });
    expect(conversationOf(f.p.id)?.messages.some(message => message.id === f.questionId)).toBe(true);
    expect(eventsOf(f.w.id, 'worker-question-fallback')).toEqual([]);
  });

  it('answers a worker that registered a request wait before asking', async () => {
    const f = await askedPair();
    try {
      const request = randomUUID();
      await f.service.send(f.workerCaller, { id: request, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
      // The wait a turn registered before its ask: a list entry since hearsay-tools/cezarion#1235,
      // which the answer leaves open.
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [request], timeoutSeconds: 600 });
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      expect(waitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, requestIds: [request] });
    } finally { f.close(); }
  });

  /** Historical parent→worker traffic filling the family ledger to `count` messages. */
  function fillConversation(parentId: string, workerId: string, count: number) {
    const now = new Date().toISOString();
    const state = conversationOf(parentId) ?? { messages: [], outcomes: [] };
    store.commitConversation(parentId, { ...state, messages: [...state.messages, ...Array.from({ length: count - state.messages.length }, () => ({
      id: randomUUID(), senderRunId: parentId, recipientRunId: workerId, kind: 'progress' as const, text: 'old', createdAt: now, requestHash: 'd'.repeat(64), state: 'accepted' as const,
    }))] });
  }

  it('answers the worker for the parent when the conversation has no room for its reply', async () => {
    process.env.CEZ_DELEGATION = '1';
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask');
    fillConversation(p.id, w.id, 1023);
    manager.enqueueOwnedRun(w.id);
    await until(() => cezarAnswered(w.id).length === 1);
    expect(eventsOf(w.id, 'worker-question-undelivered')).toEqual([expect.objectContaining({ reason: 'the parent conversation is at capacity' })]);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    noHumanCard(w.id);
  });

  it("keeps room for an open question's reply in the conversation and the worker's inbox", async () => {
    const f = await askedPair();
    try {
      const progress = () => f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo more', timeoutSeconds: 600 });
      const capacity = (error: unknown) => error instanceof DelegationPolicyError && error.code === 'capacity_limit';
      // Inbox: 32 held inputs from any producer; ordinary messages are refused, the reply is not.
      // These fill capacity, not 32 extra reply turns with Git bookkeeping. The native mock
      // reads ack-only input but leaves it silent; the correlated reply still completes a turn.
      const now = new Date().toISOString();
      const held = Array.from({ length: 32 }, () => ({ id: randomUUID(), source: 'lifecycle' as const, parentRunId: f.p.id, text: 'mock:ack-only held', createdAt: now }));
      fixtureUpdateRun(f.w.id, { agentInputs: [...(store.getRun(f.w.id)?.agentInputs ?? []), ...held] });
      expect(store.getRun(f.w.id)?.agentInputs?.filter(input => !input.deliveredAt)).toHaveLength(32);
      await expect(progress()).rejects.toSatisfy(capacity);
      // Conversation: 1,023 messages plus the reply's reserved slot fill the 1,024.
      fillConversation(f.p.id, f.w.id, 1023);
      await expect(progress()).rejects.toSatisfy(capacity);
      const reply = await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      // Observe native consumption, so teardown does not race input still in the mock's pipe.
      await until(() => held.every(entry => !!store.getRun(f.w.id)?.agentInputs?.find(input => input.id === entry.id)?.consumedAt));
      const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<typeof f.p>;
      const persistedParent = disk.find(run => run.id === f.p.id)!;
      const conversation = persistedParent.delegation?.role === 'root' ? persistedParent.delegation.conversation : undefined;
      expect(conversation?.messages).toHaveLength(1024);
      expect(conversation?.messages.filter(message => message.id === reply.message.id)).toHaveLength(1);
      expect(conversation?.outcomes.filter(outcome => outcome.requestId === f.questionId)).toEqual([
        expect.objectContaining({ status: 'replied', replyId: reply.message.id }),
      ]);
      const persistedReply = disk.find(run => run.id === f.w.id)?.agentInputs?.find(input => input.id === reply.message.id);
      expect(persistedReply).toMatchObject({ deliveredAt: expect.any(String), consumedAt: expect.any(String) });
      expect(answered(f.w.id)).toHaveLength(1);
    } finally { f.close(); }
  });

  // hearsay-tools/cezarion#2410: the question ends with the worker that asked it. Its parent is live,
  // so a Continue goes ahead, as a plain Continue rather than an answer.
  it('closes the question when the asking worker itself stops', async () => {
    const f = await askedPair();
    f.close();
    manager.cancel(f.w.id);
    await until(() => closedAs(f.w.id).length === 1);
    expect(closedAs(f.w.id)).toEqual(['worker-stopped']);
    expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: 'sender-closed' })]);
    noHumanCard(f.w.id);
    await until(() => !manager.isActive(f.w.id));
    expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo plain continue' })).toEqual({ ok: true });
    await until(() => said(f.w.id, 'plain continue'));
    expect(eventsOf(f.w.id, 'human-input-delivered')).toEqual([]);
  });

  it('admits the reply even when steering filled the worker inbox', async () => {
    const f = await askedPair();
    try {
      const steer = () => manager.steerWorker(f.w.id, { id: randomUUID(), source: 'agent', parentRunId: f.p.id, text: 'mock:agent-echo steer', createdAt: new Date().toISOString() });
      for (let i = 0; i < 32; i++) steer();
      expect(() => steer()).toThrow(expect.objectContaining({ code: 'capacity_limit' }));
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
    } finally { f.close(); }
  });

  // A reply waiting for capacity does not outlive its cancelled parent (hearsay-tools/cezarion#2410).
  it('closes the question when the parent is cancelled while its accepted reply waits for admission', async () => {
    const f = await askedPair();
    try {
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
      await until(() => store.getRun(blocker.id)?.status === 'running' && semaphore.busy() === 1);
      await f.reply('mock:agent-echo Use the parser');
      manager.cancel(f.p.id);
      await until(() => closedAs(f.w.id).length === 1 && store.getRun(f.w.id)?.status === 'cancelled');
      expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
      manager.cancel(blocker.id);
      await until(() => !manager.isActive(f.w.id) && !manager.isActive(blocker.id));
      expect(answered(f.w.id)).toEqual([]);
      noHumanCard(f.w.id);
    } finally { f.close(); }
  });

  // hearsay-tools/cezarion#1235: the parked wait is a list entry, and the answer that reopens the
  // closed session withdraws nothing.
  it('leaves an earlier wait open when the answer reopens a closed worker session', async () => {
    const f = await askedPair();
    const request = randomUUID();
    const credentials = new CredentialRegistry();
    try {
      const workerCaller = credentials.authenticate(credentials.issue('project', f.w.id, randomUUID()))!;
      await f.service.send(workerCaller, { id: request, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
    } finally { credentials.close(); }
    const delegation = store.getRun(f.w.id)!.delegation!;
    if (delegation.role !== 'worker') throw Error('missing worker');
    store.commitDelegation([{ id: f.w.id, delegation: { ...delegation, wait: { id: randomUUID(), workerIds: [], requestIds: [request], outcomes: [],
      deadline: new Date(Date.now() + 600_000).toISOString(), phase: 'parked' } } }]);
    f.close();
    await restart(false, undefined, eventCheckpoint());
    const credentials2 = new CredentialRegistry();
    try {
      const parentCaller = credentials2.authenticate(credentials2.issue('project', f.p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ id: 'project', root, store, manager });
      await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting' && !manager.isActive(f.w.id));
      await service.send(parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: f.questionId, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
      await until(() => answered(f.w.id).length === 1);
      expect(waitOf(store.getRun(f.w.id))?.requestIds).toEqual([request]);
    } finally { credentials2.close(); }
  });

  it('refuses an answer the stopping worker can no longer receive', async () => {
    const f = await askedPair();
    try {
      manager.cancel(f.w.id);
      await expect(f.reply('mock:agent-echo Use the parser')).rejects.toSatisfy(error =>
        error instanceof DelegationPolicyError && error.code === 'incompatible_state');
      await until(() => closedAs(f.w.id).length === 1);
      expect(closedAs(f.w.id)).toEqual(['worker-stopped']);
    } finally { f.close(); }
  });

  it('closes the question when the worker stops before an accepted reply lands', async () => {
    const f = await askedPair();
    try {
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
      await until(() => store.getRun(blocker.id)?.status === 'running' && semaphore.busy() === 1);
      const reply = await f.reply('mock:agent-echo Use the parser');
      manager.cancel(f.w.id);
      await until(() => closedAs(f.w.id).length === 1);
      expect(closedAs(f.w.id)).toEqual(['worker-stopped']);
      // The accepted reply closes with its question: no later turn reads it as a message.
      expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.id === reply.message.id) ?? false).toBe(false);
      manager.cancel(blocker.id);
      await until(() => !manager.isActive(f.w.id) && !manager.isActive(blocker.id));
      expect(answered(f.w.id)).toEqual([]);
      noHumanCard(f.w.id);
      expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo plain continue' })).toEqual({ ok: true });
      await until(() => said(f.w.id, 'plain continue') && store.getRun(f.w.id)?.status === 'waiting');
      expect(eventsOf(f.w.id, 'human-input-delivered')).toEqual([]);
      expect(said(f.w.id, 'Use the parser')).toBe(false);
      // A restart replays only unread input, and the reply is gone from the worker's queue.
      expect(store.getRun(f.w.id)?.agentInputs?.some(input => input.id === reply.message.id) ?? false).toBe(false);
    } finally { f.close(); }
  });
});
