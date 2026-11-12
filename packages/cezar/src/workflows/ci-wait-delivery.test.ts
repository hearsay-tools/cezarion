import { observationClock } from '../core/observation-clock.testkit.ts';
// Register the external CI mock before loading RunManager.
import { success, ciWaitOf, lastCiWaitOf, github, register, githubByPr, registerPr, acquireExternalCiResources } from './ci-wait-fixture.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import * as runners from '../core/runner-factory.ts';
import type { AgentEvent, AgentRunResult, AgentRunner, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { controlledWire, manager, parent, root, semaphore, store, until, useWorkerWaitFixture, work, toolGenerationOf } from './worker-wait.testkit.ts';


describe('CI wait delivery', { timeout: 30_000 }, () => {
  useWorkerWaitFixture({ acquireCiResources: acquireExternalCiResources });
  afterEach(() => vi.restoreAllMocks());
  it('requeues a settled wake dequeued after losing its turn boundary', async () => {
    const external = github();
    let emit!: (event: AgentEvent) => void;
    const send = vi.fn<AgentSession['sendAgentMessage']>();
    const runner: AgentRunner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent) {
        emit = event => onEvent?.(event);
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        queueMicrotask(() => emit({ type: 'session', sessionId: 'lost-boundary' }));
        return { get open() { return open; }, result, end: close, interrupt: close,
          sendMessage: () => true,
          sendAgentMessage: send,
          discardQueuedMessages() {}, holdsHumanInput: () => false };
      },
    };
    send.mockImplementation(() => {
      queueMicrotask(() => emit({ type: 'turn-end' }));
      return Promise.resolve();
    });
    vi.spyOn(runners, 'createRunner').mockReturnValue(runner);
    const run = await parent();
    const wait = await register(run.id);
    const answer = await manager.cezarToolHandlers(run.id, toolGenerationOf(run.id)).ask({
      context: 'Choose before continuing.', questions: [{ header: 'Choice', question: 'Which option?' }],
    }, new AbortController().signal);
    expect(answer.ok).toBe(true);
    emit({ type: 'turn-end' });
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.readEvents(run.id).some(event => event.type === 'ask.requested'));
    observationClock(delay => delay === 1000 && /\bat WakeRetries\.retryWaitAdmission \(/.test(new Error().stack ?? ''));
    const capacity = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    external.settle(success());
    await until(() => ciWaitOf(run.id)?.phase === 'resolved');
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Use the first option.' }])).toBe(true);
    expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
    const queued = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: 'claude' });
    capacity.mockReturnValue(2);
    vi.spyOn(semaphore, 'projectMaxParallel').mockReturnValue(2);
    await semaphore.release();
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
    // A second sweep must still stop at the retained wake, ahead of ordinary work.
    await semaphore.release();
    await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
    expect(semaphore.busy()).toBe(1);
    expect(store.getRun(queued.id)?.status).toBe('queued');
    expect(manager.cancel(queued.id)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    emit({ type: 'turn-end' });
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    const deliveries = send.mock.calls.filter(call => call[1]?.includes(wait.id));
    expect(deliveries).toHaveLength(1);
    expect(store.getRun(run.id)?.agentInputs?.filter(input => input.id === wait.id)).toHaveLength(1);
  });

  it('keeps an accepted CI wake parked and charged until acknowledgement', async () => {
    const external = githubByPr();
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await registerPr(run.id, 12);
    expect(work.liveSessions.size).toBe(1);
    const [session] = work.liveSessions;
    const second = await parent(); await until(() => store.getRun(second.id)?.status === 'waiting');
    await registerPr(second.id, 13);
    expect(semaphore.busy()).toBe(1);
    const original = session!.sendAgentMessage.bind(session);
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const send = vi.spyOn(session!, 'sendAgentMessage').mockImplementation((...args) => {
      const accepted = original(...args);
      return accepted && accepted.then(() => ack);
    });
    const turnEnds = () => store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
    const before = turnEnds();
    try {
      external.settle(12);
      await until(() => send.mock.calls.length === 1);
      // Native activity and turn-end happen before the held transport ACK.
      await until(() => turnEnds() === before + 1);
      expect(work.liveSessions.has(session!)).toBe(true);
      expect(store.getRun(run.id)?.agentInputs?.find(input => input.id === ciWaitOf(run.id)?.id)?.deliveredAt).toBeUndefined();
      expect(store.getRun(run.id)?.status).toBe('waiting');
      expect(semaphore.busy()).toBe(1);
      expect(ciWaitOf(run.id)?.phase).toBe('resolved');
      acknowledge();
      await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
      // Nothing left open: the boundary parks for the user and gives the pool slot back.
      await until(() => store.getRun(run.id)?.waits?.some(wait => wait.kind === 'human') === true && store.getRun(run.id)?.status === 'waiting');
      expect(ciWaitOf(second.id)?.phase).toBe('open');
      expect(semaphore.busy()).toBe(0);
    } finally { acknowledge(); }
  });

  it('stops refused CI retries on cancel', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const wait = await register(run.id);
    expect(work.liveSessions.size).toBe(1);
    const [session] = work.liveSessions;
    const send = vi.spyOn(session!, 'sendAgentMessage').mockReturnValue(false);
    const clock = observationClock(delay => delay === 1000 && /\bat WakeRetries\.retryWaitAdmission \(/.test(new Error().stack ?? ''));
    external.settle(success());
    await until(() => send.mock.calls.length >= 1 && clock.pending > 0);
    await clock.advance(1000);
    await until(() => send.mock.calls.length >= 2);
    expect(manager.cancel(run.id)).toBe(true);
    const attempts = send.mock.calls.length;
    await clock.advance(2000);
    expect(send).toHaveBeenCalledTimes(attempts);
    expect(ciWaitOf(run.id)).toBeUndefined();
    expect(store.getRun(run.id)?.agentInputs?.some(input => input.id === wait.id)).toBe(false);
  });

  it('wakes every CI park at once when the pool is smaller than the parks', async () => {
    const external = github();
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(1);
    const first = await parent(); await until(() => store.getRun(first.id)?.status === 'waiting');
    await register(first.id);
    const second = await parent(); await until(() => store.getRun(second.id)?.status === 'waiting');
    await register(second.id);
    expect(semaphore.busy()).toBe(1); // one pool slot, one regular slot
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const sends = [...work.liveSessions].map(session => {
      const original = session.sendAgentMessage.bind(session);
      return vi.spyOn(session, 'sendAgentMessage').mockImplementation((...args) => {
        const accepted = original(...args);
        return accepted && accepted.then(() => ack);
      });
    });
    expect(sends).toHaveLength(2);
    try {
      external.settle(success());
      await until(() => sends.every(send => send.mock.calls.length === 1));
      expect(semaphore.busy()).toBe(1);
    } finally { acknowledge(); }
    await until(() => !!lastCiWaitOf(first.id)?.deliveredAt && !!lastCiWaitOf(second.id)?.deliveredAt);
    expect(store.getRun(first.id)?.agentInputs?.filter(input => input.id === lastCiWaitOf(first.id)?.id)).toHaveLength(1);
    expect(store.getRun(second.id)?.agentInputs?.filter(input => input.id === lastCiWaitOf(second.id)?.id)).toHaveLength(1);
  });

  it('delivers a completed wait while another run holds the only regular slot', async () => {
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    const receipt = await register(run.id);
    const blockerGate = join(root, 'blocker-gate'); controlledWire({ firstResultGate: blockerGate });
    const blocker = await parent();
    await until(() => semaphore.busy() === 1);
    try {
      external.settle(success());
      await until(() => !!store.getRun(run.id)?.agentInputs?.find(input => input.id === receipt.id)?.deliveredAt);
      expect(store.getRun(blocker.id)?.status).toBe('running');
    } finally { writeFileSync(blockerGate, 'end'); }
    expect(store.getRun(blocker.id)?.status).not.toBe('cancelled');
  });

  it('resumes a monitor that already holds a charged slot with the exemption disabled', async () => {
    vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    const external = github();
    const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
    await register(run.id);
    expect(semaphore.busy()).toBe(1);
    external.settle(success());
    await until(() => !!lastCiWaitOf(run.id)?.deliveredAt);
    expect(ciWaitOf(run.id)).toBeUndefined();
  });
});
