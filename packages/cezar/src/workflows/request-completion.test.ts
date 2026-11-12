import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { runnerHook } from './run-fixture.testkit.ts';
import { completionRefusal, type CompletionGateHost } from './run/completion-gate.ts';
import { TrackedWork } from './run/tracked-work.ts';
import type { RunModuleContext } from './run/types.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { join } from 'node:path';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import type { AgentSession, AgentRunResult } from '../core/agent-runner.ts';
import { RUN_STATUS, STEP_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { squawkDoneAnswerSchema } from '@open-mercato/cezar-contract/waits';
import { manager, parent, restart, root, store, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

function unused<T extends object>(name: string, values: Partial<T> = {}): T {
  return new Proxy(values, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    throw new Error(`unused collaborator ${name}.${String(key)}`);
  } }) as T;
}

function rootTask() {
  const run = store.createRun({ title: 'root', task: 'root', workflow: 'quick-task', workflowDef: QUICK_TASK_WORKFLOW,
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
  store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
  setRunStatus(store, run.id, RUN_STATUS.waiting, { currentStepId: 'task' });
  return run;
}
function obligation(senderRunId: string, recipientRunId: string, kind: 'request' | 'progress' = 'request') {
  return { id: randomUUID(), senderRunId, recipientRunId, kind, relationship: 'peer' as const, text: 'Check',
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(), state: 'accepted' as const, requestHash: 'a'.repeat(64) };
}
function completionRefusalFor(id: string) {
  const context: RunModuleContext = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'),
    work: new TrackedWork(), semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => false };
  const host = unused<CompletionGateHost>('completionHost', { active: new Map(),
    unansweredQuestions: () => [], parentCompletionBlockers: () => [] });
  return completionRefusal(context, host, id);
}

async function closingRoot() {
  let close!: () => void;
  runnerHook.runner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(_spec, onEvent) {
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
      close = end;
      const session: AgentSession = { get open() { return open; }, result, end, interrupt: end,
        sendMessage: () => true, sendAgentMessage: async () => {}, discardQueuedMessages: () => {}, holdsHumanInput: () => false };
      queueMicrotask(() => onEvent?.({ type: 'session', sessionId: 'closed-root' }));
      return session;
    },
  };
  const run = await parent('work');
  return { run, close };
}

describe('root request completion without a live session', () => {
  useWorkerWaitFixture();
  afterEach(() => { runnerHook.runner = undefined; });
  it.each(['cancelled', 'progress'] as const)('%s creates no completion obligation', kind => {
    const sender = rootTask(); const recipient = rootTask();
    const message = obligation(sender.id, recipient.id, kind === 'progress' ? 'progress' : 'request');
    store.commitConversation(sender.id, { messages: [message], outcomes: kind === 'cancelled'
      ? [{ requestId: message.id, status: RUN_STATUS.cancelled, observedAt: new Date().toISOString() }] : [] });
    expect(completionRefusalFor(sender.id)).toBeUndefined();
  });
  it('queues a refusal naming the request when done reaches the gate without a session', async () => {
    const closing = await closingRoot();
    const sender = closing.run; const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    closing.close();
    await until(() => store.getRun(sender.id)?.agentInputs?.some(input => input.purpose === 'completion-refusal') === true);
    expect(store.getRun(sender.id)?.agentInputs).toEqual(expect.arrayContaining([expect.objectContaining({
      purpose: 'completion-refusal', text: expect.stringContaining(request.id),
    })]));
  });
  it.each(['waiting', 'review'] as const)('human Finish closes open sent requests without a session at %s', async status => {
    const sender = rootTask(); const recipient = rootTask();
    const request = obligation(sender.id, recipient.id);
    store.commitConversation(sender.id, { messages: [request], outcomes: [] });
    setRunStatus(store, sender.id, status);
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
    setRunStatus(store, recipient.id, status);
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
    setRunStatus(store, sender.id, status);
    const delegation = store.getRun(sender.id)!.delegation;
    if (delegation?.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: sender.id, delegation: { ...delegation, finishRequestedAt: new Date().toISOString() } }]);
    if (status === 'review') expect(manager.finish(sender.id)).toBe(true);
    else await restart();
    await until(() => store.getRun(sender.id)?.status === 'done');
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
    store.move(run.id, 'fail', { error: 'provider failed' });
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.failed, error: 'provider failed' });
    expect(store.getRun(run.id)?.delegation).not.toHaveProperty('finishRequestedAt');
    expect(store.getRun(run.id)?.delegation).not.toHaveProperty('conversation');
  });
  it('recovery retires an old failed Finish intent without changing the failure', async () => {
    const run = rootTask();
    setRunStatus(store, run.id, RUN_STATUS.failed, { error: 'provider failed' });
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
    const refusal = completionRefusalFor(recipient.id)!;
    expect(refusal.code).toBe('requests_unanswered');
    expect(refusal.message).toContain('5 more incoming requests omitted');
    expect(refusal.message).toContain('hsq message conversation <sender>');
    expect(refusal.message.length).toBeLessThanOrEqual(4096);
    expect(squawkDoneAnswerSchema.safeParse({ ok: false, code: refusal.code, message: refusal.message }).success).toBe(true);
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
    const refusal = completionRefusalFor(sender.id)!;
    for (const request of messages) {
      expect(refusal.message).toContain(request.id);
      expect(refusal.message).toContain(request.recipientRunId);
      expect(refusal.message).toContain(request.deadline);
    }
    expect(squawkDoneAnswerSchema.safeParse({ ok: false, code: refusal.code, message: refusal.message, open_waits: [] }).success).toBe(true);
  });
});
