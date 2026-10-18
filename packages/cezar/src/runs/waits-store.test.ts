import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_WAITS_LIMIT, WAIT_LIMIT, type Wait } from '@open-mercato/cezar-contract/waits';
import type { AgentInput, CiWaitResult } from '@open-mercato/cezar-contract';

import { RunDatabase, RUNS_DB_FILE } from './run-database.ts';
import { isLiveRecord } from './run-row.ts';
import { parseRunRecords, RunStore, type RunRecord } from './store.ts';
import { readPersistedRuns, seedRuns } from './run-store.testkit.ts';

/**
 * The wait list on the run record (spec 2026-10-17-unified-waits, phase 1:
 * hearsay-tools/cezarion#1233): legacy CI and monitoring fields upgrade on read into `waits`,
 * and the store's three wait checkpoints.
 */

const RUN_ID = '0123abcd-0000-4000-8000-000000000000';
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID, title: 'CI', workflow: 'quick-task', task: 'wait for CI', status: 'running', createdAt: iso(-3_600_000),
    tokensUsed: 0, archived: false, currentStepId: 'main',
    steps: [{ id: 'main', name: 'main', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }],
    ...overrides,
  };
}

const legacyCi = {
  id: '11111111-1111-4111-8111-111111111111', generation: 'session', turnId: 'turn-1',
  prUrl: 'https://github.com/acme/repo/pull/12', repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40),
  timeoutSeconds: 1800, registeredAt: iso(-60_000), deadline: iso(1_740_000), phase: 'parked' as const,
};

const result: CiWaitResult = {
  outcome: 'passed', headSha: 'a'.repeat(40), observedAt: iso(-1_000), checks: [{ name: 'ci', state: 'SUCCESS', link: 'https://example.com/ci' }],
  totalChecks: 1, truncated: false,
};

const lifecycleInput = (id: string): AgentInput => ({ id, parentRunId: RUN_ID, source: 'lifecycle', text: 'CI observation', createdAt: iso(-1_000) });

function parseOne(row: Record<string, unknown>): RunRecord {
  const parsed = parseRunRecords([row]);
  expect(parsed.success).toBe(true);
  return parsed.data![0]!;
}

function ciEntry(overrides: Partial<Extract<Wait, { kind: 'ci' }>> = {}): Wait {
  return {
    id: randomUUID(), kind: 'ci', source: 'agent', via: 'cezar_wait', registeredAt: iso(0), deadline: iso(1_800_000), phase: 'open',
    turnId: 'turn-1', prUrl: legacyCi.prUrl, repository: legacyCi.repository, prNumber: legacyCi.prNumber, headSha: legacyCi.headSha,
    generation: 'session', timeoutSeconds: 1800, ...overrides,
  } as Wait;
}

function humanEntry(overrides: Partial<Extract<Wait, { kind: 'human' }>> = {}): Wait {
  return { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: iso(0), phase: 'open', turnId: 'turn-1', ...overrides } as Wait;
}

function timerEntry(overrides: Partial<Extract<Wait, { kind: 'timer' }>> = {}): Wait {
  return {
    id: randomUUID(), kind: 'timer', source: 'agent', via: 'cezar_wait', registeredAt: iso(0), deadline: iso(300_000), phase: 'open',
    turnId: 'turn-1', seconds: 300, ...overrides,
  } as Wait;
}

describe('upgrade-on-read of legacy wait fields', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it('upgrades a parked v3 CI row into one resolved wait and a waiting status', () => {
    const run = parseOne(legacyRow({
      activity: 'monitoring',
      ciWait: { ...legacyCi, phase: 'wake-pending', result, wakeId: legacyCi.id },
      agentInputs: [lifecycleInput(legacyCi.id)],
    }));
    expect(run.status).toBe('waiting');
    expect(run.activity).toBeUndefined();
    // A waiting park's current step waits with it, as every other park writes it.
    expect(run.steps[0]!.status).toBe('waiting');
    expect(run.waits).toEqual([expect.objectContaining({
      id: legacyCi.id, kind: 'ci', source: 'agent', phase: 'resolved', via: 'cezar_wait_for_ci', result, resolvedAt: result.observedAt,
      prUrl: legacyCi.prUrl, headSha: legacyCi.headSha, generation: 'session', turnId: 'turn-1', deadline: legacyCi.deadline,
    })]);
    expect(run.waits![0]).not.toHaveProperty('wakeId');
    expect(run).not.toHaveProperty('ciWait');
    expect(run.lastWaits).toBeUndefined();
    // The wake input keeps its id, which is the wait's: delivery finds it by that id.
    expect(run.agentInputs).toEqual([lifecycleInput(legacyCi.id)]);
  });

  it('maps registered/parked → open, delivered → lastWaits delivered, withdrawn → lastWaits cancelled', () => {
    for (const phase of ['registered', 'parked'] as const) {
      const run = parseOne(legacyRow({ activity: 'monitoring', ciWait: { ...legacyCi, phase } }));
      expect(run.waits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'ci', phase: 'open' })]);
      expect(run.status).toBe('waiting');
    }
    const deliveredAt = iso(-500);
    const delivered = parseOne(legacyRow({ status: 'done', lastCiWait: { ...legacyCi, phase: 'delivered', result, wakeId: legacyCi.id, deliveredAt } }));
    expect(delivered.waits).toBeUndefined();
    expect(delivered.lastWaits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'ci', phase: 'delivered', deliveredAt, result })]);
    expect(delivered).not.toHaveProperty('lastCiWait');
    const withdrawn = parseOne(legacyRow({ status: 'done', lastCiWait: { ...legacyCi, phase: 'withdrawn' } }));
    expect(withdrawn.lastWaits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'ci', phase: 'cancelled' })]);
  });

  it('upgrades running+monitoring+monitoringWakeAt into an open timer due at monitoringWakeAt', () => {
    const wakeAt = iso(300_000);
    const row = () => legacyRow({ activity: 'monitoring', monitoringWakeAt: wakeAt, monitoringWakeCapReached: true });
    const run = parseOne(row());
    expect(run.status).toBe('waiting');
    expect(run.waits).toEqual([expect.objectContaining({
      kind: 'timer', source: 'agent', via: 'monitoring-line', phase: 'open', deadline: wakeAt, seconds: 300, turnId: 'legacy',
    })]);
    for (const key of ['monitoringWakeAt', 'monitoringWakeCapReached', 'activity']) expect(run).not.toHaveProperty(key);
    // The row stays as stored until it is next written, so every read must name the same wait.
    expect(parseOne(row()).waits![0]!.id).toBe(run.waits![0]!.id);
    // The remaining time, clamped to a timer's bounds.
    expect(parseOne(legacyRow({ activity: 'monitoring', monitoringWakeAt: iso(-60_000) })).waits![0]).toMatchObject({ seconds: 60 });
    expect(parseOne(legacyRow({ activity: 'monitoring', monitoringWakeAt: iso(5 * 3_600_000) })).waits![0]).toMatchObject({ seconds: 7200 });
  });

  it('upgrades running+monitoring without monitoringWakeAt into plain waiting with no wait', () => {
    const run = parseOne(legacyRow({ activity: 'monitoring' }));
    expect(run.status).toBe('waiting');
    expect(run.activity).toBeUndefined();
    expect(run.waits).toBeUndefined();
    expect(run.lastWaitsError).toBeUndefined();
  });

  it('drops stale monitoring fields from a finished row without opening a wait', () => {
    const run = parseOne(legacyRow({ status: 'done', activity: 'monitoring', monitoringWakeAt: iso(300_000) }));
    expect(run.status).toBe('done');
    expect(run.waits).toBeUndefined();
    expect(run).not.toHaveProperty('monitoringWakeAt');
    expect(run).not.toHaveProperty('activity');
  });

  it('drops one unreadable wait entry, keeps the run and its readable waits, and sets lastWaitsError', () => {
    const readable = ciEntry();
    const settled = timerEntry({ phase: 'delivered', deliveredAt: iso(0) });
    const run = parseOne(legacyRow({ status: 'waiting', waits: [readable, { id: 'nope', kind: 'ci', phase: 'open' }], lastWaits: [settled, { kind: 'timer' }] }));
    expect(run.status).toBe('waiting');
    expect(run.waits).toEqual([readable]);
    expect(run.lastWaits).toEqual([settled]);
    expect(run.lastWaitsError).toMatch(/unreadable/);
    const notAList = parseOne(legacyRow({ status: 'waiting', waits: { id: 'x' } }));
    expect(notAList.waits).toBeUndefined();
    expect(notAList.lastWaitsError).toMatch(/unreadable/);
  });

  it('drops an unreadable legacy CI wait with the same salvage and leaves the status alone', () => {
    const run = parseOne(legacyRow({ ciWait: { phase: 'parked', deadline: 'invalid' } }));
    expect(run.status).toBe('running');
    expect(run.error).toBeUndefined();
    expect(run.waits).toBeUndefined();
    expect(run).not.toHaveProperty('ciWait');
    expect(run.lastWaitsError).toMatch(/unreadable/);
    const previous = parseOne(legacyRow({ status: 'done', lastCiWait: { ...legacyCi, phase: 'delivered', result: { outcome: 'passed' } } }));
    expect(previous.lastWaits).toBeUndefined();
    expect(previous.lastWaitsError).toMatch(/unreadable/);
  });

  it('carries lastCiWaitError over as lastWaitsError', () => {
    const run = parseOne(legacyRow({ status: 'done', lastCiWaitError: 'CI wait unavailable — saved observation is unreadable; register a new wait.' }));
    expect(run.lastWaitsError).toBe('CI wait unavailable — saved observation is unreadable; register a new wait.');
    expect(run).not.toHaveProperty('lastCiWaitError');
  });
});

describe('isLiveRecord and the wait list', () => {
  const base = parseOne(legacyRow({ status: 'done' }));
  it('is true for an open or resolved wait and false when only lastWaits remain', () => {
    expect(isLiveRecord({ ...base, waits: [ciEntry()] })).toBe(true);
    expect(isLiveRecord({ ...base, waits: [timerEntry({ phase: 'resolved', resolvedAt: iso(0) })] })).toBe(true);
    expect(isLiveRecord({ ...base, lastWaits: [ciEntry({ phase: 'delivered', deliveredAt: iso(0) }), timerEntry({ phase: 'cancelled', cancelledAt: iso(0) })] })).toBe(false);
    expect(isLiveRecord({ ...base, waits: [] })).toBe(false);
  });
});

describe('wait checkpoints', () => {
  let directory: string;
  let store: RunStore;
  let id: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-waits-store-'));
    store = RunStore.open(directory, { keepLive: true });
    id = store.createRun({ title: 'Waits', workflow: 'quick-task', task: 'wait', steps: [] }).id;
    store.updateRun(id, { status: 'waiting' });
  });
  afterEach(() => { vi.restoreAllMocks(); store.flush(); rmSync(directory, { recursive: true, force: true }); });
  const input = (waitId: string, text = 'wake'): AgentInput => ({ id: waitId, parentRunId: id, source: 'lifecycle', text, createdAt: new Date().toISOString() });
  const reopen = () => { store.close(); store = RunStore.open(directory, { keepLive: true }); return store.getRun(id)!; };

  it('commitWait upserts by wait id and appends its input once', () => {
    const wait = ciEntry();
    store.commitWait(id, wait);
    const resolved = { ...wait, phase: 'resolved' as const, resolvedAt: iso(0), result };
    store.commitWait(id, resolved, input(wait.id));
    store.commitWait(id, resolved, input(wait.id));
    for (const run of [store.getRun(id)!, reopen()]) {
      expect(run.waits).toEqual([resolved]);
      expect(run.agentInputs?.map((entry) => entry.id)).toEqual([wait.id]);
    }
  });

  it('commitWait clears lastWaitsError and refuses a settled wait or one past the open limit', () => {
    store.close();
    const records = readPersistedRuns(directory);
    records[0].lastWaitsError = 'Wait unavailable — a saved wait is unreadable; register a new wait.';
    seedRuns(directory, records);
    store = RunStore.open(directory, { keepLive: true });
    store.commitWait(id, ciEntry());
    expect(store.getRun(id)?.lastWaitsError).toBeUndefined();
    expect(() => store.commitWait(id, ciEntry({ phase: 'delivered', deliveredAt: iso(0) }))).toThrow(/settled/);
    for (let i = 1; i < WAIT_LIMIT; i++) store.commitWait(id, timerEntry());
    expect(() => store.commitWait(id, timerEntry())).toThrow(/limit/);
    expect(store.getRun(id)?.waits).toHaveLength(WAIT_LIMIT);
  });

  it('publishes nothing if the durable replacement fails', () => {
    const events = vi.fn(); store.on('run', events);
    vi.spyOn(store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw new Error('read only'); });
    expect(() => store.commitWait(id, ciEntry())).toThrow('read only');
    expect(store.getRun(id)?.waits).toBeUndefined();
    expect(events).not.toHaveBeenCalled();
  });

  it('commitWaitCancellation moves open and resolved waits to lastWaits as cancelled and drops their undelivered input', () => {
    const open = ciEntry();
    const resolved = timerEntry({ phase: 'resolved', resolvedAt: iso(0) });
    const kept = timerEntry();
    store.commitWait(id, open);
    store.commitWait(id, resolved, input(resolved.id));
    store.commitWait(id, kept);
    const other: AgentInput = { ...input(randomUUID(), 'unrelated') };
    store.commitAgentInputs(id, [...store.getRun(id)!.agentInputs!, other]);
    store.commitWaitCancellation(id, [open.id, resolved.id, randomUUID()]);
    for (const run of [store.getRun(id)!, reopen()]) {
      expect(run.waits).toEqual([kept]);
      expect(run.lastWaits?.map((wait) => [wait.id, wait.phase])).toEqual([[open.id, 'cancelled'], [resolved.id, 'cancelled']]);
      expect(run.lastWaits?.every((wait) => typeof wait.cancelledAt === 'string')).toBe(true);
      expect(run.agentInputs?.map((entry) => entry.id)).toEqual([other.id]);
    }
  });

  it('commitWaitCancellation keeps an input that was already delivered', () => {
    const resolved = timerEntry({ phase: 'resolved', resolvedAt: iso(0) });
    store.commitWait(id, resolved, { ...input(resolved.id), deliveredAt: iso(0) });
    store.commitWaitCancellation(id, [resolved.id]);
    expect(store.getRun(id)?.agentInputs?.map((entry) => entry.id)).toEqual([resolved.id]);
  });

  it('commitWaitDelivery retires exactly the delivered waits and their inputs in one commit', () => {
    const first = ciEntry({ phase: 'resolved', resolvedAt: iso(0), result });
    const second = timerEntry({ phase: 'resolved', resolvedAt: iso(0) });
    const open = ciEntry();
    store.commitWait(id, first, input(first.id));
    store.commitWait(id, second, input(second.id));
    store.commitWait(id, open);
    const commits = vi.spyOn(store as unknown as { commitIndex(): void }, 'commitIndex');
    store.commitWaitDelivery(id, [first.id, open.id]);
    expect(commits).toHaveBeenCalledTimes(1);
    for (const run of [store.getRun(id)!, reopen()]) {
      // The open wait named in the batch is not resolved, so it stays open.
      expect(run.waits).toEqual([second, open]);
      expect(run.lastWaits).toEqual([{ ...first, phase: 'delivered', deliveredAt: expect.any(String) }]);
      const delivered = run.agentInputs!.find((entry) => entry.id === first.id)!;
      expect(delivered.deliveredAt).toBe(run.lastWaits![0]!.deliveredAt);
      expect(run.agentInputs!.find((entry) => entry.id === second.id)!.deliveredAt).toBeUndefined();
    }
  });

  // hearsay-tools/cezarion#1234: the user's answer ends every open human wait at once.
  it('commitHumanWaitsAnswered settles every open human wait as delivered and leaves ci open', () => {
    const human = humanEntry({ questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }], askSeq: 3 });
    const ci = ciEntry();
    store.commitWait(id, human);
    store.commitWait(id, ci);
    expect(store.commitHumanWaitsAnswered(id)).toEqual([human.id]);
    for (const run of [store.getRun(id)!, reopen()]) {
      expect(run.waits).toEqual([ci]);
      expect(run.lastWaits).toEqual([{ ...human, phase: 'delivered', deliveredAt: expect.any(String) }]);
    }
    expect(store.commitHumanWaitsAnswered(id)).toEqual([]);
  });

  it('a human wait round-trips through close and reopen with its askSeq', () => {
    const human = humanEntry();
    store.commitWait(id, human);
    store.commitWait(id, { ...human, askSeq: 12 } as Wait);
    expect(reopen().waits).toEqual([{ ...human, askSeq: 12 }]);
  });

  it('an unreadable automaticWakes reads as absent', () => {
    store.updateRun(id, { automaticWakes: 4, waitDeliveryFailures: 2 });
    expect(reopen()).toMatchObject({ automaticWakes: 4, waitDeliveryFailures: 2 });
    store.close();
    const records = readPersistedRuns(directory);
    records[0].automaticWakes = 'many';
    records[0].waitDeliveryFailures = -1;
    seedRuns(directory, records);
    store = RunStore.open(directory, { keepLive: true });
    const run = store.getRun(id)!;
    expect(run.status).toBe('waiting');
    expect(run.automaticWakes).toBeUndefined();
    expect(run.waitDeliveryFailures).toBeUndefined();
  });

  it('caps lastWaits at 16, oldest dropped', () => {
    const ids: string[] = [];
    for (let i = 0; i < LAST_WAITS_LIMIT + 3; i++) {
      const wait = timerEntry();
      ids.push(wait.id);
      store.commitWait(id, wait);
      store.commitWaitCancellation(id, [wait.id]);
    }
    for (const run of [store.getRun(id)!, reopen()]) {
      expect(run.lastWaits?.map((wait) => wait.id)).toEqual(ids.slice(-LAST_WAITS_LIMIT));
      expect(run.waits).toBeUndefined();
    }
  });
});

describe('opening a v3 store', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'cez-waits-v3-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('opens a parked CI row as waiting with one resolved wait, rewrites it without legacy fields, and keeps its input once', () => {
    seedRuns(directory, [legacyRow({
      activity: 'monitoring',
      ciWait: { ...legacyCi, phase: 'wake-pending', result, wakeId: legacyCi.id },
      agentInputs: [lifecycleInput(legacyCi.id)],
    })]);
    const store = RunStore.open(directory, { keepLive: true });
    try {
      const run = store.getRun(RUN_ID)!;
      expect(run.status).toBe('waiting');
      expect(run.waits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'ci', phase: 'resolved', result })]);
      expect(run.agentInputs).toHaveLength(1);
      store.flush();
    } finally {
      store.close();
    }
    // Open marked the upgraded row dirty, so its data and summary are the new shape on disk.
    const [stored] = readPersistedRuns(directory);
    for (const key of ['ciWait', 'activity', 'monitoringWakeAt']) expect(stored).not.toHaveProperty(key);
    expect(stored.waits).toEqual([expect.objectContaining({ id: legacyCi.id, phase: 'resolved' })]);
    const db = RunDatabase.openReadOnly(join(directory, RUNS_DB_FILE))!;
    try {
      const row = db.get(RUN_ID)!;
      expect(row.live).toBe(true);
      const summary = JSON.parse(db.listAll()[0]!.summary);
      expect(summary.status).toBe('waiting');
      expect(summary).not.toHaveProperty('activity');
    } finally {
      db.close();
    }
    const again = RunStore.open(directory, { keepLive: true });
    try {
      expect(again.getRun(RUN_ID)?.waits).toHaveLength(1);
      expect(again.getRun(RUN_ID)?.agentInputs).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});
