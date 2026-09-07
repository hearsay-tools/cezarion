import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { RunManager } from '../workflows/run.ts';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { enqueueAgentInput, nextAgentInput } from './input.ts';

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


it('readiness hints ignore stale/disposed sessions and guard duplicate/reentrant drains', () => {
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
        return true;
      },
      end: () => {}, interrupt: () => {},
    };
    const state = { session, pendingHumanAsk: true, cancelled: false };
    internal.active.set(record.id, state);
    internal.handleAgentInputReady(record.id, state, session);
    expect(sends).toBe(0);
    state.pendingHumanAsk = false;
    internal.handleAgentInputReady(record.id, state, { ...session });
    expect(sends).toBe(0);
    internal.handleAgentInputReady(record.id, state, session);
    internal.handleAgentInputReady(record.id, state, session);
    expect(sends).toBe(1);
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
