import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, InputDelivery } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import type { InputGroup } from './run/input-delivery.ts';
import { commitBundledDelivery } from './run/input-receipts.ts';
import type { RunModuleContext } from './run/types.ts';
import { runnerHook, setupMonitoringFixture } from './run-fixture.testkit.ts';

vi.mock('./active-run.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./active-run.ts')>();
  return { ...actual, createActiveRun: vi.fn(actual.createActiveRun) };
});

// Shared parity rows run on one runner (docs/adr/0063-one-scenario-runner.md). These cells drive
// Squawk's input delivery with every declared value of the delivery facts, so a value that runner
// does not declare is still tested above the seam. `FACT_VALUE_TESTS` in
// `core/parity-classes.testkit.ts` names this file for those values. The session here behaves as
// each value says; the seam contract (S36–S44) holds each real runner to the values it declares.

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const f = setupMonitoringFixture();
let policy: InputDelivery;
let opened = deferred<InputGroup>();
let sendAck: () => Promise<void>;
let holdsInput: () => boolean;
let emitAgentEvent: (event: AgentEvent) => void;
let reportConsumed: (ids: readonly string[]) => void;

beforeEach(() => {
  vi.mocked(createActiveRun).mockClear();
  opened = deferred<InputGroup>();
  sendAck = () => Promise.resolve();
  holdsInput = () => false;
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    get inputDelivery() { return policy; },
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(_spec, onEvent, options) {
      const last = vi.mocked(createActiveRun).mock.results.at(-1);
      if (!last || last.type !== 'return') throw new Error('runner opened without the ActiveRun factory');
      const group = last.value.inputState;
      const result = deferred<AgentRunResult>();
      let open = true;
      const close = () => { open = false; result.resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      emitAgentEvent = event => onEvent?.(event);
      reportConsumed = ids => options?.onAgentInputConsumed?.(ids);
      queueMicrotask(() => { onEvent?.({ type: 'session', sessionId: 'fact-values-session' }); opened.resolve(group); });
      return { get open() { return open; }, result: result.promise, sendMessage: () => true,
        sendAgentMessage: () => sendAck(), discardQueuedMessages: () => {}, holdsHumanInput: () => holdsInput(),
        end: close, interrupt: close };
    },
  };
});

async function openRun(delivery: InputDelivery) {
  policy = delivery;
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  const group = await opened.promise;
  f.store.commitDelegation([{ id: record.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  expect(group.inputDelivery).toEqual(delivery);
  const input = (text: string) => ({ id: randomUUID(), parentRunId: record.id, source: 'lifecycle' as const, text, createdAt: new Date().toISOString() });
  return { record, group, input };
}

const receipt = (runId: string, id: string) => f.store.getRun(runId)?.agentInputs?.find(entry => entry.id === id);

const STEER = { mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late', via: 'fact-values fixture' } as const;

// inputDelivery.consumption: an observable harness owes a read after its acknowledgement; an
// unobservable one is done at the acknowledgement.
for (const consumption of ['observable', 'unobservable'] as const) {
  it(`consumption '${consumption}' decides whether a delivered input still awaits its read`, async () => {
    const { record, group, input } = await openRun({ ...STEER, consumption });
    const message = input('read this');
    const ack = deferred<void>();
    sendAck = () => ack.promise;
    f.store.commitAgentInputs(record.id, [message]);
    f.manager.deliverConversationInput(record.id);
    const flight = group.agentInputFlight!;
    reportConsumed([message.id]);
    ack.resolve();
    await flight.settled;
    expect(receipt(record.id, message.id)?.deliveredAt).toBeDefined();
    if (consumption === 'observable') {
      expect(receipt(record.id, message.id)?.consumedAt).toBeDefined();
    } else {
      expect(receipt(record.id, message.id)?.awaitingRead).toBeUndefined();
      expect(receipt(record.id, message.id)?.consumedAt).toBeUndefined();
      expect(group.unreadInputIds?.size ?? 0).toBe(0);
    }
  });
}

// The same rule for messages bundled with a human answer: one commit, and a read is owed only
// where the harness reports reads.
for (const consumption of ['observable', 'unobservable'] as const) {
  it(`consumption '${consumption}' decides whether messages bundled with an answer await their read`, () => {
    const commitOutcome = vi.fn();
    const bundleInputs = vi.fn();
    const context = { store: { commitOutcome } } as unknown as RunModuleContext;
    const state = { inputState: { inputDelivery: { ...STEER, consumption }, bundleInputs } } as unknown as ActiveRun;
    expect(commitBundledDelivery(context, 'run-1', state, ['bundled-1'], [{ kind: 'answered' }])).toBeUndefined();
    const [, outcomes] = commitOutcome.mock.calls[0]!;
    expect(outcomes).toEqual([{ kind: 'answered' }, {
      kind: 'delivered', inputIds: ['bundled-1'], at: expect.any(String),
      ...(consumption === 'observable' ? { awaitingRead: true } : {}),
    }]);
    expect(bundleInputs).toHaveBeenCalledWith(['bundled-1']);
  });
}

// inputDelivery.acknowledgement and inputDelivery.mode: Squawk reads neither value. It sees only
// when the session acknowledges a write: at once ('write'), after the native response
// ('response'), or after model work of the turn the input opens ('model-work'), which a 'boundary'
// runner does after the running turn ends. Input stays undelivered until then, across a turn end.
const ACKNOWLEDGEMENTS = [
  { mode: 'steer', acknowledgement: 'write', humanInputAtTurnEnd: 'held-when-late', afterTurnEnd: false },
  { mode: 'steer', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late', afterTurnEnd: false },
  { mode: 'steer', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late', afterTurnEnd: true },
  { mode: 'boundary', acknowledgement: 'model-work', humanInputAtTurnEnd: 'always-held', afterTurnEnd: true },
] as const;
for (const { mode, acknowledgement, humanInputAtTurnEnd, afterTurnEnd } of ACKNOWLEDGEMENTS) {
  it(`mode '${mode}' with acknowledgement '${acknowledgement}' delivers an input only at its acknowledgement${afterTurnEnd ? ', after the turn ends' : ''}`, async () => {
    const consumption = mode === 'boundary' ? 'unobservable' : 'observable';
    const { record, group, input } = await openRun({ mode, consumption, acknowledgement, humanInputAtTurnEnd, via: 'fact-values fixture' } as InputDelivery);
    const message = input('work for the next model call');
    const ack = deferred<void>();
    sendAck = () => ack.promise;
    f.store.commitAgentInputs(record.id, [message]);
    f.manager.deliverConversationInput(record.id);
    const flight = group.agentInputFlight!;
    expect(flight).toBeDefined();
    if (afterTurnEnd) emitAgentEvent({ type: 'turn-end' });
    expect(receipt(record.id, message.id)?.deliveredAt).toBeUndefined();
    expect(group.agentInputFlight).toBe(flight);
    ack.resolve();
    await flight.settled;
    expect(receipt(record.id, message.id)?.deliveredAt).toBeDefined();
    // The message's flight is over. A later flight carries no input: after a turn end with no
    // read owed, the run may send its own follow-up prompt.
    expect(group.agentInputFlight === flight).toBe(false);
    expect(group.agentInputFlight?.inputIds ?? []).not.toContain(message.id);
  });
}

// inputDelivery.humanInputAtTurnEnd: Squawk asks the session at turn end whether it still holds a
// human message. A 'never-held' harness never does; 'held-when-late' and 'always-held' can, and
// then the run keeps its session for the turn that message opens, under the held-input timer.
for (const humanInputAtTurnEnd of ['never-held', 'held-when-late', 'always-held'] as const) {
  it(`humanInputAtTurnEnd '${humanInputAtTurnEnd}' decides whether a turn end keeps a held human message`, async () => {
    const delivery: InputDelivery = humanInputAtTurnEnd === 'always-held'
      ? { mode: 'boundary', consumption: 'unobservable', acknowledgement: 'model-work', humanInputAtTurnEnd, via: 'fact-values fixture' }
      : { ...STEER, humanInputAtTurnEnd };
    const { group } = await openRun(delivery);
    holdsInput = () => humanInputAtTurnEnd !== 'never-held';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      emitAgentEvent({ type: 'turn-end' });
      if (humanInputAtTurnEnd === 'never-held') {
        expect(group.heldHumanInputTimer).toBeUndefined();
      } else {
        expect(group.heldHumanInputTimer).toBeDefined();
        expect(group.heldHumanInputSince).toBeDefined();
      }
    } finally { vi.useRealTimers(); }
  });
}
