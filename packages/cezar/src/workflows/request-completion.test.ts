import { runInternals } from './run-internals.testkit.ts';
import { RUN_STATUS, STEP_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { cezarDoneAnswerSchema } from '@open-mercato/cezar-contract/waits';
import { manager, parent, restart, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

function rootTask() {
  const run = store.createRun({ title: 'root', task: 'root', workflow: 'quick-task', workflowDef: QUICK_TASK_WORKFLOW,
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
  store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
  store.updateRun(run.id, { status: RUN_STATUS.waiting, currentStepId: 'task' });
  return run;
}
function obligation(senderRunId: string, recipientRunId: string, kind: 'request' | 'progress' = 'request') {
  return { id: randomUUID(), senderRunId, recipientRunId, kind, relationship: 'peer' as const, text: 'Check',
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), state: 'accepted' as const, requestHash: 'a'.repeat(64) };
}
function gate() {
  return runInternals(manager).runFinish;
}

describe('root request completion without a live session', () => {
  useWorkerWaitFixture();
  it.each(['cancelled', 'progress'] as const)('%s creates no completion obligation', kind => {
    const sender = rootTask(); const recipient = rootTask();
    const message = obligation(sender.id, recipient.id, kind === 'progress' ? 'progress' : 'request');
    store.commitConversation(sender.id, { messages: [message], outcomes: kind === 'cancelled'
      ? [{ requestId: message.id, status: RUN_STATUS.cancelled, observedAt: new Date().toISOString() }] : [] });
    expect(gate().completionRefusal(sender.id)).toBeUndefined();
  });
  it('queues a refusal naming the request when done reaches the gate without a session', () => {
    const sender = rootTask(); const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    expect(gate().completionGate(sender.id)).toBe('held');
    expect(store.getRun(sender.id)?.agentInputs).toEqual(expect.arrayContaining([expect.objectContaining({
      purpose: 'completion-refusal', text: expect.stringContaining(request.id),
    })]));
  });
  it.each(['waiting', 'review'] as const)('human Finish closes open sent requests without a session at %s', async status => {
    const sender = rootTask(); const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    store.updateRun(sender.id, { status });
    expect(manager.finishBlockedReason(sender.id)).toBeUndefined();
    expect(manager.finish(sender.id)).toBe(true);
    await until(() => store.getRun(sender.id)?.status === 'done');
    const delegation = store.getRun(sender.id)?.delegation;
    expect(delegation?.role === 'root' && delegation.conversation?.outcomes).toEqual([
      expect.objectContaining({ requestId: request.id, status: 'sender-closed' }),
    ]);
  });
  it.each(['waiting', 'review'] as const)('no-session Finish at %s settles incoming requests and delivers the sender wait', async status => {
    const sender = await parent(); const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    const wait = manager.registerWorkerListWait(sender.id, { requestIds: [request.id], timeoutSeconds: 600 }, 'cezar_wait');
    const terminalPasses: string[] = [];
    const reconcile = manager.reconcileWorkerWaits.bind(manager);
    const observer = vi.spyOn(manager, 'reconcileWorkerWaits').mockImplementation(id => {
      const recipientStatus = store.getRun(recipient.id)?.status;
      if (id === sender.id && (recipientStatus === RUN_STATUS.done || recipientStatus === RUN_STATUS.review)) terminalPasses.push(id);
      return reconcile(id);
    });
    store.updateRun(recipient.id, { status });
    expect(manager.finish(recipient.id)).toBe(true);
    await until(() => store.getRun(sender.id)?.lastWaits?.some(entry => entry.id === wait.id && entry.phase === WAIT_PHASE.delivered) === true);
    expect(store.getRun(recipient.id)?.status).toBe('done');
    expect(terminalPasses).toContain(sender.id);
    observer.mockRestore();
    const delegation = store.getRun(sender.id)?.delegation;
    expect(delegation?.role === 'root' && delegation.conversation?.outcomes).toEqual([
      expect.objectContaining({ requestId: request.id, status: 'completed-without-reply' }),
    ]);
  });
  it('live-session Finish closes sent requests and retires its intent at completion', async () => {
    const sender = await parent(); const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    expect(manager.finish(sender.id)).toBe(true);
    await until(() => store.getRun(sender.id)?.status === 'done' && !manager.isActive(sender.id));
    const delegation = store.getRun(sender.id)?.delegation;
    expect(delegation).not.toHaveProperty('finishRequestedAt');
    expect(delegation?.role === 'root' && delegation.conversation?.outcomes).toEqual([
      expect.objectContaining({ requestId: request.id, status: 'sender-closed' }),
    ]);
  });
  it.each(['running', 'review'] as const)('replays accepted Finish at %s before request reconciliation', async status => {
    const sender = rootTask(); const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    store.updateRun(sender.id, { status });
    const delegation = store.getRun(sender.id)!.delegation;
    if (delegation?.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: sender.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
    await gate().settleRequestedRootFinish(sender.id);
    expect(store.getRun(sender.id)?.status).toBe('done');
    const finished = store.getRun(sender.id)?.delegation;
    expect(finished).not.toHaveProperty('finishRequestedAt');
    expect(finished?.role === 'root' && finished.conversation?.outcomes).toEqual([
      expect.objectContaining({ requestId: request.id, status: 'sender-closed' }),
    ]);
  });
  it('failure retires an accepted Finish intent with no peer or conversation', () => {
    const run = rootTask();
    const delegation = store.getRun(run.id)!.delegation;
    if (delegation?.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: run.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
    (manager as unknown as { settleFailedRun(id: string, error: string, capped: boolean): void })
      .settleFailedRun(run.id, 'provider failed', false);
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.failed, error: 'provider failed' });
    expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
    expect(store.getRun(run.id)?.delegation).not.toHaveProperty('conversation');
  });
  it('recovery retires an old failed Finish intent without changing the failure', async () => {
    const run = rootTask();
    store.updateRun(run.id, { status: RUN_STATUS.failed, error: 'provider failed' });
    const delegation = store.getRun(run.id)!.delegation;
    if (delegation?.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: run.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
    await restart();
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.failed, error: 'provider failed' });
    expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
  });
  it('bounds incoming refusal text and settles every request, including omitted names', async () => {
    const recipient = await parent(HARNESS_ADAPTERS.claude.scenarios.baseline!);
    await until(() => store.getRun(recipient.id)?.status === 'waiting');
    const senders = [rootTask(), rootTask()];
    for (const [index, sender] of senders.entries()) store.commitConversation(sender.id, {
      messages: Array.from({ length: index === 0 ? 32 : 13 }, () => obligation(sender.id, recipient.id)), outcomes: [],
    });
    const refusal = gate().completionRefusal(recipient.id)!;
    expect(refusal.code).toBe('requests_unanswered');
    expect(refusal.message).toContain('5 more incoming requests omitted');
    expect(refusal.message).toContain('cez message conversation <sender>');
    expect(refusal.message.length).toBeLessThanOrEqual(4096);
    expect(cezarDoneAnswerSchema.safeParse({ ok: false, code: refusal.code, message: refusal.message }).success).toBe(true);
    // The first cezar_done is refused with the request list; a second one in the same completion
    // cycle finishes without replying, and every request settles.
    expect(manager.sendMessage(recipient.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${toolCall('cezar_done', {})}` }])).toBe(true);
    await until(() => store.getRun(recipient.id)?.status === 'done' && !manager.isActive(recipient.id));
    expect(store.readEvents(recipient.id).some(event => event.type === 'text' && String(event.text).includes('requests_unanswered'))).toBe(true);
    for (const [index, sender] of senders.entries()) {
      const delegation = store.getRun(sender.id)?.delegation;
      const outcomes = delegation?.role === 'root' ? delegation.conversation?.outcomes : [];
      expect(outcomes).toHaveLength(index === 0 ? 32 : 13);
      expect(outcomes?.every(outcome => outcome.status === 'completed-without-reply')).toBe(true);
    }
  });
  it('names every sent request at the ledger limit within the done answer bound', () => {
    const sender = rootTask(); const recipient = rootTask();
    const messages = Array.from({ length: 32 }, () => obligation(sender.id, recipient.id));
    store.commitConversation(sender.id, { messages, outcomes: [] });
    const refusal = gate().completionRefusal(sender.id)!;
    for (const request of messages) {
      expect(refusal.message).toContain(request.id);
      expect(refusal.message).toContain(request.recipientRunId);
      expect(refusal.message).toContain(request.deadline);
    }
    expect(cezarDoneAnswerSchema.safeParse({ ok: false, code: refusal.code, message: refusal.message, open_waits: [] }).success).toBe(true);
  });
});
