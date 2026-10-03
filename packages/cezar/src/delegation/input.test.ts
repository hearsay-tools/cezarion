import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { RunManager } from '../workflows/run.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { enqueueAgentInput, nextAgentInput, agentInputBatch } from './input.ts';

it('bounds batches without splitting messages or crossing lifecycle inputs', () => {
  const make = (text: string): AgentInput => ({ id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text, createdAt: new Date().toISOString(),
    conversation: { senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'progress' } });
  const a = make('a'.repeat(60_000)); const b = make('b'.repeat(60_000)); const c = make('small');
  const lifecycle: AgentInput = { ...make('lifecycle'), source: 'lifecycle', conversation: undefined };
  expect(agentInputBatch([a, b, c], entry => entry.text)?.inputs).toEqual([a]);
  expect(agentInputBatch([b, c], entry => entry.text)?.inputs).toEqual([b, c]);
  expect(agentInputBatch([c, lifecycle, c], entry => entry.text)?.inputs).toEqual([c]);
  expect(agentInputBatch([lifecycle, c], entry => entry.text)?.inputs).toEqual([lifecycle]);
  expect(agentInputBatch([{ ...a, deliveredAt: a.createdAt }, c], entry => entry.text)?.inputs).toEqual([c]);
});

const input: AgentInput = { id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text: '/skill mock:agent-echo steering', createdAt: '2026-09-06T12:00:00.000Z' };
const run = (patch: Partial<RunRecord> = {}): RunRecord => ({ id: randomUUID(), title: 'task', task: 'task', workflow: 'quick-task', status: 'running', createdAt: input.createdAt, tokensUsed: 0, archived: false, steps: [], ...patch });

describe('attributed input queue', () => {
  it('never selects input while a human ask is pending', () => {
    expect(nextAgentInput([input], true)).toBeUndefined();
    expect(nextAgentInput([input], false)).toEqual(input);
  });
  it('selects the first undelivered input without mutating history', () => {
    const delivered = { ...input, deliveredAt: input.createdAt };
    expect(nextAgentInput([delivered, input], false)).toEqual(input);
    expect(nextAgentInput([delivered], false)).toBeUndefined();
  });
  it('caps undelivered input at 32, not total history', () => {
    const queue = Array.from({ length: 32 }, () => ({ ...input, id: randomUUID() }));
    expect(() => enqueueAgentInput(run({ agentInputs: queue }), input)).toThrow(/capacity/i);
    const record = run({ agentInputs: queue.map(entry => ({ ...entry, deliveredAt: input.createdAt })) });
    expect(enqueueAgentInput(record, input)).toHaveLength(33);
    expect(record.agentInputs).toHaveLength(32);
    expect(enqueueAgentInput(run({ agentInputs: queue.slice(1) }), input)).toHaveLength(32);
  });
  it.each(['review', 'done', 'failed', 'cancelled'] as const)('rejects terminal %s without reopening', status => {
    expect(() => enqueueAgentInput(run({ status }), input)).toThrow(/state/i);
  });
  it('rejects invalid input and pre-delivered input', () => {
    expect(() => enqueueAgentInput(run(), { ...input, text: '' })).toThrow();
    expect(() => enqueueAgentInput(run(), { ...input, deliveredAt: input.createdAt })).toThrow();
  });
  it('commits queue atomically and exposes no mutation or event on write failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-agent-input-'));
    const store = RunStore.open(dir);
    try {
      const record = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
      store.flush();
      mkdirSync(join(dir, 'runs.json.tmp'));
      const events: unknown[] = [];
      store.on('run', event => events.push(event));
      expect(() => store.commitAgentInputs(record.id, [input])).toThrow();
      expect(record.agentInputs).toBeUndefined();
      expect(events).toEqual([]);
      rmSync(join(dir, 'runs.json.tmp'), { recursive: true });
      store.commitAgentInputs(record.id, [input]);
      expect(record.agentInputs).toEqual([input]);
      expect(RunStore.open(dir, { keepLive: true }).getRun(record.id)?.agentInputs).toEqual([input]);
    } finally { store.flush(); rmSync(dir, { recursive: true, force: true }); }
  });
});


it('readiness hints ignore stale/disposed sessions and guard duplicate/reentrant drains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-input-ready-'));
  const store = RunStore.open(dir);
  const manager = new RunManager(store, dir);
  const internal = manager as unknown as {
    active: Map<string, object>;
    handleAgentInputReady(id: string, state: object, session: AgentSession | undefined): void;
  };
  try {
    const record = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    store.commitAgentInputs(record.id, [input]);
    let sends = 0;
    // Deterministic local session only for callback identity/reentrancy, not
    // vendor behavior (the full four-runner parity suite covers that separately).
    const session: AgentSession = {
      open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: () => { throw new Error('non-human input used human seam'); },
      discardQueuedMessages: () => {},
      sendAgentMessage: () => {
        sends++;
        if (sends < 2) internal.handleAgentInputReady(record.id, state, session);
        return Promise.resolve();
      },
      end: () => {}, interrupt: () => {},
    };
    const state = { session, pendingHumanAsk: true, cancelled: false };
    internal.active.set(record.id, state);
    internal.handleAgentInputReady(record.id, state, undefined); // Synchronous startup hint before session assignment.
    expect(sends).toBe(0);
    internal.handleAgentInputReady(record.id, state, session);
    expect(sends).toBe(0);
    state.pendingHumanAsk = false;
    internal.handleAgentInputReady(record.id, state, { ...session });
    expect(sends).toBe(0);
    internal.handleAgentInputReady(record.id, state, session);
    internal.handleAgentInputReady(record.id, state, session);
    expect(sends).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getRun(record.id)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
    store.commitAgentInputs(record.id, [{ ...input, id: randomUUID() }]);
    internal.active.set(record.id, { ...state });
    internal.handleAgentInputReady(record.id, state, session);
    expect(sends).toBe(1);
    internal.active.set(record.id, state);
    manager.dispose();
    internal.handleAgentInputReady(record.id, state, session);
    expect(sends).toBe(1);
  } finally { manager.dispose(); store.flush(); rmSync(dir, { recursive: true, force: true }); }
});

it('ask replay requires a validated successful-delivery checkpoint for the current ask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-ask-checkpoint-'));
  const store = RunStore.open(dir);
  const manager = new RunManager(store, dir);
  const replay = manager as unknown as { hasPendingHumanAsk(id: string): boolean };
  try {
    const record = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    const ask = { type: 'ask.requested', requestId: 'question', questions: [{
      header: 'Library', question: 'Which library?', options: [{ label: 'Vitest' }, { label: 'Node' }],
    }] };
    const first = store.appendEvent(record.id, ask);
    store.appendEvent(record.id, { type: 'user-message', text: 'legacy or refused attempt', imageCount: 1 });
    expect(replay.hasPendingHumanAsk(record.id)).toBe(true);
    store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: String(first.seq) });
    expect(replay.hasPendingHumanAsk(record.id)).toBe(true);
    const second = store.appendEvent(record.id, { ...ask, requestId: 'next-question' });
    store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: first.seq });
    expect(replay.hasPendingHumanAsk(record.id)).toBe(true);
    store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: second.seq });
    expect(replay.hasPendingHumanAsk(record.id)).toBe(false);
  } finally { manager.dispose(); store.flush(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(['cancelled', 'finish requested', 'disposed', 'replacement session', 'replacement state'] as const)(
  'a late transport ACK has no authority after %s', async transition => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-input-stale-ack-'));
    const store = RunStore.open(dir), manager = new RunManager(store, dir);
    const internal = manager as unknown as {
      active: Map<string, object>;
      handleAgentInputReady(id: string, state: object, session: AgentSession | undefined): void;
    };
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: () => false, sendAgentMessage: () => ack, discardQueuedMessages() {}, end() {}, interrupt() {} };
    const state = { session, pendingHumanAsk: false, cancelled: false, finishRequested: false,
      agentInputFlight: undefined as { settled?: Promise<void> } | undefined };
    try {
      const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
      store.commitAgentInputs(run.id, [input]);
      internal.active.set(run.id, state);
      internal.handleAgentInputReady(run.id, state, session);
      const settled = state.agentInputFlight?.settled;
      expect(settled).toBeInstanceOf(Promise);
      expect(store.getRun(run.id)?.agentInputs).toEqual([input]);
      if (transition === 'cancelled') state.cancelled = true;
      if (transition === 'finish requested') state.finishRequested = true;
      if (transition === 'disposed') manager.dispose();
      if (transition === 'replacement session') state.session = { ...session };
      if (transition === 'replacement state') internal.active.set(run.id, { ...state });
      const before = JSON.stringify(store.getRun(run.id));
      acknowledge(); await settled;
      expect(JSON.stringify(store.getRun(run.id))).toBe(before);
      expect(store.getRun(run.id)?.agentInputs).toEqual([input]);
    } finally { manager.dispose(); store.flush(); rmSync(dir, { recursive: true, force: true }); }
  },
);

it('ACK cannot answer a newly visible human ask or drain its queued successor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-input-ack-ask-'));
  const store = RunStore.open(dir), manager = new RunManager(store, dir);
  const internal = manager as unknown as {
    active: Map<string, object>;
    handleAgentInputReady(id: string, state: object, session: AgentSession): void;
    hasPendingHumanAsk(id: string): boolean;
  };
  let acknowledge!: () => void, sends = 0;
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: () => { throw new Error('ACK used human seam'); },
    sendAgentMessage: () => { sends++; return ack; }, discardQueuedMessages() {}, end() {}, interrupt() {} };
  const state = { session, pendingHumanAsk: false, cancelled: false,
    agentInputFlight: undefined as { settled?: Promise<void> } | undefined };
  try {
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    store.commitAgentInputs(run.id, [input]); internal.active.set(run.id, state);
    internal.handleAgentInputReady(run.id, state, session);
    const settled = state.agentInputFlight?.settled;
    const second = { ...input, id: randomUUID() };
    store.commitAgentInputs(run.id, [input, second]);
    store.appendEvent(run.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Choose?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    state.pendingHumanAsk = true;
    acknowledge(); await settled;
    expect(store.getRun(run.id)?.agentInputs).toEqual([{ ...input, deliveredAt: expect.any(String) }, second]);
    expect(sends).toBe(1); expect(internal.hasPendingHumanAsk(run.id)).toBe(true);
    expect(store.readEvents(run.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  } finally { manager.dispose(); store.flush(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(['accepted', 'rejected'] as const)('%s ACK settles before a later provider-close frame in the same read batch', async outcome => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-input-ack-provider-'));
  const store = RunStore.open(dir), manager = new RunManager(store, dir);
  const internal = manager as unknown as { active: Map<string, object>;
    handleAgentInputReady(id: string, state: object, session: AgentSession): void };
  let open = true;
  const session: AgentSession = { get open() { return open; }, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: () => false, sendAgentMessage: () => outcome === 'accepted' ? Promise.resolve() : Promise.reject(new Error('command rejected')),
    discardQueuedMessages() {}, end() { open = false; }, interrupt() { open = false; } };
  const state = { session, pendingHumanAsk: false, cancelled: false, agentSessionError: undefined as string | undefined,
    agentInputFlight: undefined as { settled?: Promise<void> } | undefined };
  try {
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    store.commitAgentInputs(run.id, [input]); internal.active.set(run.id, state);
    internal.handleAgentInputReady(run.id, state, session);
    const settled = state.agentInputFlight?.settled;
    expect(settled).toBeInstanceOf(Promise);
    // The RPC dispatcher has settled the exact command Promise; another frame
    // can synchronously close the session before Promise callbacks get a turn.
    state.agentSessionError = 'later provider failure'; session.interrupt();
    await settled;
    expect(store.getRun(run.id)?.agentInputs).toEqual(outcome === 'accepted' ? [{ ...input, deliveredAt: expect.any(String) }] : [input]);
    expect(state.agentSessionError).toBe('later provider failure'); expect(session.open).toBe(false);
  } finally { manager.dispose(); store.flush(); rmSync(dir, { recursive: true, force: true }); }
});


it('a live inbox claim is a FIFO barrier; expiry restores the original conversation batch', () => {
  const now = Date.now();
  const make = (text: string): AgentInput => ({ ...input, id: randomUUID(), text,
    conversation: { senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'progress' } });
  const first = make('first'), second = make('claimed'), third = make('third');
  const claim = { receiptId: randomUUID(), generation: randomUUID(), expiresAt: new Date(now + 120_000).toISOString(), memberIds: [second.id] };
  const queue = [first, { ...second, inboxClaim: claim }, third];
  expect(agentInputBatch(queue, entry => entry.text, now)?.inputs.map(entry => entry.id)).toEqual([first.id]);
  expect(agentInputBatch(queue.slice(1), entry => entry.text, now)).toBeUndefined();
  expect(agentInputBatch(queue, entry => entry.text, now + 120_000)?.inputs.map(entry => entry.id)).toEqual([first.id, second.id, third.id]);
});

async function withInboxRun(check: (f: { store: RunStore; manager: RunManager; dir: string; runId: string;
  enqueue: (text: string) => AgentInput; state: { session: AgentSession; pendingHumanAsk: boolean; cancelled: boolean; openingAgentInputId?: string };
  sent: string[] }) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-inbox-arbitration-'));
  const store = RunStore.open(dir, { keepLive: true }), manager = new RunManager(store, dir);
  const sent: string[] = [];
  const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: () => { throw Error('used human input seam'); },
    sendAgentMessage: content => { sent.push(JSON.stringify(content)); return Promise.resolve(); }, discardQueuedMessages() {}, end() {}, interrupt() {} };
  const state = { session, pendingHumanAsk: false, cancelled: false };
  const record = store.createRun({ title: 'inbox', task: 'inbox', workflow: 'quick-task', steps: [] });
  store.updateRun(record.id, { status: 'running' });
  store.commitDelegation([{ id: record.id, delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages: [], outcomes: [] } } }]);
  (manager as unknown as { active: Map<string, object> }).active.set(record.id, state);
  const enqueue = (text: string) => {
    const entry: AgentInput = { ...input, id: randomUUID(), text, parentRunId: record.id,
      conversation: { senderRunId: randomUUID(), recipientRunId: record.id, kind: 'request' } };
    store.commitAgentInputs(record.id, [...(store.getRun(record.id)?.agentInputs ?? []), entry]);
    return entry;
  };
  try { await check({ store, manager, dir, runId: record.id, enqueue, state, sent }); }
  finally { manager.dispose(); store.flush(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
}

it('inbox-first reservation prevents provider delivery and ACK covers only exact members', async () => {
  await withInboxRun(async ({ store, manager, runId, enqueue, sent }) => {
    const first = enqueue('first'), second = enqueue('second'); const generation = randomUUID();
    const receipt = manager.reserveInboxInputs(runId, generation, [first.id, second.id])!;
    expect(receipt.inputIds).toEqual([first.id, second.id]);
    expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim?.memberIds).toEqual([first.id, second.id]);
    const third = enqueue('third');
    expect(manager.canClaimInboxInput(runId, third.id)).toBe(true);
    expect(manager.reserveInboxInputs(runId, generation, [third.id])).toBeUndefined();
    manager.deliverConversationInput(runId);
    expect(sent).toEqual([]);
    expect(() => manager.acknowledgeInbox(runId, randomUUID(), receipt.receiptId)).toThrow();
    expect(manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toBe('acknowledged');
    expect(manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toBe('already-acknowledged');
    expect(store.getRun(runId)?.agentInputs?.filter(entry => entry.deliveredAt).map(entry => entry.id)).toEqual([first.id, second.id]);
    expect(sent).toHaveLength(1); expect(sent[0]).toContain(third.id);
    expect(sent[0]).not.toContain(first.id); expect(sent[0]).not.toContain(second.id);
    await Promise.resolve();
  });
});

it.each(['active', 'durable'] as const)('inbox cannot reserve an input in the %s opening Continue prompt', async mode => {
  await withInboxRun(({ store, manager, runId, enqueue, state }) => {
    const first = enqueue('opening'), later = enqueue('later');
    if (mode === 'active') state.openingAgentInputId = first.id;
    else store.updateRun(runId, { continuationMessage: { id: randomUUID(), createdAt: first.createdAt, text: first.text, agentInputId: first.id, origin: 'lifecycle' } });
    expect(manager.canClaimInboxInput(runId, first.id)).toBe(false);
    expect(manager.canClaimInboxInput(runId, later.id)).toBe(true);
    expect(manager.reserveInboxInputs(runId, randomUUID(), [first.id])).toBeUndefined();
  });
});

it('failed claim and ACK checkpoints publish nothing and the same receipt can retry', async () => {
  await withInboxRun(({ store, manager, dir, runId, enqueue }) => {
    const first = enqueue('first'), generation = randomUUID(); store.flush();
    mkdirSync(join(dir, 'runs.json.tmp'));
    expect(() => manager.reserveInboxInputs(runId, generation, [first.id])).toThrow();
    expect(store.getRun(runId)?.agentInputs).toEqual([first]);
    rmSync(join(dir, 'runs.json.tmp'), { recursive: true });
    const receipt = manager.reserveInboxInputs(runId, generation, [first.id])!;
    mkdirSync(join(dir, 'runs.json.tmp'));
    expect(() => manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toThrow();
    expect(store.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
    rmSync(join(dir, 'runs.json.tmp'), { recursive: true });
    expect(manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toBe('acknowledged');
  });
});

it.each(['release', 'expiry'] as const)('%s resumes normal delivery without another turn and refuses stale ACK', async mode => {
  await withInboxRun(async ({ store, manager, runId, enqueue, sent }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const first = enqueue('first'), generation = randomUUID();
    const receipt = manager.reserveInboxInputs(runId, generation, [first.id])!;
    manager.deliverConversationInput(runId); expect(sent).toEqual([]);
    if (mode === 'release') expect(manager.releaseInbox(runId, generation, receipt.receiptId)).toBe('released');
    else { await vi.advanceTimersByTimeAsync(119_999); expect(sent).toEqual([]); await vi.advanceTimersByTimeAsync(1); }
    expect(sent).toHaveLength(1); expect(sent[0]).toContain(first.id);
    expect(() => manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toThrow();
    expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim).toBeUndefined();
  });
});

it.each(['live', 'expired'] as const)('restart recovers a %s receipt and expiry permits queued delivery', async mode => {
  await withInboxRun(async ({ store, manager, dir, runId, enqueue }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const first = enqueue('recovered input'), generation = randomUUID();
    const receipt = manager.reserveInboxInputs(runId, generation, [first.id])!;
    store.updateRun(runId, { status: 'waiting' }); store.flush(); manager.dispose();
    vi.setSystemTime(Date.now() + (mode === 'live' ? 60_000 : 120_001));
    const reopened = RunStore.open(dir, { keepLive: true }), recovered = new RunManager(reopened, dir);
    // Hold scheduler admission while observing the real durable wake produced by expiry.
    const pump = vi.spyOn(recovered as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    try {
      await recovered.recover();
      if (mode === 'live') {
        expect(reopened.getRun(runId)?.agentInputs?.[0]?.inboxClaim?.receiptId).toBe(receipt.receiptId);
        expect(reopened.getRun(runId)?.delegation).not.toHaveProperty('wait');
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(reopened.getRun(runId)?.agentInputs?.[0]?.inboxClaim).toBeUndefined();
      expect(reopened.getRun(runId)?.delegation).toMatchObject({ wait: { reason: 'message', wakeId: first.id } });
      expect(reopened.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
      expect(() => recovered.acknowledgeInbox(runId, generation, receipt.receiptId)).toThrow();
    } finally { recovered.dispose(); reopened.flush(); pump.mockRestore(); }
  });
});


it.each([1, 32])('a full reply queue with %i claimed inputs defers lifecycle admission without losing messages', async count => {
  await withInboxRun(({ store, manager, runId, enqueue }) => {
    const requestId = randomUUID(), waitId = randomUUID(), generation = randomUUID();
    const inputs = Array.from({ length: 32 }, () => {
      const entry = enqueue('reply'); return { ...entry, conversation: { ...entry.conversation!, kind: 'reply' as const, requestId } };
    });
    store.commitAgentInputs(runId, inputs);
    const receipt = manager.reserveInboxInputs(runId, generation, inputs.slice(0, count).map(entry => entry.id))!;
    store.commitDelegation([{ id: runId, delegation: { role: 'root', permissions: [], receipts: [],
      wait: { id: waitId, workerIds: [], requestIds: [requestId], outcomes: [], deadline: new Date().toISOString(),
        phase: 'wake-pending', reason: 'outcome', wakeId: waitId } } }]);
    expect(() => manager.reconcileWorkerWaits()).not.toThrow();
    expect(store.getRun(runId)?.agentInputs?.map(entry => entry.id)).toEqual(inputs.map(entry => entry.id));
    expect(store.getRun(runId)?.agentInputs?.filter(entry => entry.inboxClaim?.receiptId === receipt.receiptId)).toHaveLength(count);
    expect(manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toBe('acknowledged');
    expect(store.getRun(runId)?.agentInputs?.filter(entry => entry.deliveredAt)).toHaveLength(count);
  });
});

it('disposed managers cannot expire or deliver their durable claims', async () => {
  await withInboxRun(async ({ store, manager, runId, enqueue, sent }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const first = enqueue('first'); const receipt = manager.reserveInboxInputs(runId, randomUUID(), [first.id])!;
    manager.dispose(); await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
    expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim?.receiptId).toBe(receipt.receiptId);
    expect(store.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
  });
});


it('expiry retries a failed checkpoint without delivering or losing the durable receipt', async () => {
  await withInboxRun(async ({ store, manager, dir, runId, enqueue, sent }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const first = enqueue('first'); const receipt = manager.reserveInboxInputs(runId, randomUUID(), [first.id])!;
    await vi.advanceTimersByTimeAsync(119_999);
    mkdirSync(join(dir, 'runs.json.tmp'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([]);
      expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim?.receiptId).toBe(receipt.receiptId);
      rmSync(join(dir, 'runs.json.tmp'), { recursive: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(1); expect(sent[0]).toContain(first.id);
      expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim).toBeUndefined();
    } finally { warning.mockRestore(); rmSync(join(dir, 'runs.json.tmp'), { recursive: true, force: true }); }
  });
});

it('restart after durable inbox ACK retires the wake without creating a continuation', async () => {
  await withInboxRun(async ({ store, manager, dir, runId, enqueue }) => {
    const first = enqueue('already consumed'), generation = randomUUID(), receiptId = randomUUID();
    store.claimInboxInputs(runId, [first.id], { receiptId, generation, expiresAt: new Date(Date.now() + 120_000).toISOString() });
    store.commitDelegation([{ id: runId, delegation: { role: 'root', permissions: [], receipts: [],
      wait: { id: randomUUID(), workerIds: [], outcomes: [], deadline: new Date().toISOString(), phase: 'wake-pending', reason: 'message', wakeId: first.id } } }]);
    store.updateRun(runId, { status: 'waiting' });
    // Simulate the crash boundary after the atomic ACK and before manager reconciliation.
    store.ackInboxInputs(runId, receiptId, generation, new Date().toISOString());
    manager.dispose(); store.flush();
    const reopened = RunStore.open(dir, { keepLive: true }), recovered = new RunManager(reopened, dir);
    const pump = vi.spyOn(recovered as unknown as { pump(): Promise<void> }, 'pump').mockResolvedValue();
    try {
      await recovered.recover();
      expect(reopened.getRun(runId)?.delegation).not.toHaveProperty('wait');
      expect(reopened.getRun(runId)?.continuationMessage).toBeUndefined();
      expect(reopened.getRun(runId)?.status).toBe('waiting');
      expect(recovered.acknowledgeInbox(runId, generation, receiptId)).toBe('already-acknowledged');
    } finally { recovered.dispose(); reopened.flush(); pump.mockRestore(); }
  });
});
