import { beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/agent-runner.ts';
import type { AgentRunResult } from '../core/agent-runner.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { createActiveRun } from './active-run.ts';
import type { InputGroup } from './run/input-delivery.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';

vi.mock('./active-run.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./active-run.ts')>();
  return { ...actual, createActiveRun: vi.fn((...args: Parameters<typeof actual.createActiveRun>) => {
    const state = actual.createActiveRun(...args);
    expectEmptyInput(state.inputState);
    return state;
  }) };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function expectEmptyInput(group: InputGroup): void {
  expect(group.agentInputError).toBeUndefined();
  expect(group.agentInputFlight).toBeUndefined();
  expect(group.inputDelivery).toBeUndefined();
  expect(group.unreadInputIds).toBeUndefined();
  expect(group.consumedBeforeAck).toBeUndefined();
  expect(group.bundledInputIds).toBeUndefined();
  expect(group.retiredInFlight).toBeUndefined();
  expect(group.unreadInputTimer).toBeUndefined();
  expect(group.unreadRetried).toBeUndefined();
  expect(group.heldHumanInputTimer).toBeUndefined();
  expect(group.heldHumanInputSince).toBeUndefined();
  expect(group.heldHumanInputExpired).toBeUndefined();
  expect(group.openingAnswerAskSeq).toBeUndefined();
  expect(group.openingAgentInputId).toBeUndefined();
  expect(group.writingInput).toBeUndefined();
}

const f = setupMonitoringFixture();
const policy = { mode: 'steer' as const, consumption: 'observable' as const, via: 'entry-state fixture' };
let opened = deferred<void>();
let openedGroups: InputGroup[];
let sendAck: Promise<void>;
let holdsInput: boolean;
let closeWire: () => void;
let emitAgentEvent: (event: AgentEvent) => void;
let reportConsumed: (ids: readonly string[]) => void;
beforeEach(() => {
  vi.mocked(createActiveRun).mockClear();
  openedGroups = [];
  sendAck = Promise.resolve();
  holdsInput = false;
  opened = deferred<void>();
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', inputDelivery: policy,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(_spec, onEvent, options) {
      const calls = vi.mocked(createActiveRun).mock.results;
      const last = calls.at(-1);
      if (!last || last.type !== 'return') throw new Error('runner opened without the ActiveRun factory');
      const group = last.value.inputState;
      expect(group.inputDelivery).toEqual(policy);
      expect([...group.unreadInputIds!]).toEqual([]);
      expect([...group.consumedBeforeAck!]).toEqual([]);
      expect(group.agentInputFlight).toBeUndefined();
      expect(group.retiredInFlight).toBeUndefined();
      expect(group.unreadRetried).toBeUndefined();
      expect(group.bundledInputIds).toBeUndefined();
      expect(group.unreadInputTimer).toBeUndefined();
      expect(group.heldHumanInputTimer).toBeUndefined();
      expect(group.heldHumanInputSince).toBeUndefined();
      expect(group.heldHumanInputExpired).toBeUndefined();
      expect(group.writingInput).toBeUndefined();
      openedGroups.push(group);
      const result = deferred<AgentRunResult>();
      let open = true;
      const close = () => { open = false; result.resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      closeWire = close;
      emitAgentEvent = event => onEvent?.(event);
      reportConsumed = ids => options?.onAgentInputConsumed?.(ids);
      queueMicrotask(() => { onEvent?.({ type: 'session', sessionId: 'input-entry-session' }); opened.resolve(); });
      return { get open() { return open; }, result: result.promise, sendMessage: () => true,
        sendAgentMessage: () => sendAck, discardQueuedMessages: () => {}, holdsHumanInput: () => holdsInput,
        end: close, interrupt: close };
    },
  };
});

it('a fresh run constructs absent input optionals before initializing its delivery sets', async () => {
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened.promise;
  expect(createActiveRun).toHaveBeenCalledOnce();
  expect(openedGroups).toHaveLength(1);
});

it('Continue constructs a new input owner with absent optionals before delivery setup', async () => {
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened.promise;
  expect(f.manager.finish(record.id)).toBe(true);
  await waitForProduct(f.manager, f.store, () => !f.manager.isActive(record.id));
  opened = deferred<void>();
  expect(f.manager.continueRun(record.id, { text: 'continue' })).toEqual({ ok: true });
  await opened.promise;
  expect(createActiveRun).toHaveBeenCalledTimes(2);
  expect(openedGroups).toHaveLength(2);
  expect(openedGroups[1]).not.toBe(openedGroups[0]);
  expect(openedGroups[1]?.unreadInputIds).not.toBe(openedGroups[0]?.unreadInputIds);
});

it('restart recovery constructs absent input optionals before continuation delivery setup', async () => {
  const record = f.store.createRun({ title: 'interrupted', workflow: 'quick-task', task: 'work', runner: 'claude',
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
  f.currentId = record.id;
  setRunStatus(f.store, record.id, RUN_STATUS.running, { currentStepId: 'task', workflowDef: f.SINGLE_STEP });
  f.store.updateStep(record.id, 'task', { status: STEP_STATUS.running, sessionId: 'interrupted-session', backend: 'claude' });
  await f.manager.recover();
  await opened.promise;
  expect(createActiveRun).toHaveBeenCalledOnce();
  expect(openedGroups).toHaveLength(1);
});

async function openInputRun() {
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened.promise;
  f.store.commitDelegation([{ id: record.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  const group = openedGroups[0]!;
  const input = (text: string) => ({ id: randomUUID(), parentRunId: record.id, source: 'lifecycle' as const,
    text, createdAt: new Date().toISOString() });
  return { record, group, input };
}

it('clears retired markers before the ACK checkpoint even when that checkpoint throws', async () => {
  const { record, group, input } = await openInputRun();
  const message = input('work after the opening');
  const ack = deferred<void>();
  sendAck = ack.promise;
  f.store.commitAgentInputs(record.id, [message]);
  f.manager.deliverConversationInput(record.id);
  const flight = group.agentInputFlight!;
  expect(flight.settled).toBeInstanceOf(Promise);
  emitAgentEvent({ type: 'input-unconsumed', inputIds: [message.id] });
  expect(group.retiredInFlight?.has(message.id)).toBe(true);
  const checkpoint = vi.spyOn(f.store, 'commitOutcome').mockImplementationOnce(() => {
    expect(group.retiredInFlight?.has(message.id)).toBe(false);
    throw new Error('refused ACK checkpoint');
  });
  ack.resolve();
  await flight.settled;
  expect(checkpoint).toHaveBeenCalled();
  expect(group.retiredInFlight?.has(message.id)).toBe(false);
  expect(group.agentInputError).toContain('agent input delivery checkpoint failed: refused ACK checkpoint');
  checkpoint.mockRestore();
});

it('keeps accepted unread input delivered until the closing session flight settles', async () => {
  const { record, group, input } = await openInputRun();
  const accepted = input('already accepted');
  const pending = input('ACK still pending');
  f.store.commitAgentInputs(record.id, [accepted, pending]);
  f.store.commitOutcome(record.id, { kind: 'delivered', inputIds: [accepted.id], at: new Date().toISOString(), awaitingRead: true });
  group.recordUnreadInput(accepted.id);
  const ack = deferred<void>();
  sendAck = ack.promise;
  f.manager.deliverConversationInput(record.id);
  const flight = group.agentInputFlight!;
  expect(flight.settled).toBeInstanceOf(Promise);
  const requeued = deferred<void>();
  let flightAtRequeue: InputGroup['agentInputFlight'];
  const commit = f.store.commitOutcome.bind(f.store);
  const checkpoint = vi.spyOn(f.store, 'commitOutcome').mockImplementation((...args) => {
    const outcomes = Array.isArray(args[1]) ? args[1] : [args[1]];
    if (outcomes.some(outcome => outcome.kind === 'requeued' && outcome.inputIds.includes(accepted.id))) {
      flightAtRequeue = group.agentInputFlight;
      requeued.resolve();
    }
    return commit(...args);
  });
  closeWire();
  expect(f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === accepted.id)?.deliveredAt).toBeDefined();
  expect(group.agentInputFlight).toBe(flight);
  ack.resolve();
  await requeued.promise;
  expect(flightAtRequeue).toBeUndefined();
  expect(f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === accepted.id)?.deliveredAt).toBeUndefined();
  checkpoint.mockRestore();
});

it('arms the held-input timer at turn end and clears it before publishing content', async () => {
  const { group, record } = await openInputRun();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    holdsInput = true;
    emitAgentEvent({ type: 'turn-end' });
    const held = group.heldHumanInputTimer;
    expect(held).toBeDefined();
    expect(group.heldHumanInputSince).toBeDefined();
    const clock = group.heldHumanInputSince;
    const clear = clearTimeout;
    let observed = false;
    const spy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
      if (handle === held) {
        observed = true;
        expect(group.heldHumanInputSince).toBe(clock);
        expect(f.store.readEvents(record.id).some(event => event.type === 'text' && event.text === 'Real activity')).toBe(false);
      }
      clear(handle);
    });
    emitAgentEvent({ type: 'text', text: 'Real activity' });
    expect(observed).toBe(true);
    expect(group.heldHumanInputTimer).toBeUndefined();
    expect(group.heldHumanInputSince).toBeUndefined();
    expect(group.heldHumanInputExpired).toBeUndefined();
    expect(f.store.readEvents(record.id).some(event => event.type === 'text' && event.text === 'Real activity')).toBe(true);
    spy.mockRestore();
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

for (const readAt of ['before-ACK', 'after-ACK'] as const) {
  it(`keeps receipt views live when consumption arrives ${readAt}`, async () => {
    const { record, group, input } = await openInputRun();
    const message = input('read this message');
    const ack = deferred<void>();
    sendAck = ack.promise;
    const unread = group.unreadInputIds!;
    const early = group.consumedBeforeAck!;
    f.store.commitAgentInputs(record.id, [message]);
    f.manager.deliverConversationInput(record.id);
    const flight = group.agentInputFlight!;
    if (readAt === 'before-ACK') {
      reportConsumed([message.id]);
      expect(early.has(message.id)).toBe(true);
      expect(f.store.getRun(record.id)?.agentInputs?.[0]?.consumedAt).toBeUndefined();
    }
    ack.resolve(); await flight.settled;
    if (readAt === 'after-ACK') {
      expect(unread.has(message.id)).toBe(true);
      expect(f.store.getRun(record.id)?.agentInputs?.[0]?.awaitingRead).toBe(true);
      reportConsumed([message.id]);
    }
    expect(group.unreadInputIds).toBe(unread);
    expect(group.consumedBeforeAck).toBe(early);
    expect(unread.has(message.id)).toBe(false);
    expect(early.has(message.id)).toBe(false);
    expect(f.store.getRun(record.id)?.agentInputs?.[0]?.consumedAt).toBeDefined();
  });
}

it('keeps unread receipt views unchanged when the requeue checkpoint fails', async () => {
  const { record, group, input } = await openInputRun();
  const message = input('still awaiting a read');
  f.store.commitAgentInputs(record.id, [message]);
  f.manager.deliverConversationInput(record.id);
  await group.agentInputFlight?.settled;
  const unread = group.unreadInputIds!;
  expect(unread.has(message.id)).toBe(true);
  const checkpoint = vi.spyOn(f.store, 'commitOutcome').mockImplementationOnce(() => { throw new Error('requeue disk fault'); });
  emitAgentEvent({ type: 'input-unconsumed', inputIds: [message.id] });
  expect(checkpoint).toHaveBeenCalled();
  expect(group.agentInputError).toBe('agent input requeue checkpoint failed: requeue disk fault');
  expect(unread.has(message.id)).toBe(true);
  expect(f.store.getRun(record.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
  checkpoint.mockRestore();
});


it('retries accepted unread input once before leaving its receipt unconfirmed', async () => {
  const { record, group, input } = await openInputRun();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const message = input('accepted but never read');
    const unread = group.unreadInputIds!;
    f.store.commitAgentInputs(record.id, [message]);
    f.manager.deliverConversationInput(record.id);
    await group.agentInputFlight?.settled;
    emitAgentEvent({ type: 'turn-end' });
    expect(group.unreadInputTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(group.unreadRetried?.has(message.id)).toBe(true);
    expect(unread.has(message.id)).toBe(true);
    expect(group.unreadInputTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(group.unreadInputIds).toBe(unread);
    expect(unread.has(message.id)).toBe(false);
    const receipt = f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === message.id);
    expect(receipt?.deliveredAt).toBeDefined();
    expect(receipt?.awaitingRead).toBeUndefined();
    expect(receipt?.consumedAt).toBeUndefined();
    expect(f.store.readEvents(record.id).some(event => event.type === 'note' && String(event.message).includes('did not confirm'))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('acknowledges claimed inbox input without leaving a provider delivery or an owed wake', async () => {
  const { record, group, input } = await openInputRun();
  const message = { ...input('read through the inbox'), source: 'agent' as const,
    conversation: { senderRunId: randomUUID(), recipientRunId: record.id, kind: 'progress' as const } };
  f.store.commitAgentInputs(record.id, [message]);
  const generation = randomUUID();
  const claim = f.manager.reserveInboxInputs(record.id, generation, [message.id]);
  expect(claim).toBeDefined();
  expect(f.manager.acknowledgeInbox(record.id, generation, claim!.receiptId)).toBe('acknowledged');
  const receipt = f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === message.id);
  expect(receipt?.deliveredAt).toBeDefined();
  expect(receipt?.inboxClaim?.acknowledgedAt).toBe(receipt?.deliveredAt);
  expect(group.agentInputFlight).toBeUndefined();
  expect(group.unreadInputIds?.size).toBe(0);
  expect(f.manager.canClaimInboxInput(record.id, message.id)).toBe(false);
});
