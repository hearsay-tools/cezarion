import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { DelegationService } from '../delegation/service.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { eventCheckpoint, fixtureUpdateRun, manager, parent, register, restart, root, semaphore, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';

/** #505 PR B: a worker's question goes to its owning parent, not to the human. */
describe('worker questions route to the parent (#505)', { timeout: 45_000 }, () => {
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

  it('leaves the question with the human when the parent may not message its workers', async () => {
    const p = await parent(); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-fallback').length === 1);
    expect(eventsOf(w.id, 'worker-question-routed')).toEqual([]);
  });

  /** A parent and a worker that has asked; the question is routed and the worker waits. */
  async function askedPair(parentTask = 'mock:hold') {
    process.env.CEZ_DELEGATION = '1';
    const p = await steeringParent(parentTask); await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1 && store.getRun(w.id)?.status === 'waiting');
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    const credentials = new CredentialRegistry();
    const [parentCaller, workerCaller] = [p, w].map(run => credentials.authenticate(credentials.issue('project', run.id, randomUUID()))!);
    const service = new DelegationService();
    service.registerProject({ id: 'project', root, store, manager });
    const reply = (text: string, id = randomUUID()) => service.send(parentCaller!, { id, recipientRunId: w.id, kind: 'reply', requestId: questionId, text, timeoutSeconds: 600 });
    return { p, w, questionId, service, parentCaller: parentCaller!, workerCaller: workerCaller!, reply, close: () => credentials.close() };
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

  it('progress and follow-ups never answer a pending worker question', async () => {
    const f = await askedPair();
    try {
      const request = randomUUID(); const progress = randomUUID(); const followUp = randomUUID();
      await f.service.send(f.parentCaller, { id: request, recipientRunId: f.w.id, kind: 'request', text: 'mock:agent-echo Also check lint', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: progress, recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Still thinking', timeoutSeconds: 600 });
      await f.service.send(f.parentCaller, { id: followUp, recipientRunId: f.w.id, kind: 'follow-up', requestId: request, text: 'mock:agent-echo Only src', timeoutSeconds: 600 });
      manager.deliverConversationInput(f.w.id);
      const held = () => store.getRun(f.w.id)?.agentInputs?.filter(input => [request, progress, followUp].some(id => id === input.id)) ?? [];
      expect(held().every(input => !input.deliveredAt)).toBe(true);
      expect(answered(f.w.id)).toEqual([]);
      expect(store.getRun(f.w.id)?.status).toBe('waiting');
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1 && held().every(input => !!input.deliveredAt));
      await until(() => said(f.w.id, 'Only src'));
    } finally { f.close(); }
  });

  it('a parent reply answers the worker after a restart', async () => {
    const f = await askedPair();
    f.close();
    await restart(false, undefined, eventCheckpoint());
    const credentials = new CredentialRegistry();
    try {
      const parentCaller = credentials.authenticate(credentials.issue('project', f.p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ id: 'project', root, store, manager });
      // Recovery resumes the parent; the worker's session stays closed on its pending question.
      await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
      expect(manager.isActive(f.w.id)).toBe(false);
      await service.send(parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: f.questionId, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      expect(eventsOf(f.w.id, 'user-message').some(event => String(event.text).includes('Use the parser'))).toBe(false);
    } finally { credentials.close(); }
  });

  it('holds a worker question while the parent waits on the human, then delivers it behind the answer', async () => {
    process.env.CEZ_DELEGATION = '1';
    const p = await steeringParent('mock:ask'); await until(() => eventsOf(p.id, 'ask.requested').length === 1 && store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, 'mock:ask'); manager.enqueueOwnedRun(w.id);
    await until(() => eventsOf(w.id, 'worker-question-routed').length === 1);
    const questionId = String(eventsOf(w.id, 'worker-question-routed')[0]!.messageId);
    const question = () => store.getRun(p.id)?.agentInputs?.find(input => input.id === questionId);
    expect(question()).toBeDefined();
    expect(question()?.deliveredAt).toBeUndefined();
    expect(manager.sendMessage(p.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    await until(() => !!question()?.deliveredAt);
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

  it('holds parent completion on an unanswered worker question without waiting on that worker', async () => {
    const f = await askedPair();
    try {
      await until(() => !!store.getRun(f.p.id)?.agentInputs?.find(input => input.id === f.questionId)?.deliveredAt);
      const engine = manager as unknown as { deferParentCompletion(id: string): boolean };
      expect(engine.deferParentCompletion(f.p.id)).toBe(true);
      const notes = eventsOf(f.p.id, 'note').map(event => String(event.message));
      expect(notes.at(-1)).toBe(`Completion blocked: answer your workers' questions first: ${f.w.id} (request ${f.questionId}).`);
      // Waiting on the worker would deadlock: the worker waits on this parent.
      expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
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
    const disk = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'done';
    await restart(false, JSON.stringify(disk), events);
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
    const disk = JSON.parse(readFileSync(join(root, '.ai/cezar/runs.json'), 'utf8')) as Array<{ id: string; status: string }>;
    for (const run of disk) if (run.id === f.p.id) run.status = 'review';
    await restart(false, JSON.stringify(disk), events);
    await until(() => eventsOf(f.w.id, 'worker-question-fallback').length === 1);
    await until(() => !manager.isActive(f.w.id));
    expect(manager.continueRun(f.w.id, { text: 'mock:agent-echo human answer' })).toEqual({ ok: true });
    await until(() => eventsOf(f.w.id, 'human-input-delivered').length === 1);
    // Without the fallback, a reviewing parent still gates its worker's Continue.
    expect(manager.continueRun(f.w.id).ok).toBe(false);
  });
});
