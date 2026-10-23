import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAST_WAITS_LIMIT, WAIT_LIMIT, type Wait } from '@open-mercato/cezar-contract/waits';
import type { AgentInput, CiWaitResult } from '@open-mercato/cezar-contract';

import { RunDatabase, RunDatabaseUnsupportedSchemaError, RUN_DATABASE_SCHEMA_VERSION, RUNS_DB_FILE } from './run-database.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import { isLiveRecord } from './run-row.ts';
import { holdsWorkerWait, parseRunRecords, RunStore, workerWaitEntry, type RunRecord } from './store.ts';
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

function ciEntry(overrides: Partial<Extract<Wait, { kind: 'pr' }>> = {}): Extract<Wait, { kind: 'pr' }> {
  return {
    id: randomUUID(), kind: 'pr', source: 'agent', via: 'cezar_wait', registeredAt: iso(0), deadline: iso(1_800_000), phase: 'open',
    turnId: 'turn-1', prUrl: legacyCi.prUrl, repository: legacyCi.repository, prNumber: legacyCi.prNumber, headSha: legacyCi.headSha,
    generation: 'session', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true, ...overrides,
  } as Extract<Wait, { kind: 'pr' }>;
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
    // A waiting park's current step waits with it, as every other park writes it.
    expect(run.steps[0]!.status).toBe('waiting');
    expect(run.waits).toEqual([expect.objectContaining({
      id: legacyCi.id, kind: 'pr', source: 'agent', phase: 'resolved', via: 'cezar_wait_for_ci', result, resolvedAt: result.observedAt,
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
      expect(run.waits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'pr', phase: 'open' })]);
      expect(run.status).toBe('waiting');
    }
    const deliveredAt = iso(-500);
    const delivered = parseOne(legacyRow({ status: 'done', lastCiWait: { ...legacyCi, phase: 'delivered', result, wakeId: legacyCi.id, deliveredAt } }));
    expect(delivered.waits).toBeUndefined();
    expect(delivered.lastWaits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'pr', phase: 'delivered', deliveredAt, result })]);
    expect(delivered).not.toHaveProperty('lastCiWait');
    const withdrawn = parseOne(legacyRow({ status: 'done', lastCiWait: { ...legacyCi, phase: 'withdrawn' } }));
    expect(withdrawn.lastWaits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'pr', phase: 'cancelled' })]);
  });

  // hearsay-tools/cezarion#1425: kind "ci" became kind "pr"; rows written before keep reading.
  it('reads stored ci entries and a legacy ciWait as pr checks waits that wake on conflict', () => {
    const asCi = ({ until: _until, wakeOnConflict: _wake, ...entry }: Extract<Wait, { kind: 'pr' }>) => ({ ...entry, kind: 'ci' }) as Record<string, unknown>;
    const open = asCi(ciEntry());
    const settled = asCi(ciEntry({ phase: 'delivered', result, deliveredAt: iso(-100) }));
    const run = parseOne(legacyRow({ status: 'waiting', waits: [open], lastWaits: [settled] }));
    expect(run.waits).toEqual([expect.objectContaining({ id: open.id, kind: 'pr', until: 'checks' as const, wakeOnConflict: true, phase: 'open' })]);
    expect(run.lastWaits).toEqual([expect.objectContaining({ id: settled.id, kind: 'pr', until: 'checks' as const, wakeOnConflict: true, result })]);
    expect(run.lastWaitsError).toBeUndefined();
    const legacy = parseOne(legacyRow({ activity: 'monitoring', ciWait: { ...legacyCi, phase: 'parked' } }));
    expect(legacy.waits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'pr', until: 'checks' as const, wakeOnConflict: true })]);
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
    const run = parseOne(legacyRow({ status: 'waiting', waits: [readable, { id: 'nope', kind: 'pr', phase: 'open' }], lastWaits: [settled, { kind: 'timer' }] }));
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

  // hearsay-tools/cezarion#1234: a wake's charge and its cleared failure count commit with it.
  it('commitWaitDelivery commits the wake counters in the same commit', () => {
    const resolved = timerEntry({ phase: 'resolved', resolvedAt: iso(0) });
    store.commitWait(id, resolved, input(resolved.id));
    store.updateRun(id, { automaticWakes: 6, waitDeliveryFailures: 2 });
    const commits = vi.spyOn(store as unknown as { commitIndex(): void }, 'commitIndex');
    store.commitWaitDelivery(id, [resolved.id], { automaticWakes: 7, waitDeliveryFailures: undefined });
    expect(commits).toHaveBeenCalledTimes(1);
    for (const run of [store.getRun(id)!, reopen()]) {
      expect(run.lastWaits).toEqual([{ ...resolved, phase: 'delivered', deliveredAt: expect.any(String) }]);
      expect(run.automaticWakes).toBe(7);
      expect(run.waitDeliveryFailures).toBeUndefined();
    }
  });

  // hearsay-tools/cezarion#1235 (PR #1291 review): a resumed delivery moves the run and its
  // waiting step together, so a resumed task never reads active with a waiting step.
  it('commitWaitDelivery resumes the run and its waiting step in the same commit', () => {
    const stepId = 'main';
    const runId = store.createRun({ title: 'Waits', workflow: 'quick-task', task: 'wait', steps: [{ id: stepId, name: 'main', kind: 'agent' }] }).id;
    const resolved = timerEntry({ phase: 'resolved', resolvedAt: iso(0) });
    store.commitWait(runId, resolved, { ...input(resolved.id), parentRunId: runId });
    store.commitParked(runId, stepId);
    const commits = vi.spyOn(store as unknown as { commitIndex(): void }, 'commitIndex');
    store.commitWaitDelivery(runId, [resolved.id], {}, true, stepId);
    expect(commits).toHaveBeenCalledTimes(1);
    const before = store.getRun(runId)!;
    reopen();
    for (const run of [before, store.getRun(runId)!]) {
      expect(run.status).toBe('running');
      expect(run.steps.find(step => step.id === stepId)?.status).toBe('running');
    }
  });

  it('commitWakeCounters writes the counters durably, not on the debounced save', () => {
    store.commitWakeCounters(id, { automaticWakes: 3 });
    expect(readPersistedRuns(directory).find((record) => record.id === id)?.automaticWakes).toBe(3);
    store.commitWakeCounters(id, { waitDeliveryFailures: 4 });
    store.commitWakeCounters(id, { waitDeliveryFailures: undefined });
    const row = readPersistedRuns(directory).find((record) => record.id === id);
    expect(row).toMatchObject({ automaticWakes: 3 });
    expect(row).not.toHaveProperty('waitDeliveryFailures');
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
      expect(run.waits).toEqual([expect.objectContaining({ id: legacyCi.id, kind: 'pr', phase: 'resolved', result })]);
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

// Phase 3a of hearsay-tools/cezarion#1235: an agent-registered `delegation.wait` reads up into
// the wait list. The completion gate's own wait stays in `delegation.wait` until phase 3b.
describe('upgrade-on-read of agent worker waits', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const WORKER = '22222222-2222-4222-8222-222222222222';
  const WAIT_ID = '33333333-3333-4333-8333-333333333333';
  const WAKE_ID = '44444444-4444-4444-8444-444444444444';
  const REQUEST = '55555555-5555-4555-8555-555555555555';

  const legacyWait = (overrides: Record<string, unknown> = {}) => ({
    id: WAIT_ID, workerIds: [WORKER], deadline: iso(540_000), phase: 'parked', outcomes: [], mode: 'any',
    revisions: [{ workerId: WORKER, revision: 2 }], ...overrides,
  });
  const outcome = { workerId: WORKER, status: 'review', observedAt: iso(-5_000), revision: 2 };
  const rootRow = (delegation: Record<string, unknown>, overrides: Record<string, unknown> = {}) => legacyRow({
    status: 'waiting', delegation: { role: 'root', permissions: ['wait'], receipts: [], ...delegation }, ...overrides,
  });
  const wakeInput = (id: string, overrides: Partial<AgentInput> = {}): AgentInput => ({
    id, parentRunId: RUN_ID, source: 'lifecycle', text: 'Worker wait', createdAt: iso(-1_000), ...overrides,
  });

  it('upgrades a registered or parked wait into an open worker entry', () => {
    for (const phase of ['registered', 'parked']) {
      const run = parseOne(rootRow({ wait: legacyWait({ phase }) }));
      expect(run.waits).toEqual([{
        id: WAIT_ID, kind: 'worker', source: 'agent', via: 'cez-worker-wait', phase: 'open', turnId: 'upgraded',
        registeredAt: iso(-60_000), deadline: iso(540_000), timeoutSeconds: 600, mode: 'any',
        workerIds: [WORKER], revisions: [{ workerId: WORKER, revision: 2 }], outcomes: [],
      }]);
      expect(run.delegation).not.toHaveProperty('wait');
      expect(run.status).toBe('waiting');
    }
  });

  it('upgrades a request wait into a requestIds entry', () => {
    const requestOutcomes = [{ requestId: REQUEST, status: 'replied', observedAt: iso(-1_000) }];
    const run = parseOne(rootRow({ wait: legacyWait({ workerIds: [], requestIds: [REQUEST], requestOutcomes, revisions: undefined }) }));
    expect(run.waits).toEqual([expect.objectContaining({ kind: 'worker', phase: 'open', requestIds: [REQUEST], requestOutcomes })]);
    expect(run.waits![0]).not.toHaveProperty('workerIds');
    expect(run.waits![0]).not.toHaveProperty('revisions');
    expect(run.lastWaitsError).toBeUndefined();
  });

  it('registers an upgraded wait 600 s before its deadline, whatever time it is read at', () => {
    // A legacy wait kept no registration time: the original deadline is kept, `timeoutSeconds` is
    // the 600 default, and nothing is read from the clock, so two reads of one row agree.
    const row = () => rootRow({ wait: legacyWait({ deadline: iso(7_200_000) }) });
    const first = parseOne(row());
    expect(first.waits![0]).toMatchObject({ deadline: iso(7_200_000), registeredAt: iso(6_600_000), timeoutSeconds: 600 });
    vi.setSystemTime(NOW + 3 * 3_600_000);
    expect(parseOne(row())).toEqual(first);
    expect(workerWaitEntry(legacyWait({ deadline: 'not a time' }) as never, new Date(NOW).toISOString())).toMatchObject({ timeoutSeconds: 600 });
  });

  it('upgrades every settled stamp from the row, never the clock', () => {
    const row = () => rootRow({
      wait: legacyWait({ phase: 'wake-pending', reason: 'cancelled', wakeId: WAKE_ID }),
      lastWait: legacyWait({ id: '88888888-8888-4888-8888-888888888888', phase: 'wake-pending', reason: 'timeout', wakeId: WAKE_ID }),
    }, { agentInputs: [wakeInput(WAKE_ID)] });
    const first = parseOne(row());
    expect(first.lastWaits).toEqual([
      expect.objectContaining({ id: '88888888-8888-4888-8888-888888888888', phase: 'cancelled', cancelledAt: iso(540_000) }),
      expect.objectContaining({ id: WAIT_ID, phase: 'cancelled', cancelledAt: iso(540_000) }),
    ]);
    vi.setSystemTime(NOW + 3 * 3_600_000);
    expect(parseOne(row())).toEqual(first);
  });

  it('upgrades wake-pending outcome and timeout into a resolved entry keeping its queued wake input', () => {
    for (const reason of ['outcome', 'timeout'] as const) {
      const run = parseOne(rootRow({ wait: legacyWait({ phase: 'wake-pending', reason, wakeId: WAKE_ID, outcomes: reason === 'outcome' ? [outcome] : [] }) },
        { agentInputs: [wakeInput(WAKE_ID)] }));
      expect(run.waits).toEqual([expect.objectContaining({ id: WAIT_ID, kind: 'worker', phase: 'resolved', result: { reason }, wakeInputId: WAKE_ID })]);
      expect(run.waits![0]!.resolvedAt).toBeDefined();
      expect(run.agentInputs).toEqual([wakeInput(WAKE_ID)]);
    }
  });

  it('upgraded wake-pending keeps its queued input', () => {
    const run = parseOne(rootRow(
      { wait: legacyWait({ phase: 'wake-pending', reason: 'outcome', wakeId: WAIT_ID, outcomes: [outcome] }), lastWait: legacyWait({ phase: 'wake-pending', reason: 'outcome', wakeId: WAIT_ID, outcomes: [outcome] }) },
      { agentInputs: [wakeInput(WAIT_ID)] },
    ));
    expect(run.waits).toEqual([expect.objectContaining({ id: WAIT_ID, phase: 'resolved', wakeInputId: WAIT_ID })]);
    // The settled copy that rode in lastWait is the same wait: it is not listed twice.
    expect(run.lastWaits).toBeUndefined();
    expect(run.agentInputs).toHaveLength(1);
    expect(run.agentInputs![0]).toEqual(wakeInput(WAIT_ID));
  });

  it('upgrades a wake-pending wait whose wake input was delivered as delivered', () => {
    const deliveredAt = iso(-500);
    const run = parseOne(rootRow({ wait: legacyWait({ phase: 'wake-pending', reason: 'outcome', wakeId: WAKE_ID, outcomes: [outcome] }) },
      { agentInputs: [wakeInput(WAKE_ID, { deliveredAt })] }));
    expect(run.waits).toBeUndefined();
    expect(run.lastWaits).toEqual([expect.objectContaining({ id: WAIT_ID, kind: 'worker', phase: 'delivered', deliveredAt, result: { reason: 'outcome' } })]);
  });

  it('upgrades wake-pending cancelled into lastWaits as cancelled and leaves its undelivered wake input queued', () => {
    const run = parseOne(rootRow({ wait: legacyWait({ phase: 'wake-pending', reason: 'cancelled', wakeId: WAKE_ID }) },
      { agentInputs: [wakeInput(WAKE_ID)] }));
    expect(run.waits).toBeUndefined();
    expect(run.lastWaits).toEqual([expect.objectContaining({ id: WAIT_ID, kind: 'worker', phase: 'cancelled', cancelledAt: iso(540_000) })]);
    expect(run.lastWaits![0]).not.toHaveProperty('result');
    expect(run.agentInputs).toEqual([wakeInput(WAKE_ID)]);
  });

  it('upgrades the message stand-in by dropping it and leaving its input queued', () => {
    const run = parseOne(rootRow({ wait: legacyWait({ phase: 'wake-pending', reason: 'message', wakeId: WAKE_ID }) },
      { agentInputs: [wakeInput(WAKE_ID, { source: 'agent' })] }));
    expect(run.waits).toBeUndefined();
    expect(run.lastWaits).toBeUndefined();
    expect(run.delegation).not.toHaveProperty('wait');
    expect(run.agentInputs).toEqual([wakeInput(WAKE_ID, { source: 'agent' })]);
  });

  it('reads a waiting run whose message stand-in a provider took as interrupted, and one an inbox read or a question holds as parked', () => {
    const deliveredAt = iso(-500);
    const standIn = { wait: legacyWait({ workerIds: [], revisions: undefined, phase: 'wake-pending', reason: 'message', wakeId: WAKE_ID }) };
    const message = (overrides: Partial<AgentInput> = {}) => wakeInput(WAKE_ID, { source: 'agent', deliveredAt, ...overrides });
    const parked = [{ id: 'main', name: 'main', kind: 'agent', status: 'waiting', iterations: 1, tokensUsed: 0 }];
    const resumed = parseOne(rootRow(standIn, { agentInputs: [message()], steps: parked }));
    expect(resumed.status).toBe('running');
    expect(resumed.steps[0]!.status).toBe('running');
    expect(resumed.delegation).not.toHaveProperty('wait');
    const claim = { receiptId: randomUUID(), generation: randomUUID(), expiresAt: iso(0), acknowledgedAt: iso(-400) };
    expect(parseOne(rootRow(standIn, { agentInputs: [message({ inboxClaim: claim })] })).status).toBe('waiting');
    expect(parseOne(rootRow(standIn, { agentInputs: [message()], hasPendingHumanAsk: true })).status).toBe('waiting');
    expect(parseOne(rootRow(standIn, { agentInputs: [message({ deliveredAt: undefined })] })).status).toBe('waiting');
  });

  it('upgrades lastWait into lastWaits, delivered when its wake input was delivered and cancelled otherwise', () => {
    const deliveredAt = iso(-500);
    const delivered = parseOne(rootRow({ lastWait: legacyWait({ phase: 'wake-pending', reason: 'outcome', wakeId: WAKE_ID, outcomes: [outcome] }) },
      { status: 'done', agentInputs: [wakeInput(WAKE_ID, { deliveredAt })] }));
    expect(delivered.lastWaits).toEqual([expect.objectContaining({ id: WAIT_ID, kind: 'worker', phase: 'delivered', deliveredAt })]);
    expect(delivered.delegation).not.toHaveProperty('lastWait');
    for (const agentInputs of [[wakeInput(WAKE_ID)], undefined]) {
      const run = parseOne(rootRow({ lastWait: legacyWait({ phase: 'wake-pending', reason: 'timeout', wakeId: WAKE_ID }) }, { status: 'done', ...(agentInputs ? { agentInputs } : {}) }));
      expect(run.lastWaits).toEqual([expect.objectContaining({ id: WAIT_ID, phase: 'cancelled' })]);
    }
  });

  it('upgrades a parked completion wait into a cezar worker entry and drops completion', () => {
    const wait = legacyWait({ mode: 'all', deadline: iso(600_000), workerIds: [WORKER, REQUEST], revisions: undefined });
    const row = rootRow({ wait, completion: { phase: 'waiting', waitId: WAIT_ID } });
    const run = parseOne(row);
    expect(run.waits).toEqual([{
      id: WAIT_ID, kind: 'worker', source: 'cezar', via: 'completion', phase: 'open', turnId: 'upgraded',
      registeredAt: iso(0), deadline: iso(600_000), timeoutSeconds: 600, mode: 'all',
      workerIds: [WORKER, REQUEST], revisions: [], outcomes: [],
    }]);
    expect(run.delegation).not.toHaveProperty('wait');
    expect(run.delegation).not.toHaveProperty('lastWait');
    expect(run.delegation).not.toHaveProperty('completion');
    expect(run.lastWaitsError).toBeUndefined();
    expect(run.status).toBe('waiting');
    // The agent's own wait beside it upgrades as an agent entry.
    const other = '66666666-6666-4666-8666-666666666666';
    const both = parseOne(rootRow({ wait, lastWait: legacyWait({ id: other, phase: 'wake-pending', reason: 'outcome', wakeId: other, outcomes: [outcome] }), completion: { phase: 'waiting', waitId: WAIT_ID } }));
    expect(both.waits).toEqual([expect.objectContaining({ id: WAIT_ID, source: 'cezar', via: 'completion' })]);
    expect(both.lastWaits).toEqual([expect.objectContaining({ id: other, kind: 'worker', source: 'agent' })]);
    // A completion marker with no wait behind it is only dropped.
    const bare = parseOne(rootRow({ completion: { phase: 'attention' } }));
    expect(bare.delegation).not.toHaveProperty('completion');
    expect(bare.waits).toBeUndefined();
  });

  it('upgrades a wake-pending completion wait keeping its queued input', () => {
    const wait = legacyWait({ mode: 'all', phase: 'wake-pending', reason: 'outcome', wakeId: WAKE_ID, outcomes: [outcome] });
    const run = parseOne(rootRow({ wait, completion: { phase: 'waiting', waitId: WAIT_ID } }, { agentInputs: [wakeInput(WAKE_ID)] }));
    expect(run.waits).toEqual([expect.objectContaining({
      id: WAIT_ID, source: 'cezar', via: 'completion', phase: 'resolved', result: { reason: 'outcome' }, wakeInputId: WAKE_ID, deadline: iso(540_000), timeoutSeconds: 600,
    })]);
    expect(run.delegation).not.toHaveProperty('wait');
    expect(run.delegation).not.toHaveProperty('completion');
    // A wake the provider already took settles it as delivered.
    const done = parseOne(rootRow({ wait, completion: { phase: 'waiting', waitId: WAIT_ID } }, { agentInputs: [wakeInput(WAKE_ID, { deliveredAt: iso(-500) })] }));
    expect(done.waits).toBeUndefined();
    expect(done.lastWaits).toEqual([expect.objectContaining({ id: WAIT_ID, source: 'cezar', via: 'completion', phase: 'delivered' })]);
  });

  it('restart keeps a deadline-less completion wait and wakes on settlement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cez-waits-completion-'));
    const entry = {
      id: WAIT_ID, kind: 'worker' as const, source: 'cezar' as const, via: 'completion' as const, phase: 'open' as const, turnId: 'turn',
      registeredAt: iso(0), mode: 'all' as const, workerIds: [WORKER], revisions: [], outcomes: [],
    };
    seedRuns(directory, [rootRow({}, { waits: [entry] })]);
    let store = RunStore.open(directory, { keepLive: true });
    const reopen = () => { store.close(); store = RunStore.open(directory, { keepLive: true }); return store.getRun(RUN_ID)!; };
    try {
      const reopened = reopen();
      expect(reopened.lastWaitsError).toBeUndefined();
      expect(reopened.waits).toEqual([entry]);
      expect(holdsWorkerWait(reopened)).toBe(true);
      // Settling after the reopen resolves it once, and the same wake input is appended once.
      const resolved = { ...entry, phase: 'resolved' as const, resolvedAt: iso(1_000), result: { reason: 'outcome' as const }, wakeInputId: WAKE_ID };
      store.commitWait(RUN_ID, resolved, wakeInput(WAKE_ID));
      store.commitWait(RUN_ID, resolved, wakeInput(WAKE_ID));
      const after = reopen();
      expect(after.waits).toEqual([resolved]);
      expect(after.agentInputs?.filter((input) => input.id === WAKE_ID)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a worker run\'s own wait on its requests', () => {
    const run = parseOne(legacyRow({
      status: 'waiting',
      delegation: {
        role: 'worker', permissions: ['wait'], parentRunId: '77777777-7777-4777-8777-777777777777',
        workspace: { path: '/tmp/w', branch: 'cez/w', baselineSha: 'a'.repeat(40) },
        wait: legacyWait({ workerIds: [], requestIds: [REQUEST], requestOutcomes: [], revisions: undefined }),
      },
    }));
    expect(run.waits).toEqual([expect.objectContaining({ kind: 'worker', requestIds: [REQUEST], phase: 'open' })]);
    expect(run.delegation).not.toHaveProperty('wait');
  });

  it('marks an upgraded row so open rewrites it, and the rewrite is stable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cez-waits-worker-'));
    try {
      seedRuns(directory, [rootRow({ wait: legacyWait() })]);
      const store = RunStore.open(directory, { keepLive: true });
      try {
        expect(store.getRun(RUN_ID)!.waits).toEqual([expect.objectContaining({ id: WAIT_ID, kind: 'worker', phase: 'open' })]);
        store.flush();
      } finally {
        store.close();
      }
      const [stored] = readPersistedRuns(directory);
      expect((stored.delegation as Record<string, unknown>)).not.toHaveProperty('wait');
      expect(stored.waits).toEqual([expect.objectContaining({ id: WAIT_ID, kind: 'worker' })]);
      const again = RunStore.open(directory, { keepLive: true });
      try {
        expect(again.getRun(RUN_ID)!.waits).toEqual([expect.objectContaining({ id: WAIT_ID })]);
      } finally {
        again.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('a store at schema 7 or later is refused by a schema-6 reader', () => {
    expect(RUN_DATABASE_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    const directory = mkdtempSync(join(tmpdir(), 'cez-waits-schema6-'));
    try {
      RunStore.open(directory, { keepLive: true }).close();
      const path = join(directory, RUNS_DB_FILE);
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: RUN_DATABASE_SCHEMA_VERSION });
      } finally {
        raw.close();
      }
      // A schema-6 build's bound is 6: both of its openers must refuse a schema-7 store rather than
      // read it, because it would drop each deadline-less completion entry as unreadable on its next write.
      expect(() => RunDatabase.open(path, 6)).toThrow(RunDatabaseUnsupportedSchemaError);
      expect(() => RunDatabase.openReadOnly(path, 6)).toThrow(RunDatabaseUnsupportedSchemaError);
      expect(() => RunDatabase.open(path, 6)).toThrow(expect.objectContaining({ kind: 'unsupported-schema', found: RUN_DATABASE_SCHEMA_VERSION, supported: 6 }));
      // This build still opens it.
      RunDatabase.open(path).close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the summary and live column of an upgraded worker wait', () => {
  const WORKER = '22222222-2222-4222-8222-222222222222';
  const WAIT_ID = '33333333-3333-4333-8333-333333333333';
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'cez-waits-worker-summary-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  const stored = (wait: Record<string, unknown>, delegation: Record<string, unknown> = {}) => legacyRow({
    status: 'waiting', delegation: { role: 'root', permissions: ['wait'], receipts: [], wait, ...delegation },
  });
  const parked = { id: WAIT_ID, workerIds: [WORKER], deadline: new Date(Date.now() + 3_600_000).toISOString(), phase: 'parked', outcomes: [] };

  it('rewrites an agent wait without delegation.wait and keeps the row live', () => {
    seedRuns(directory, [stored(parked)]);
    const store = RunStore.open(directory, { keepLive: true });
    try { store.flush(); } finally { store.close(); }
    const db = RunDatabase.openReadOnly(join(directory, RUNS_DB_FILE))!;
    try {
      expect(db.get(RUN_ID)!.live).toBe(true);
      const summary = JSON.parse(db.listAll()[0]!.summary);
      expect(summary.delegation ?? {}).not.toHaveProperty('wait');
      expect(summary.waitingOn).toMatchObject({ kind: 'workers' });
    } finally {
      db.close();
    }
  });

  it('reads the completion wait into the list, and the summary keeps no delegation.wait', () => {
    seedRuns(directory, [stored(parked, { completion: { phase: 'waiting', waitId: WAIT_ID } })]);
    const store = RunStore.open(directory, { keepLive: true });
    try { store.flush(); } finally { store.close(); }
    const db = RunDatabase.openReadOnly(join(directory, RUNS_DB_FILE))!;
    try {
      expect(db.get(RUN_ID)!.live).toBe(true);
      const summary = JSON.parse(db.listAll()[0]!.summary);
      expect(summary.delegation ?? {}).not.toHaveProperty('wait');
      expect(summary.waitingOn).toMatchObject({ kind: 'workers' });
    } finally {
      db.close();
    }
  });

  it('reads a stored finished root\'s old wait cold as a worker entry, with no delegation.wait in its summary', () => {
    seedRuns(directory, [{ ...stored(parked), status: 'cancelled', finishedAt: new Date().toISOString() }]);
    const [summary] = readRunIndexFromDisk(directory).runs;
    expect(summary!.delegation ?? {}).not.toHaveProperty('wait');
  });
});
