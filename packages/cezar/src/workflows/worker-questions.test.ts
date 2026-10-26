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
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { COMPLETION_NUDGE_NOTE, COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES, WORKER_FALLBACK_HEADER, WORKER_FALLBACK_QUESTION, WORKER_FALLBACK_REPLY_NOTE } from './run.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { bookkeeping, delegatingParent, eventCheckpoint, fixtureUpdateRun, manager, parent, register, restart, root, semaphore, spendWorkerBudget, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';
import { readPersistedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { monitoringWakeOf } from './waits.testkit.ts';

/** #505 PR B: a worker's question goes to its owning parent, not to the human. */
describe('worker questions route to the parent (#505)', { timeout: 45_000 }, () => {
  // afterEach runs in reverse registration order: keep process scoping alive
  // through the fixture's real session/autosave shutdown, then restore mocks.
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
  useWorkerWaitFixture();
  const conversationOf = (rootId: string) => { const d = store.getRun(rootId)?.delegation; return d?.role === 'root' ? d.conversation : undefined; };
  const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter(event => event.type === type);
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

  it('leaves the question with the human when the parent cannot take another message', async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    // 32 undelivered inputs fill the parent's inbox (plain input, so nothing wakes it).
    const now = new Date().toISOString();
    fixtureUpdateRun(p.id, { agentInputs: Array.from({ length: 32 }, () => ({ id: randomUUID(), source: 'agent' as const, parentRunId: p.id, text: 'queued', createdAt: now })) });
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(w.id, 'worker-question-fallback')[0]).toMatchObject({ askSeq: eventsOf(w.id, 'ask.requested')[0]!.seq });
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    await until(() => store.getRun(w.id)?.status === 'waiting');
  });

  // hearsay-tools/cezarion#1301: a worker's second turn end with no wait or done asks its parent; a
  // parent that cannot receive leaves the question with the human, as for a worker's own question.
  it("a reviewing parent's worker fallback goes to the human", async () => {
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    fixtureUpdateRun(p.id, { status: 'review' });
    const inputs = store.getRun(p.id)?.agentInputs?.length ?? 0;
    const w = await worker(p.id); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-fallback').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const ask = eventsOf(w.id, 'ask.requested');
    expect(ask).toEqual([expect.objectContaining({ questions: [{ header: WORKER_FALLBACK_HEADER, question: WORKER_FALLBACK_QUESTION(w.id) }] })]);
    expect(eventsOf(w.id, 'worker-question-fallback')[0]).toMatchObject({ askSeq: ask[0]!.seq });
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
    expect(conversationOf(p.id)?.messages.some(m => m.question) ?? false).toBe(false);
    expect(store.getRun(p.id)?.agentInputs?.length ?? 0).toBe(inputs);
    expect(hasPendingAsk(store, w.id)).toBe(true);
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

  it('a Continue on a stopped worker supersedes its fallback question and proceeds', async () => {
    const f = await idleWorker();
    manager.requestWorkerStop(f.w.id); expect(await manager.awaitRunTermination(f.w.id, 15_000)).toBe(true);
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' }, true)).toEqual({ ok: true });
    expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([expect.objectContaining({ askSeq: f.askSeq, reason: 'superseded' })]);
    await until(() => store.getRun(f.w.id)?.status === 'waiting');
  });

  /** The fallback question stands, and the worker's waits and its request's outcomes are as given. */
  function expectFallbackIntact(f: Awaited<ReturnType<typeof idleWorker>>, waits: unknown, outcomes: unknown) {
    expect(eventsOf(f.w.id, 'human-ask-closed')).toEqual([]);
    expect(store.transcriptFacts(f.w.id).pendingAsk?.seq).toBe(f.askSeq);
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
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    store.commitRootFinishIntent(f.p.id);
    // The stop already settled the worker's waits and its open request; the refusal leaves both as they are.
    const waits = structuredClone(store.getRun(f.w.id)?.waits);
    const outcomes = conversationOf(f.p.id)?.outcomes.filter(outcome => outcome.requestId === f.requestId);
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' }, true)).toEqual({ ok: false, error: 'parent finish is pending' });
    expectFallbackIntact(f, waits, outcomes);
  });

  // hearsay-tools/cezarion#1301: a Continue whose checkpoint fails is refused, so it supersedes nothing.
  it('a Continue refused at its checkpoint leaves the fallback question, its wait and its routed request intact', async () => {
    const f = await idleWorker();
    manager.requestWorkerStop(f.w.id); expect(await manager.awaitRunTermination(f.w.id, 15_000)).toBe(true);
    const waits = structuredClone(store.getRun(f.w.id)?.waits);
    const outcomes = conversationOf(f.p.id)?.outcomes.filter(outcome => outcome.requestId === f.requestId);
    const fail = vi.spyOn(store, 'commitWorkerContinuation').mockImplementationOnce(() => { throw Error('disk full'); });
    expect(manager.continueRun(f.w.id, { text: 'mock:hold' }, true)).toEqual({ ok: false, error: 'worker execution checkpoint unavailable' });
    expect(fail).toHaveBeenCalledTimes(1);
    expectFallbackIntact(f, waits, outcomes);
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
        : vi.spyOn(manager as unknown as { retireUnreadParentQuestion(parentId: string, requestId: string): void }, 'retireUnreadParentQuestion')
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

  it('leaves the question with the human when the parent may not message its workers', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
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
      await until(() => manager['waiting'].has(f.p.id) || (!manager.isActive(f.p.id) && !!monitoringWakeOf(store.getRun(f.p.id))));
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
          const orphan = manager['orphanedWorkerGeneration'](f.w.id);
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

  it('keeps a routed question parent-only until it falls back to the human', async () => {
    const f = await askedPair();
    try {
      const refusals = () => eventsOf(f.w.id, 'note').filter(event => event.message === 'This question was sent to the parent task; answer it there.');
      expect(manager.sendMessage(f.w.id, [{ type: 'text', text: 'mock:agent-echo human answer' }])).toBe(false);
      expect(refusals()).toHaveLength(1);
      expect(eventsOf(f.w.id, 'human-input-delivered')).toEqual([]);
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('human answer'))).toBe(false);
      // The fallback hands the question back to the human, who can then answer it.
      store.appendEvent(f.w.id, { type: 'worker-question-fallback', askSeq: eventsOf(f.w.id, 'ask.requested')[0]!.seq, reason: 'test' });
      expect(manager.sendMessage(f.w.id, [{ type: 'text', text: 'mock:agent-echo human answer' }])).toBe(true);
      await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
      expect(eventsOf(f.w.id, 'human-input-delivered')[0]!.source).toBeUndefined();
    } finally { f.close(); }
  });

  it('refuses a human Continue on a routed question whose session is gone', async () => {
    const f = await askedPair();
    f.close();
    await restart(false, undefined, eventCheckpoint());
    await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
    expect(manager.continueRun(f.w.id, { text: 'human answer' })).toEqual({ ok: false, error: 'This question was sent to the parent task; answer it there.' });
    store.appendEvent(f.w.id, { type: 'worker-question-fallback', askSeq: eventsOf(f.w.id, 'ask.requested')[0]!.seq, reason: 'test' });
    expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo human answer' }).ok).toBe(true);
    await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
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
      const refusal = `worker reply ${f.w.id} '<answer>' --id <new-UUID> --request-id ${f.questionId}`;
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

  it("hands a routed question back to the human when the parent is cancelled", async () => {
    const f = await askedPair();
    f.close();
    const askSeq = eventsOf(f.w.id, 'ask.requested')[0]!.seq;
    manager.cancel(f.p.id);
    await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-fallback')[0]).toMatchObject({ askSeq, reason: 'parent-cancelled' });
    expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: 'human-fallback' })]);
    await until(() => !manager.isActive(f.w.id));
    // The cancelled worker is now the human's to answer.
    expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo human answer' }).ok).toBe(true);
    await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
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

  it('hands a routed question to the human while the parent rests at review, keeping the worker live', async () => {
    const f = await askedPair();
    f.close();
    fixtureUpdateRun(f.p.id, { status: 'review' });
    manager.reconcileWorkerWaits();
    expect(eventsOf(f.w.id, 'worker-question-fallback')).toEqual([expect.objectContaining({ reason: 'parent-review' })]);
    expect(store.getRun(f.w.id)?.status).toBe('waiting');
    expect(manager.sendMessage(f.w.id, [{ type: 'text', text: 'mock:agent-echo human answer' }])).toBe(true);
    await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
  });

  it('hands a routed question to the human on recovery when the parent closed before the crash', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'done';
    await restart(false, disk, events);
    await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-fallback')[0]).toMatchObject({ reason: 'parent-done' });
    expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: 'human-fallback' })]);
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
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(answered(f.w.id)).toEqual([]);
        // Freeing the slot admits the worker, and the held answer goes in.
        manager.cancel(blocker.id);
        await until(() => answered(f.w.id).length === 1);
      } finally { clearInterval(sample); }
      expect(peak).toBeLessThanOrEqual(1);
    } finally { f.close(); }
  });

  it('lets the human answer a question handed back by a reviewing parent after the session closed', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'review';
    await restart(false, disk, events);
    await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
    await until(() => !manager.isActive(f.w.id));
    expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo human answer' })).toEqual({ ok: true });
    await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
    // Without the fallback, a reviewing parent still gates its worker's Continue.
    expect(manager.continueRun(f.w.id).ok).toBe(false);
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

  it('leaves the question with the human when the conversation has no room for its reply', async () => {
    process.env.CEZ_DELEGATION = '1';
    const p = await steeringParent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask');
    fillConversation(p.id, w.id, 1023);
    manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
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

  it("hands the question to the human when the asking worker itself stops", async () => {
    const f = await askedPair();
    f.close();
    manager.cancel(f.w.id);
    await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-fallback')[0]).toMatchObject({ reason: 'question-sender-closed' });
    await until(() => !manager.isActive(f.w.id));
    expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo human answer' })).toEqual({ ok: true });
    await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
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

  it("delivers an accepted reply instead of falling back when the parent settles before admission", async () => {
    const f = await askedPair();
    try {
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
      await until(() => store.getRun(blocker.id)?.status === 'running' && semaphore.busy() === 1);
      await f.reply('mock:agent-echo Use the parser');
      // The parent rests at review while its reply still waits for capacity.
      fixtureUpdateRun(f.p.id, { status: 'review' });
      manager.reconcileWorkerWaits();
      expect(eventsOf(f.w.id, 'worker-question-fallback')).toEqual([]);
      manager.cancel(blocker.id);
      await until(() => answered(f.w.id).length === 1);
      expect(eventsOf(f.w.id, 'worker-question-fallback')).toEqual([]);
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
      await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
    } finally { f.close(); }
  });

  it('hands the question back when the worker stops before an accepted reply lands', async () => {
    const f = await askedPair();
    try {
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
      await until(() => store.getRun(blocker.id)?.status === 'running' && semaphore.busy() === 1);
      await f.reply('mock:agent-echo Use the parser');
      manager.cancel(f.w.id);
      await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
      expect(eventsOf(f.w.id, 'worker-question-fallback')[0]).toMatchObject({ reason: 'worker-stopped' });
      manager.cancel(blocker.id);
      await until(() => !manager.isActive(f.w.id) && !manager.isActive(blocker.id));
      expect(answered(f.w.id)).toEqual([]);
      expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo human answer' })).toEqual({ ok: true });
      await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
    } finally { f.close(); }
  });
});
