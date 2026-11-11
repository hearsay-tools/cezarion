import { testHome } from '../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationPolicyError } from '../delegation/policy.ts';
import { DelegationService } from '../delegation/service.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { eventCheckpoint, manager, restart, root, semaphore, store, until, waitOf } from './worker-wait-claude.testkit.ts';
import { conversationOf, eventsOf, closedAs, noHumanCard, askedPair, answered, said, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

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
      service.registerProject({ home: testHome(), id: 'project', root, store, manager });
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
