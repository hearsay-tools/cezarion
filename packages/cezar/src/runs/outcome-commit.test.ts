import { openTestRunStore, runPersistence } from './run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInput, TimerWaitEntry, Wait } from '@open-mercato/cezar-contract';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, WAIT_PHASE, WAIT_VIA, makeHumanWait, makeRunRecord, makeStepState, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';

import { applyOutcomes } from './outcome-commit.ts';
import { blockRunWrites, crashStore, muteLockedDatabaseLogs, readPersistedRuns } from './run-store.testkit.ts';
import { RunStore, type RunRecord } from './store.ts';

/**
 * `RunStore.commitOutcome` (hearsay-tools/cezarion#1805): an outcome and what it depends on in one
 * transaction, read back from the committed row as a store reopened after a crash reads it.
 */

const at = '2026-10-26T12:00:00.000Z';
let directory: string;
let store: RunStore;
let id: string;

const committed = (): RunRecord => readPersistedRuns(directory).find((record) => record.id === id);
const input = (overrides: Partial<AgentInput> = {}): AgentInput => ({ id: randomUUID(), parentRunId: id, source: 'lifecycle', text: 'wake', createdAt: at, ...overrides });
const timer = (overrides: Partial<TimerWaitEntry> = {}): Wait => makeTimerWait({ id: randomUUID(), via: WAIT_VIA.cezar_wait, registeredAt: at, deadline: at, ...overrides });
const human = (): Wait => makeHumanWait({ id: randomUUID(), registeredAt: at });

beforeEach(() => {
  directory = join(mkdtempSync(join(tmpdir(), 'cez-outcome-')), '.ai/cezar');
  store = openTestRunStore(directory, { keepLive: true });
  id = store.createRun({ title: 'outcomes', workflow: 'quick-task', task: 'wait', steps: [{ id: 'main', name: 'main', kind: STEP_KIND.agent }] }).id;
  store.flush();
});
afterEach(() => {
  store.close();
  rmSync(join(directory, '..', '..'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('commitOutcome', () => {
  it('commits every outcome of a call and what it depends on in one transaction', () => {
    const wait = timer({ phase: WAIT_PHASE.resolved, resolvedAt: at });
    const message = input({ text: 'a message' });
    store.commitWait(id, wait, input({ id: wait.id }));
    store.commitAgentInputs(id, [...store.getRun(id)!.agentInputs!, message]);
    const refusal = input({ purpose: 'completion-refusal' });
    const commits = vi.spyOn(runPersistence(store), 'persist');
    store.commitOutcome(id, [{ kind: 'delivered', inputIds: [wait.id, message.id], at }, { kind: 'charged', automaticWakes: 7 }, { kind: 'counted', waitDeliveryFailures: undefined }],
      { patch: { status: RUN_STATUS.running }, enqueue: [refusal] });
    expect(commits).toHaveBeenCalledTimes(1);
    const row = committed();
    expect(row).toMatchObject({ status: RUN_STATUS.running, automaticWakes: 7 });
    expect(row.lastWaits).toEqual([expect.objectContaining({ id: wait.id, phase: WAIT_PHASE.delivered, deliveredAt: at })]);
    expect(row.agentInputs?.map((entry: AgentInput) => [entry.id, entry.deliveredAt])).toEqual([[wait.id, at], [message.id, at], [refusal.id, undefined]]);
  });

  it('writes nothing when no outcome changes the record', () => {
    const commits = vi.spyOn(runPersistence(store), 'persist');
    expect(store.commitOutcome(id, [{ kind: 'answered' }, { kind: 'counted', waitDeliveryFailures: undefined }, { kind: 'delivered', inputIds: [randomUUID()], at }]))
      .toEqual({ committed: false, answered: [] });
    expect(commits).not.toHaveBeenCalled();
  });

  it('answers open human waits and the continuation they answer in the same commit', () => {
    const wait = human();
    store.commitWait(id, wait);
    const continuationMessage = { id: 'continue-1', text: 'the answer', createdAt: at, origin: 'human' as const };
    const receipt = store.commitOutcome(id, { kind: 'answered' }, { patch: { continuationMessage } });
    expect(receipt).toEqual({ committed: true, answered: [wait.id] });
    expect(committed()).toMatchObject({ continuationMessage: { text: 'the answer' }, lastWaits: [{ id: wait.id, phase: WAIT_PHASE.delivered }] });
  });

  it('a refused write throws with nothing changed', () => {
    const before = structuredClone(store.getRun(id));
    const unmute = muteLockedDatabaseLogs();
    const unblock = blockRunWrites(directory);
    try { expect(() => store.commitOutcome(id, { kind: 'charged', automaticWakes: 3 })).toThrow(); }
    finally { unblock(); unmute(); }
    expect(store.getRun(id)).toEqual(before);
    expect(committed().automaticWakes).toBeUndefined();
  });

  it('bestEffort never throws on a refused write and leaves the change to the debounced save', () => {
    const unmute = muteLockedDatabaseLogs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unblock = blockRunWrites(directory);
    try { expect(store.commitOutcome(id, { kind: 'counted', waitDeliveryFailures: 2 }, {}, { bestEffort: true })).toEqual({ committed: false, answered: [] }); }
    finally { unblock(); unmute(); }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outcome checkpoint failed'));
    expect(store.getRun(id)?.waitDeliveryFailures).toBe(2);
    store.flush();
    expect(committed().waitDeliveryFailures).toBe(2);
  });

  it('the queue checkpoint refuses a receipt, which only an outcome writes', () => {
    const queued = input();
    store.commitAgentInputs(id, [queued]);
    for (const receipts of [{ deliveredAt: at }, { consumedAt: at }]) {
      expect(() => store.commitAgentInputs(id, [{ ...queued, ...receipts }])).toThrow('agent input receipts change only through commitOutcome');
    }
    expect(() => store.commitAgentInputs(id, [queued, input({ deliveredAt: at })])).toThrow('agent input receipts change only through commitOutcome');
    store.commitOutcome(id, { kind: 'delivered', inputIds: [queued.id], at });
    expect(() => store.commitAgentInputs(id, [{ ...store.getRun(id)!.agentInputs![0]!, deliveredAt: undefined }])).toThrow('agent input receipts change only through commitOutcome');
    store.commitAgentInputs(id, [...store.getRun(id)!.agentInputs!, input()]);
    expect(committed().agentInputs?.map((entry: AgentInput) => entry.deliveredAt)).toEqual([at, undefined]);
  });

  // AGENTS.md § Test the path with no live session: recovery reaches the call with nothing but the row.
  it('commits for a run no session holds, read back by a store reopened after a crash', () => {
    const wait = human();
    store.commitWait(id, wait);
    crashStore(store);
    store = openTestRunStore(directory, { keepLive: true });
    expect(store.commitOutcome(id, { kind: 'answered', waitIds: [wait.id] }).answered).toEqual([wait.id]);
    crashStore(store);
    store = openTestRunStore(directory, { keepLive: true });
    expect(store.getRun(id)?.lastWaits).toEqual([expect.objectContaining({ id: wait.id, phase: WAIT_PHASE.delivered })]);
  });
});

describe('applyOutcomes', () => {
  const base = (): RunRecord => makeRunRecord({ status: RUN_STATUS.running, steps: [makeStepState({ id: 'main', name: 'main', status: STEP_STATUS.waiting, iterations: 0 })] });

  it('reads and requeues inputs: consumed keeps deliveredAt, requeued drops every receipt', () => {
    const delivered = { ...input(), deliveredAt: at, awaitingRead: true as const };
    const run = { ...base(), agentInputs: [delivered] };
    const read = applyOutcomes(run, [{ kind: 'consumed', inputIds: [delivered.id], at }]).next.agentInputs![0]!;
    expect(read).toMatchObject({ deliveredAt: at, consumedAt: at });
    expect(read).not.toHaveProperty('awaitingRead');
    const requeued = applyOutcomes({ ...run, agentInputs: [read] }, [{ kind: 'requeued', inputIds: [delivered.id] }]).next.agentInputs![0]!;
    expect(requeued).not.toHaveProperty('deliveredAt');
    expect(requeued).not.toHaveProperty('consumedAt');
  });

  it('the opening input is handled only while the continuation names it, and clears it', () => {
    const opening = input();
    const run = { ...base(), agentInputs: [opening], continuationMessage: { id: 'c', text: 'x', createdAt: at, origin: 'human' as const, agentInputId: opening.id } };
    const next = applyOutcomes(run, [{ kind: 'opening-handled', inputId: opening.id, at }]).next;
    expect(next.continuationMessage).toBeUndefined();
    expect(next.agentInputs![0]).toMatchObject({ deliveredAt: at, consumedAt: at });
    expect(() => applyOutcomes({ ...run, continuationMessage: undefined }, [{ kind: 'opening-handled', inputId: opening.id, at }])).toThrow('opening agent input checkpoint changed');
  });

  it('cancels open waits with their undelivered wake input, delivers a queued message, and resumes the waiting step', () => {
    const wait = timer();
    const run = { ...base(), waits: [wait], agentInputs: [input({ id: wait.id })], queuedMessages: [{ id: 'm1', text: 'hi', createdAt: at }] } as RunRecord;
    const { next, changed } = applyOutcomes(run, [{ kind: 'cancelled', waitIds: [wait.id] }, { kind: 'message-delivered', messageId: 'm1' }], { resumeStepId: 'main' });
    expect(changed).toBe(true);
    expect(next.waits).toBeUndefined();
    expect(next.lastWaits).toEqual([expect.objectContaining({ id: wait.id, phase: WAIT_PHASE.cancelled })]);
    expect(next.agentInputs).toEqual([]);
    expect(next.queuedMessages).toEqual([]);
    expect(next.steps[0]!.status).toBe(STEP_STATUS.running);
  });
});
