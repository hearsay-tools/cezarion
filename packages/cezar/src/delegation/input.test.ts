import { testHome } from '../home/test-home.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { createActiveRun } from '../workflows/active-run.ts';
import { InputDelivery } from '../workflows/run/input-delivery.ts';
import { execFileSync } from 'node:child_process';
import * as runners from '../core/runner-factory.ts';
import type { RunnerFactory } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { TrackedWork } from '../workflows/run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { plannedWorkflow } from '../workflows/types.ts';
import type { AgentEvent, AgentRunResult, SessionOptions } from '../core/agent-runner.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunManager } from '../workflows/run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { enqueueAgentInput, nextAgentInput, agentInputBatch } from './input.ts';
import { setRunStatus, blockRunWrites } from '../runs/run-store.testkit.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

/** Read at call time, so a test's `vi.spyOn(runners, 'createRunner')` reaches managers built before it. */
const spiedRunners: RunnerFactory = (backend, options) => runners.createRunner(backend, options);

it('bounds batches without splitting messages or crossing lifecycle inputs', () => {
  const make = (text: string): AgentInput => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: randomUUID(), text, createdAt: new Date().toISOString(),
    conversation: { senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'progress' } });
  const a = make('a'.repeat(60_000)); const b = make('b'.repeat(60_000)); const c = make('small');
  const lifecycle: AgentInput = { ...make('lifecycle'), source: 'lifecycle', conversation: undefined };
  expect(agentInputBatch([a, b, c], entry => entry.text)?.inputs).toEqual([a]);
  expect(agentInputBatch([b, c], entry => entry.text)?.inputs).toEqual([b, c]);
  expect(agentInputBatch([c, lifecycle, c], entry => entry.text)?.inputs).toEqual([c]);
  expect(agentInputBatch([lifecycle, c], entry => entry.text)?.inputs).toEqual([lifecycle]);
  expect(agentInputBatch([{ ...a, deliveredAt: a.createdAt }, c], entry => entry.text)?.inputs).toEqual([c]);
});

const input: AgentInput = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: randomUUID(), text: '/skill mock:agent-echo steering', createdAt: '2026-09-06T12:00:00.000Z' };
const run = (patch: Partial<RunRecord> = {}): RunRecord => ({ id: randomUUID(), title: 'task', task: 'task', workflow: 'quick-task', status: RUN_STATUS.running, createdAt: input.createdAt, tokensUsed: 0, archived: false, steps: [], ...patch });

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
      const release = blockRunWrites(dir);
      const events: unknown[] = [];
      store.on('run', event => events.push(event));
      expect(() => store.commitAgentInputs(record.id, [input])).toThrow();
      expect(record.agentInputs).toBeUndefined();
      expect(events).toEqual([]);
      release();
      store.commitAgentInputs(record.id, [input]);
      expect(record.agentInputs).toEqual([input]);
      expect(RunStore.open(dir, { keepLive: true }).getRun(record.id)?.agentInputs).toEqual([input]);
    } finally { store.flush(); rmSync(dir, { recursive: true, force: true }); }
  });
});


type LiveInputRun = {
  store: RunStore; manager: RunManager; dir: string; runId: string; work: TrackedWork;
  session: AgentSession; options: SessionOptions; emit: (event: AgentEvent) => void;
  send: ReturnType<typeof vi.fn<(content: Parameters<AgentSession['sendAgentMessage']>[0]) => false | Promise<void>>>;
  human: ReturnType<typeof vi.fn<AgentSession['sendMessage']>>;
  close(): void; onCleanup(callback: () => void): void;
};

/** The fixture owns the runner and its transport gates; RunManager owns all lifecycle wiring. */
async function withLiveInputRun(check: (fixture: LiveInputRun) => Promise<void> | void, opening?: AgentInput): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cez-input-live-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
  const store = RunStore.open(dir, { keepLive: true }), work = new TrackedWork();
  const manager = new RunManager(store, dir, { acquireCiResources: acquireInertCiResources, createRunner: spiedRunners, home: testHome(), work });
  let terminate!: (result: AgentRunResult) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let options: SessionOptions = {};
  let emit: (event: AgentEvent) => void = () => {};
  let open = true;
  const send = vi.fn<(content: Parameters<AgentSession['sendAgentMessage']>[0]) => false | Promise<void>>(() => Promise.resolve());
  const human = vi.fn<AgentSession['sendMessage']>(() => true);
  const result = new Promise<AgentRunResult>(resolve => { terminate = resolve; });
  const session: AgentSession = { get open() { return open; }, result, sendAgentMessage: send,
    sendMessage: human, discardQueuedMessages() {}, holdsHumanInput: () => false,
    end() { open = false; }, interrupt() { open = false; } };
  const runner = vi.spyOn(runners, 'createRunner').mockImplementation(() => ({
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    interrupt: async () => undefined,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (_spec, onEvent, opts) => {
      emit = event => onEvent?.(event); options = opts ?? {};
      options.onAgentInputReady?.(); // Startup readiness precedes assignment of the session.
      started(); return session;
    },
  }));
  const cleanups: Array<() => void> = [];
  const close = () => { open = false; terminate({ text: '', toolCalls: [], tokensUsed: 0 }); };
  const workflow = plannedWorkflow([{ id: 'work', prompt: '{{task}}' }]);
  const record = opening
    ? store.createRun({ title: 'opening', task: 'opening', workflow: workflow.name,
      steps: [{ id: 'work', name: 'work', kind: STEP_KIND.agent }] })
    : manager.startRun(workflow, { task: 'test input transport', worktree: false, runner: 'claude' });
  if (opening) {
    setRunStatus(store, record.id, RUN_STATUS.review, { workflowDef: workflow });
    store.updateStep(record.id, 'work', { status: STEP_STATUS.done, sessionId: 'previous-session' });
    store.commitAgentInputs(record.id, [opening]);
    expect(manager.continueRun(record.id, { text: opening.text, answerInputId: opening.id })).toEqual({ ok: true });
  }
  try {
    await ready;
    await check({ store, manager, dir, runId: record.id, work, session, options, emit, send, human, close, onCleanup: callback => cleanups.push(callback) });
  } finally {
    manager.cancel(record.id); for (const cleanup of cleanups) cleanup(); close(); manager.dispose();
    while (work.pending.size) await Promise.allSettled([...work.pending.keys()]);
    runner.mockRestore(); store.close(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve on the store's delivery checkpoint, without inspecting a live flight. */
function inputDelivered(store: RunStore, runId: string, id: string): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      if (!store.getRun(runId)?.agentInputs?.find(entry => entry.id === id)?.deliveredAt) return;
      store.off('run', check); resolve();
    };
    store.on('run', check); check();
  });
}

it('readiness hints guard startup, human asks, duplicate and reentrant drains, and disposal', async () => {
  await withLiveInputRun(async ({ store, manager, runId, options, send, human }) => {
    expect(send).not.toHaveBeenCalled();
    options.onUiEvent?.({ type: 'ask.requested', requestId: 'choice', questions: [{
      header: 'Choice', question: 'Choose?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    store.commitAgentInputs(runId, [input]);
    options.onAgentInputReady?.();
    expect(send).not.toHaveBeenCalled();
    send.mockReturnValue(false);
    expect(manager.sendMessage(runId, [{ type: 'text', text: 'One' }])).toBe(true);
    expect(human).toHaveBeenCalledOnce();
    // The public human answer may bundle the input it answers beside. A fresh input
    // then proves readiness drains exactly once after that answer.
    const next = { ...input, id: randomUUID() };
    store.commitAgentInputs(runId, [...(store.getRun(runId)?.agentInputs ?? []), next]);
    send.mockClear();
    const ack = Promise.resolve();
    const delivered = inputDelivered(store, runId, next.id);
    send.mockImplementation(() => { options.onAgentInputReady?.(); return ack; });
    options.onAgentInputReady?.(); options.onAgentInputReady?.();
    expect(send).toHaveBeenCalledOnce();
    await delivered;
    expect(store.getRun(runId)?.agentInputs?.find(entry => entry.id === next.id)?.deliveredAt).toBeDefined();
    manager.dispose();
    const before = send.mock.calls.length;
    const afterDisposal = { ...input, id: randomUUID() };
    store.commitAgentInputs(runId, [afterDisposal]); options.onAgentInputReady?.();
    expect(send).toHaveBeenCalledTimes(before);
    expect(store.getRun(runId)?.agentInputs).toEqual([afterDisposal]);
  });
});

/** A read outside the small policy case's declared collaborators is a test failure. */
function unused<T extends object>(members: Partial<T> = {}): T {
  return new Proxy<T>(Object.create(null), { get(_target, key) {
    if (Object.hasOwn(members, key)) return Reflect.get(members, key);
    throw new Error(`unused InputDelivery collaborator: ${String(key)}`);
  } });
}
type DeliveryHost = ConstructorParameters<typeof InputDelivery>[1];

it('readiness rejects a replaced state independently of the session identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-input-state-ready-'));
  const store = RunStore.open(dir);
  const old = createActiveRun({ cwd: dir, pendingHumanAsk: false, autonomous: false });
  const replacement = createActiveRun({ cwd: dir, pendingHumanAsk: false, autonomous: false });
  const send = vi.fn(() => Promise.resolve());
  const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendAgentMessage: send, sendMessage: () => false, discardQueuedMessages() {}, holdsHumanInput: () => false, end() {}, interrupt() {} };
  old.liveSession.attachSession(session); replacement.liveSession.attachSession(session);
  const record = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
  const host = unused<DeliveryHost>({ active: new Map([[record.id, replacement]]) });
  const owner = new InputDelivery({ createRunner: noRunners, home: testHome(), store, repoRoot: dir, dataDir: dir, semaphore: new WorkspaceSemaphore({ home: testHome() }),
    work: new TrackedWork(), disposed: () => false }, host, 10, 'unused');
  try {
    const before = JSON.stringify(store.getRun(record.id));
    owner.handleAgentInputReady(record.id, old, session);
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getRun(record.id))).toBe(before);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('ask replay requires a validated successful-delivery checkpoint for the current ask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-ask-checkpoint-'));
  const store = RunStore.open(dir);
  const manager = new RunManager(store, dir, { acquireCiResources: acquireInertCiResources, createRunner: spiedRunners, home: testHome() });
  const pendingAsk = () => store.transcriptFacts(recordId).pendingGateSeq !== undefined;
  let recordId: string;
  try {
    const record = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    recordId = record.id;
    const ask = { type: 'ask.requested', requestId: 'question', questions: [{
      header: 'Library', question: 'Which library?', options: [{ label: 'Vitest' }, { label: 'Node' }],
    }] };
    const first = store.appendEvent(record.id, ask);
    store.appendEvent(record.id, { type: 'user-message', text: 'legacy or refused attempt', imageCount: 1 });
    expect(pendingAsk()).toBe(true);
    store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: String(first.seq) });
    expect(pendingAsk()).toBe(true);
    const second = store.appendEvent(record.id, { ...ask, requestId: 'next-question' });
    store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: first.seq });
    expect(pendingAsk()).toBe(true);
    store.appendEvent(record.id, { type: 'human-input-delivered', askSeq: second.seq });
    expect(pendingAsk()).toBe(false);
  } finally { manager.dispose(); store.flush(); rmSync(dir, { recursive: true, force: true }); }
});

it.each(['cancelled', 'finish requested', 'disposed'] as const)(
  'a late transport ACK has no authority after %s', async transition => {
    await withLiveInputRun(async ({ store, manager, runId, send, options, onCleanup }) => {
      let acknowledge!: () => void;
      const ack = new Promise<void>(resolve => { acknowledge = resolve; });
      onCleanup(() => acknowledge());
      const chain = vi.spyOn(ack, 'then');
      send.mockReturnValue(ack);
      store.commitAgentInputs(runId, [input]); options.onAgentInputReady?.();
      const settled = chain.mock.results[0]?.value;
      expect(settled).toBeInstanceOf(Promise);
      expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      if (transition === 'cancelled') manager.cancel(runId);
      if (transition === 'finish requested') manager.finish(runId);
      if (transition === 'disposed') manager.dispose();
      const before = JSON.stringify(store.getRun(runId));
      acknowledge(); await settled;
      expect(JSON.stringify(store.getRun(runId))).toBe(before);
      expect(store.getRun(runId)?.agentInputs).toEqual([input]);
    });
  },
);

it.each(['replacement session', 'replacement state'] as const)(
  'a late transport ACK has no authority after %s', async transition => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-input-replaced-ack-'));
    const store = RunStore.open(dir);
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: () => false, sendAgentMessage: () => ack, discardQueuedMessages() {}, holdsHumanInput: () => false, end() {}, interrupt() {} };
    const state = createActiveRun({ cwd: dir, pendingHumanAsk: false, autonomous: false });
    state.liveSession.attachSession(session);
    const record = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [] });
    setRunStatus(store, record.id, RUN_STATUS.running); store.commitAgentInputs(record.id, [input]);
    const active = new Map([[record.id, state]]), move = vi.fn();
    const owner = new InputDelivery({ createRunner: noRunners, home: testHome(), store, repoRoot: dir, dataDir: dir, semaphore: new WorkspaceSemaphore({ home: testHome() }),
      work: new TrackedWork(), disposed: () => false }, unused<DeliveryHost>({
      active, move, owesWake: () => false,
      line: unused<DeliveryHost['line']>({ isAdmitted: () => false, unpark: vi.fn() }),
      workerExecutions: unused<DeliveryHost['workerExecutions']>({ trackDelivery: vi.fn() }),
    }), 10, 'unused');
    try {
      expect(owner.submitAgentInput(record.id, state, [{ type: 'text', text: input.text }], [input.id])).toBe(true);
      const settled = state.inputState.agentInputFlight?.settled;
      expect(settled).toBeInstanceOf(Promise);
      if (transition === 'replacement session') state.liveSession.attachSession({ ...session });
      else {
        const replacement = createActiveRun({ cwd: dir, pendingHumanAsk: false, autonomous: false });
        replacement.liveSession.attachSession(session); active.set(record.id, replacement);
      }
      move.mockClear();
      const before = JSON.stringify(store.getRun(record.id));
      acknowledge(); await settled;
      expect(JSON.stringify(store.getRun(record.id))).toBe(before);
      expect(store.getRun(record.id)?.agentInputs).toEqual([input]);
      expect(move).not.toHaveBeenCalled();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  },
);

it('ACK cannot answer a newly visible human ask or drain its queued successor', async () => {
  await withLiveInputRun(async ({ store, runId, send, options, human, onCleanup }) => {
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    onCleanup(() => acknowledge());
    const delivered = inputDelivered(store, runId, input.id);
    send.mockReturnValue(ack);
    store.commitAgentInputs(runId, [input]); options.onAgentInputReady?.();
    const second = { ...input, id: randomUUID() };
    store.commitAgentInputs(runId, [input, second]);
    options.onUiEvent?.({ type: 'ask.requested', requestId: 'choice', questions: [{
      header: 'Choice', question: 'Choose?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    acknowledge(); await delivered;
    expect(store.getRun(runId)?.agentInputs).toEqual([{ ...input, deliveredAt: expect.any(String) }, second]);
    expect(send).toHaveBeenCalledOnce(); expect(human).not.toHaveBeenCalled();
    expect(store.transcriptFacts(runId).pendingGateSeq).toBeDefined();
    expect(store.readEvents(runId).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });
});

it.each(['accepted', 'rejected'] as const)('%s ACK settles before a later provider-close frame in the same read batch', async outcome => {
  await withLiveInputRun(async ({ store, runId, send, options, emit, session, close, work }) => {
    const ack = outcome === 'accepted' ? Promise.resolve() : Promise.reject(new Error('command rejected'));
    send.mockReturnValue(ack);
    store.commitAgentInputs(runId, [input]); options.onAgentInputReady?.();
    emit({ type: 'error', message: 'later provider failure' }); session.interrupt();
    expect(session.open).toBe(false);
    close();
    while (work.pending.size) await Promise.allSettled([...work.pending.keys()]);
    expect(store.getRun(runId)?.agentInputs).toEqual(outcome === 'accepted' ? [{ ...input, deliveredAt: expect.any(String) }] : [input]);
    expect(store.getRun(runId)?.error).toContain('later provider failure');
  });
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

type InboxFixture = { store: RunStore; manager: RunManager; dir: string; runId: string;
  enqueue: (text: string) => AgentInput; sent: string[] };

function inboxFixture(store: RunStore, manager: RunManager, dir: string, runId: string, sent: string[]): InboxFixture {
  store.commitDelegation([{ id: runId, delegation: { role: 'root', permissions: [], receipts: [], conversation: { messages: [], outcomes: [] } } }]);
  const enqueue = (text: string) => {
    const entry: AgentInput = { ...input, id: randomUUID(), text, parentRunId: runId,
      conversation: { senderRunId: randomUUID(), recipientRunId: runId, kind: 'request' } };
    store.commitAgentInputs(runId, [...(store.getRun(runId)?.agentInputs ?? []), entry]);
    return entry;
  };
  return { store, manager, dir, runId, sent, enqueue };
}

async function withInboxRun(check: (fixture: InboxFixture) => Promise<void> | void, durable = false): Promise<void> {
  if (!durable) {
    await withLiveInputRun(async ({ store, manager, dir, runId, send }) => {
      const sent: string[] = [];
      send.mockImplementation(content => { sent.push(JSON.stringify(content)); return Promise.resolve(); });
      await check(inboxFixture(store, manager, dir, runId, sent));
    });
    return;
  }
  // Restart/refused-continuation cases deliberately have no step to reopen.
  const dir = mkdtempSync(join(tmpdir(), 'cez-inbox-durable-'));
  const store = RunStore.open(dir, { keepLive: true }), manager = new RunManager(store, dir, { acquireCiResources: acquireInertCiResources, createRunner: spiedRunners, home: testHome() });
  const record = store.createRun({ title: 'inbox', task: 'inbox', workflow: 'quick-task', steps: [] });
  setRunStatus(store, record.id, RUN_STATUS.running);
  try { await check(inboxFixture(store, manager, dir, record.id, [])); }
  finally { manager.dispose(); store.close(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
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

it('inbox cannot reserve an input in the durable opening Continue prompt', async () => {
  await withInboxRun(({ store, manager, runId, enqueue }) => {
    const first = enqueue('opening'), later = enqueue('later');
    store.updateRun(runId, { continuationMessage: { id: randomUUID(), createdAt: first.createdAt, text: first.text, agentInputId: first.id, origin: 'lifecycle' } });
    expect(manager.canClaimInboxInput(runId, first.id)).toBe(false);
    expect(manager.canClaimInboxInput(runId, later.id)).toBe(true);
    expect(manager.reserveInboxInputs(runId, randomUUID(), [first.id])).toBeUndefined();
  }, true);
});

it('inbox cannot reserve an input in the active opening Continue prompt', async () => {
  const first = { ...input, id: randomUUID(), text: 'opening input',
    conversation: { senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'request' as const } };
  await withLiveInputRun(({ store, manager, runId }) => {
    const later = { ...input, id: randomUUID(), text: 'later input', conversation: first.conversation };
    store.commitAgentInputs(runId, [first, later]);
    expect(manager.canClaimInboxInput(runId, first.id)).toBe(false);
    expect(manager.canClaimInboxInput(runId, later.id)).toBe(true);
    expect(manager.reserveInboxInputs(runId, randomUUID(), [first.id])).toBeUndefined();
  }, first);
});

it('failed claim and ACK checkpoints publish nothing and the same receipt can retry', async () => {
  await withInboxRun(({ store, manager, dir, runId, enqueue }) => {
    const first = enqueue('first'), generation = randomUUID(); store.flush();
    let release = blockRunWrites(dir);
    expect(() => manager.reserveInboxInputs(runId, generation, [first.id])).toThrow();
    expect(store.getRun(runId)?.agentInputs).toEqual([first]);
    release();
    const receipt = manager.reserveInboxInputs(runId, generation, [first.id])!;
    release = blockRunWrites(dir);
    expect(() => manager.acknowledgeInbox(runId, generation, receipt.receiptId)).toThrow();
    expect(store.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
    release();
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
    // A restart: the old store goes too, or it would still own the run.
    setRunStatus(store, runId, RUN_STATUS.waiting); store.close(); manager.dispose();
    vi.setSystemTime(Date.now() + (mode === 'live' ? 60_000 : 120_001));
    const reopened = RunStore.open(dir, { keepLive: true });
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
    const recovered = new RunManager(reopened, dir, { acquireCiResources: acquireInertCiResources, createRunner: spiedRunners, home: testHome(), semaphore });
    // Hold scheduler admission while observing the real durable wake produced by expiry.
    try {
      await recovered.recover();
      if (mode === 'live') {
        expect(reopened.getRun(runId)?.agentInputs?.[0]?.inboxClaim?.receiptId).toBe(receipt.receiptId);
        expect(reopened.getRun(runId)?.delegation).not.toHaveProperty('wait');
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(reopened.getRun(runId)?.agentInputs?.[0]?.inboxClaim).toBeUndefined();
      // hearsay-tools/cezarion#1235: the message is a wake of its own, not a `delegation.wait`
      // stand-in: it asks for a scheduler continuation, which this stepless fixture cannot open, so
      // the message stays queued for the next wake.
      expect(reopened.getRun(runId)?.delegation).not.toHaveProperty('wait');
      expect(reopened.readEvents(runId).filter(event => event.type === 'note' && String(event.message).startsWith('Messages retained; continuation unavailable: '))).toHaveLength(1);
      expect(reopened.getRun(runId)?.agentInputs?.[0]?.deliveredAt).toBeUndefined();
      expect(() => recovered.acknowledgeInbox(runId, generation, receipt.receiptId)).toThrow();
    } finally { recovered.dispose(); reopened.flush(); }
  }, true);
});


// hearsay-tools/cezarion#1235 review: the 1 Hz admission retry keeps trying a refused
// continuation, but the retained note is written once per refusal, not once per retry.
it('a continuation refused across several admission retries writes the retained note once', async () => {
  await withInboxRun(async ({ store, manager, dir, runId, enqueue }) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    enqueue('owed message');
    setRunStatus(store, runId, RUN_STATUS.waiting); store.close(); manager.dispose();
    const reopened = RunStore.open(dir, { keepLive: true });
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
    const recovered = new RunManager(reopened, dir, { acquireCiResources: acquireInertCiResources, createRunner: spiedRunners, home: testHome(), semaphore });
    const resume = vi.spyOn(recovered, 'continueRun');
    const notes = () => reopened.readEvents(runId).filter(event => event.type === 'note' && String(event.message).startsWith('Messages retained; continuation unavailable: '));
    try {
      await recovered.recover();
      const tries = resume.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      // Still retried every second, still refused, and noted once.
      expect(resume.mock.calls.length).toBeGreaterThanOrEqual(tries + 4);
      expect(resume.mock.results.every(result => result.type === 'return' && !result.value.ok)).toBe(true);
      expect(notes()).toHaveLength(1);
    } finally { recovered.dispose(); reopened.flush(); }
  }, true);
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
    const release = blockRunWrites(dir);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([]);
      expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim?.receiptId).toBe(receipt.receiptId);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toHaveLength(1); expect(sent[0]).toContain(first.id);
      expect(store.getRun(runId)?.agentInputs?.[0]?.inboxClaim).toBeUndefined();
    } finally { warning.mockRestore(); release(); }
  });
});

it('restart after durable inbox ACK retires the wake without creating a continuation', async () => {
  await withInboxRun(async ({ store, manager, dir, runId, enqueue }) => {
    const first = enqueue('already consumed'), generation = randomUUID(), receiptId = randomUUID();
    store.claimInboxInputs(runId, [first.id], { receiptId, generation, expiresAt: new Date(Date.now() + 120_000).toISOString() });
    store.commitDelegation([{ id: runId, delegation: { role: 'root', permissions: [], receipts: [],
      wait: { id: randomUUID(), workerIds: [], outcomes: [], deadline: new Date().toISOString(), phase: 'wake-pending', reason: 'message', wakeId: first.id } } }]);
    setRunStatus(store, runId, RUN_STATUS.waiting);
    // Simulate the crash boundary after the atomic ACK and before manager reconciliation.
    store.ackInboxInputs(runId, receiptId, generation, new Date().toISOString());
    manager.dispose(); store.close();
    const reopened = RunStore.open(dir, { keepLive: true });
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
    const recovered = new RunManager(reopened, dir, { acquireCiResources: acquireInertCiResources, createRunner: spiedRunners, home: testHome(), semaphore });
    try {
      await recovered.recover();
      expect(reopened.getRun(runId)?.delegation).not.toHaveProperty('wait');
      expect(reopened.getRun(runId)?.continuationMessage).toBeUndefined();
      expect(reopened.getRun(runId)?.status).toBe('waiting');
      expect(recovered.acknowledgeInbox(runId, generation, receiptId)).toBe('already-acknowledged');
    } finally { recovered.dispose(); reopened.flush(); }
  }, true);
});
