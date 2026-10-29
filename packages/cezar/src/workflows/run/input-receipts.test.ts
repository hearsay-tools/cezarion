import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { projectConversationEvents } from '../../delegation/conversations.ts';
import { RunStore } from '../../runs/store.ts';
import { readPersistedRuns } from '../../runs/run-store.testkit.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun } from '../active-run.ts';
import * as receipts from './input-receipts.ts';
import { recordOpeningAccepted } from './input-receipts.ts';
import type { AgentSession, AgentEvent } from '../../core/agent-runner.ts';
import type { SessionTurn } from './types.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import * as processes from '../../core/process-usage.ts';

let root: string;
let store: RunStore;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-opening-receipt-')); store = RunStore.open(root); });
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); });

function opening() {
  const parent = store.createRun({ title: 'parent', workflow: 'quick-task', task: 'parent', steps: [] });
  const recipient = store.createRun({ title: 'recipient', workflow: 'quick-task', task: 'recipient', steps: [] });
  const message = { id: randomUUID(), senderRunId: parent.id, recipientRunId: recipient.id, kind: 'request' as const,
    text: 'Resume the work', createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' as const, resumed: true as const };
  store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  store.commitConversation(parent.id, { messages: [message], outcomes: [] }, { recipientRunId: recipient.id,
    input: { id: message.id, source: agentInputSchema.shape.source.enum.agent, parentRunId: parent.id, text: message.text, createdAt: message.createdAt,
      conversation: { senderRunId: parent.id, recipientRunId: recipient.id, kind: 'request' } } });
  store.updateRun(recipient.id, { continuationMessage: { id: 'continue-1', agentInputId: message.id,
    text: message.text, createdAt: message.createdAt, origin: 'lifecycle' } });
  store.flush();
  projectConversationEvents(store, store.getRun(parent.id)!);
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  state.openingAgentInputId = message.id;
  const host = { reconcileWorkerWaits: vi.fn(() => projectConversationEvents(store, store.getRun(parent.id)!)),
    flushAgentInputs: vi.fn(), isCurrentState: vi.fn(() => true) };
  const context = { store, repoRoot: root, dataDir: root, semaphore: new WorkspaceSemaphore(), disposed: () => false };
  const saved = () => readPersistedRuns(root).find(run => run.id === recipient.id)!;
  const deliveries = (id: string) => store.readEvents(id).filter(event => event.type === 'conversation-message' && event.delivery === 'delivered');
  return { parent, recipient, state, host, context, saved, deliveries };
}

it('publishes a committed opening receipt once without a live session and retains the replay checkpoint', () => {
  const f = opening();
  expect(f.state.session).toBeUndefined();
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  const saved = f.saved();
  expect(saved.agentInputs?.[0]?.deliveredAt).toBeDefined();
  expect(saved.agentInputs?.[0]?.consumedAt).toBeUndefined();
  expect(saved.continuationMessage?.agentInputId).toBe(f.state.openingAgentInputId);
  for (const id of [f.parent.id, f.recipient.id]) expect(f.deliveries(id))
    .toEqual([expect.objectContaining({ deliveredAt: saved.agentInputs![0]!.deliveredAt })]);
  expect(f.host.reconcileWorkerWaits).toHaveBeenCalledTimes(1);
  expect(store.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { outcomes: [] } });
});

it('does not publish a receipt when its durable commit fails', () => {
  const f = opening();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(store, 'commitOutcome').mockImplementation(() => { throw new Error('receipt commit refused'); });
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeUndefined();
  expect(f.saved().continuationMessage).toBeDefined();
  for (const id of [f.parent.id, f.recipient.id]) expect(f.deliveries(id)).toEqual([]);
  expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
});

it.each(['cancelled', 'stale'] as const)('does not accept an opening receipt from a %s state', mode => {
  const f = opening();
  if (mode === 'cancelled') f.state.cancelled = true;
  else f.host.isCurrentState.mockReturnValue(false);
  recordOpeningAccepted(f.context, f.host, f.recipient.id, f.state);
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeUndefined();
  expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
});

function receiptFixture() {
  const f = opening();
  const session: AgentSession = { result: Promise.resolve({ exitCode: 0, text: '', toolCalls: [], tokensUsed: 0 }), open: true,
    sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages() {},
    holdsHumanInput: () => false, end() {}, interrupt: vi.fn() };
  f.state.session = session;
  f.state.unreadInputIds = new Set([f.state.openingAgentInputId!]);
  const calls: string[] = [];
  const turn: SessionTurn = { text: '', completedText: '', tail: 'none', scheduleWakeup: undefined, sessionError: undefined };
  const steps: receipts.InputReceiptSteps = {
    clearUnread: () => { calls.push('unread'); }, clearHeld: () => { calls.push('held'); },
    noteActivity: () => { calls.push('activity'); }, persistAttachment: vi.fn(() => null),
    ready: vi.fn(), pid: vi.fn(), ui: () => { calls.push('ui'); },
    flushDeferred: () => { calls.push('deferred'); }, recordProcess: () => { calls.push('record'); },
  };
  const id = f.state.openingAgentInputId!;
  const accept = () => store.commitOutcome(f.recipient.id, { kind: 'delivered', inputIds: [id], at: new Date().toISOString(), awaitingRead: true });
  return { ...f, id, session, calls, turn, steps, accept };
}

it.each(['absent', 'stale', 'different'] as const)('rejects consumption and close from a %s session after clearing close timers', mode => {
  const f = receiptFixture(); f.accept();
  const session = mode === 'absent' ? undefined : f.session;
  if (mode === 'stale') f.host.isCurrentState.mockReturnValue(false);
  if (mode === 'different') f.state.session = { ...f.session };
  // Fake time only checks that close cancels both timers; no real-time wait.
  vi.useFakeTimers();
  try {
    f.state.unreadInputTimer = setTimeout(vi.fn(), 10_000);
    f.state.heldHumanInputTimer = setTimeout(vi.fn(), 10_000);
    receipts.handleAgentInputConsumed(f.context, f.host, f.recipient.id, f.state, session, [f.id]);
    receipts.requeueUnreadAtClose(f.context, f.host, f.recipient.id, f.state, session);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.saved().agentInputs?.[0]).toMatchObject({ deliveredAt: expect.any(String) });
    expect(f.saved().agentInputs?.[0]?.consumedAt).toBeUndefined();
    expect(f.state.unreadInputIds).toEqual(new Set([f.id]));
    expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it.each(['cancelled', 'stale', 'empty'] as const)('rejects unread retirement for %s state', mode => {
  const f = receiptFixture(); f.accept();
  if (mode === 'cancelled') f.state.cancelled = true;
  if (mode === 'stale') f.host.isCurrentState.mockReturnValue(false);
  receipts.retireUnreadInputs(f.context, f.host, f.recipient.id, f.state, mode === 'empty' ? [] : [f.id], true);
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeDefined();
  expect(f.state.unreadInputIds).toEqual(new Set([f.id]));
  expect(f.host.flushAgentInputs).not.toHaveBeenCalled();
  expect(store.readEvents(f.recipient.id).filter(e => e.type === 'note')).toEqual([]);
});

it.each([true, false])('routes an image once with its step id when saving succeeds=%s', saved => {
  const f = receiptFixture();
  const attachment = { path: 'image.png', url: '/image.png', mediaType: 'image/png', name: 'image.png' };
  f.steps.persistAttachment = vi.fn(() => saved ? attachment : null);
  const emit = vi.fn();
  expect(receipts.handleReceiptEvent(f.context, f.host, f.steps, f.recipient.id, f.state, f.turn,
    { type: 'image', mediaType: 'image/png', data: 'png' }, 'step-image', emit)).toBe(true);
  expect(f.steps.persistAttachment).toHaveBeenCalledWith(f.recipient.id, 'image/png', 'png');
  expect(emit.mock.calls).toEqual(saved ? [[{ type: 'image', stepId: 'step-image', ...attachment }]] : []);
  expect(f.calls).toEqual([]);
});

it.each([{ type: 'text', text: 'answer\nCEZ:DONE' },
  { type: 'tool-call', id: 'call', tool: 'Read', input: {} }, { type: 'tool-result', toolCallId: 'call', result: 'ok', isError: false }] satisfies AgentEvent[])('orders timer and activity effects for $type', event => {
  const f = receiptFixture();
  f.steps.noteActivity = () => { expect(f.turn.text).toBe(''); f.calls.push('activity'); };
  const emit = vi.fn(() => { expect(f.turn.text).toBe('answer\nCEZ:DONE'); f.calls.push('emit'); });
  const handled = receipts.handleReceiptEvent(f.context, f.host, f.steps, f.recipient.id, f.state, f.turn, event, 'step-text', emit);
  expect(handled).toBe(event.type === 'text');
  expect(f.calls).toEqual(event.type === 'text' ? ['unread', 'held', 'activity', 'emit'] : ['unread', 'held', 'activity']);
  if (event.type === 'text') expect(emit).toHaveBeenCalledWith({ type: 'text', stepId: 'step-text', text: 'answer' });
  else expect(emit).not.toHaveBeenCalled();
});

it.each([true, false])('updates completed text and tail before UI and accepts opening only for continuation=%s', continuation => {
  const f = receiptFixture();
  const sink = {} as UiEventSink;
  observeTurnWrites(f.turn, f.calls);
  f.steps.ui = (_id, _state, _sink, event) => {
    if (event.type === 'item.completed') expect([f.turn.completedText, f.turn.tail]).toEqual(['complete', 'visible']);
    if (event.type === 'turn.started') expect(!!f.saved().agentInputs?.[0]?.deliveredAt).toBe(continuation);
    f.calls.push('ui');
  };
  f.host.reconcileWorkerWaits.mockImplementation(() => { f.calls.push('receipt'); });
  const callbacks = receipts.inputReceiptCallbacks(f.context, f.host, f.steps, f.recipient.id, f.state, () => f.session, f.turn, sink, continuation);
  callbacks.onUiEvent({ type: 'item.completed', item: { id: 'message', kind: 'message', role: 'assistant', text: 'complete' } });
  callbacks.onUiEvent({ type: 'turn.started', turnId: 'turn' });
  expect(f.calls).toEqual(continuation
    ? ['completedText', 'tail', 'ui', 'completedText', 'tail', 'receipt', 'ui']
    : ['completedText', 'tail', 'ui', 'completedText', 'tail', 'ui']);
});

it.each(['consume', 'opening', 'bundled', 'close'] as const)('warns and skips reconciliation after a refused %s checkpoint', operation => {
  const f = receiptFixture();
  if (operation !== 'opening') f.accept();
  f.state.bundledInputIds = [f.id];
  const before = f.saved();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(store, 'commitOutcome').mockImplementation(() => { throw new Error('refused'); });
  const run = () => invokeReceipt(operation, f);
  expect(run).not.toThrow();
  expect(f.saved()).toEqual(before);
  expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
  if (operation === 'bundled' || operation === 'close') expect(f.state.bundledInputIds).toBeUndefined();
});

function invokeReceipt(operation: string, f: ReturnType<typeof receiptFixture>) {
  const args = [f.context, f.host, f.recipient.id, f.state] as const;
  switch (operation) {
    case 'consume': return receipts.handleAgentInputConsumed(...args, f.session, [f.id]);
    case 'opening': return receipts.recordOpeningAccepted(...args);
    case 'bundled': return receipts.readBundledInputs(...args);
    case 'close': return receipts.requeueUnreadAtClose(...args, f.session);
  }
}

it.each(['latched', 'interrupt', 'event'] as const)('preserves durable unread input through retirement failure: %s', failure => {
  const f = receiptFixture(); f.accept();
  vi.spyOn(store, 'commitOutcome').mockImplementation(() => { throw new Error('refused'); });
  const append = vi.spyOn(store, 'appendEvent');
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  if (failure === 'latched') f.state.agentInputError = 'earlier failure';
  if (failure === 'interrupt') vi.mocked(f.session.interrupt).mockImplementation(() => { throw new Error('interrupt refused'); });
  if (failure === 'event') append.mockImplementation(() => { throw new Error('event refused'); });
  const retire = () => receipts.retireUnreadInputs(f.context, f.host, f.recipient.id, f.state, [f.id], true);
  if (failure === 'interrupt') expect(retire).toThrow('interrupt refused');
  else expect(retire).not.toThrow();
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeDefined();
  expect(f.state.unreadInputIds).toEqual(new Set([f.id]));
  expect(f.host.flushAgentInputs).not.toHaveBeenCalled();
  assertRetirementTail(f, failure, append, error);
});

function assertRetirementTail(f: ReturnType<typeof receiptFixture>, failure: string, append: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>) {
  if (failure === 'latched') {
    expect(f.session.interrupt).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    expect(f.state.agentInputError).toBe('earlier failure'); return;
  }
  expect(f.session.interrupt).toHaveBeenCalledOnce();
  expect(append).toHaveBeenCalledWith(f.recipient.id, { type: 'error', message: f.state.agentInputError });
  if (failure === 'event') expect(error).toHaveBeenCalledWith(expect.stringContaining('refused'));
  else expect(store.readEvents(f.recipient.id).at(-1)).toMatchObject({ type: 'error', message: f.state.agentInputError });
}

it('finishes setup in order and waits for ACK before close requeues committed unread input', async () => {
  const f = receiptFixture(); f.accept();
  let release!: () => void;
  const ack = new Promise<void>(resolve => { release = resolve; });
  f.state.agentInputFlight = { session: f.session, inputIds: [f.id], settled: ack };
  const register = vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => { f.calls.push('register'); });
  f.host.flushAgentInputs.mockImplementation(() => { f.calls.push('inputs'); });
  const session = { ...f.session, pid: 12345 }; f.state.session = session;
  const result = receipts.sessionResultWithReceipts(f.context, f.host, f.steps, f.recipient.id, f.state, session, () => { f.calls.push('prepared'); });
  expect(f.calls).toEqual(['deferred', 'inputs', 'register', 'record', 'prepared']);
  expect(register).toHaveBeenCalledWith(f.recipient.id, 12345);
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeDefined();
  release(); await result;
  expect(f.saved().agentInputs?.[0]?.deliveredAt).toBeUndefined();
});

it.each(['deferred', 'inputs', 'register', 'record'] as const)('does not prepare or attach result handling if setup fails at %s', failure => {
  const f = receiptFixture();
  const order = ['deferred', 'inputs', 'register', 'record'];
  const step = (name: string) => { f.calls.push(name); if (name === failure) throw new Error(name); };
  f.steps.flushDeferred = () => step('deferred');
  f.host.flushAgentInputs.mockImplementation(() => step('inputs'));
  vi.spyOn(processes, 'registerRunProcess').mockImplementation(() => step('register'));
  f.steps.recordProcess = () => step('record');
  const result = vi.spyOn(f.session.result, 'finally');
  const prepared = vi.fn();
  expect(() => receipts.sessionResultWithReceipts(f.context, f.host, f.steps, f.recipient.id, f.state, { ...f.session, pid: 12345 }, prepared)).toThrow(failure);
  expect(f.calls).toEqual(order.slice(0, order.indexOf(failure) + 1));
  expect(prepared).not.toHaveBeenCalled(); expect(result).not.toHaveBeenCalled();
});

function observeTurnWrites(turn: SessionTurn, calls: string[]) {
  for (const key of ['completedText', 'tail'] as const) {
    let value = turn[key];
    Object.defineProperty(turn, key, { get: () => value, set: (next: typeof value) => { calls.push(key); value = next; } });
  }
}

it.each(['cancelled', 'empty'] as const)('takes bundled IDs without a commit for %s input', mode => {
  const f = receiptFixture(); f.accept();
  f.state.bundledInputIds = mode === 'empty' ? [] : [f.id];
  f.state.cancelled = mode === 'cancelled';
  const commit = vi.spyOn(store, 'commitOutcome');
  receipts.readBundledInputs(f.context, f.host, f.recipient.id, f.state);
  expect(f.state.bundledInputIds).toBeUndefined();
  expect(commit).not.toHaveBeenCalled();
  expect(f.saved().agentInputs?.[0]?.consumedAt).toBeUndefined();
  expect(f.host.reconcileWorkerWaits).not.toHaveBeenCalled();
});
