import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInput, CiWait } from '@open-mercato/cezar-contract';
import { RunStore } from './store.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import { readPersistedRuns, readPersistedText, runIds, seedRuns } from './run-store.testkit.ts';

// The legacy CI checkpoints, now thin wrappers over the wait list (store schema 4, unified waits):
// a CI wait lives in `waits` and settles into `lastWaits`.
describe('atomic CI wait checkpoints', () => {
  let directory: string;
  let store: RunStore;
  let id: string;
  let wait: CiWait;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cez-ci-store-'));
    store = RunStore.open(directory, { keepLive: true });
    id = store.createRun({ title: 'CI', workflow: 'quick-task', task: 'wait', steps: [] }).id;
    store.updateRun(id, { status: 'running' });
    wait = { id: randomUUID(), generation: 'session', turnId: 'turn', prUrl: 'https://github.com/acme/repo/pull/12',
      repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40), registeredAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 30_000).toISOString(), timeoutSeconds: 30, phase: 'registered' };
  });
  afterEach(() => { vi.restoreAllMocks(); store.flush(); rmSync(directory, { recursive: true, force: true }); });
  const input = (runId: string, waitId: string): AgentInput => ({ id: waitId, parentRunId: runId, source: 'lifecycle', text: 'CI observation', createdAt: new Date().toISOString() });

  it('publishes neither registration nor event if the durable replacement fails', () => {
    store.flush();
    const disk = readPersistedText(directory);
    const events = vi.fn(); store.on('run', events);
    vi.spyOn(store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw new Error('read only'); });
    expect(() => store.commitCiWait(id, wait)).toThrow('read only');
    expect(store.getRun(id)?.waits).toBeUndefined();
    expect(events).not.toHaveBeenCalled();
    expect(readPersistedText(directory)).toBe(disk);
  });

  it('settlement and deterministic queue entry survive reopen with no duplicate input', () => {
    const settled: CiWait = { ...wait, phase: 'wake-pending', wakeId: wait.id, result: {
      outcome: 'deadline', headSha: wait.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
    } };
    store.commitCiWait(id, settled, input(id, wait.id));
    store.commitCiWait(id, settled, input(id, wait.id));
    const reopened = RunStore.open(directory, { keepLive: true });
    expect(reopened.getRun(id)?.waits).toEqual([expect.objectContaining({ id: wait.id, kind: 'ci', phase: 'resolved', result: expect.objectContaining({ outcome: 'deadline' }) })]);
    expect(reopened.getRun(id)?.agentInputs).toHaveLength(1);
  });

  it('checkpointing delivery retires current intent atomically and preserves the stable receipt', () => {
    store.commitCiWait(id, { ...wait, phase: 'wake-pending', wakeId: wait.id }, input(id, wait.id));
    store.commitCiWaitDelivery(id, wait.id);
    const record = RunStore.open(directory, { keepLive: true }).getRun(id);
    expect(store.getRun(id)?.waits).toBeUndefined();
    expect(record?.waits).toBeUndefined();
    expect(record?.lastWaits).toEqual([expect.objectContaining({ id: wait.id, phase: 'delivered' })]);
    expect(record?.agentInputs?.[0]?.deliveredAt).toBe(record?.lastWaits?.[0]?.deliveredAt);
  });

  // Store schema 4 salvages a legacy CI wait like any wait entry: dropped, `lastWaitsError` set,
  // and the status left alone, so the run reads as parked with nothing open (Needs you), not failed.
  it('a corrupt persisted wait retains the registry and records the salvage', () => {
    store.close();
    const records = readPersistedRuns(directory);
    records[0].status = 'waiting';
    records[0].ciWait = { phase: 'parked', deadline: 'invalid' };
    seedRuns(directory, records);
    const indexed = readRunIndexFromDisk(directory).runs;
    expect(indexed).toHaveLength(1);
    const reopened = RunStore.open(directory, { keepLive: true });
    expect(runIds(reopened)).toHaveLength(1);
    expect(reopened.getRun(id)).toMatchObject({ status: 'waiting', lastWaitsError: expect.stringContaining('unreadable') });
    expect(reopened.getRun(id)?.error).toBeUndefined();
    expect(reopened.getRun(id)?.waits).toBeUndefined();
    expect(reopened.getRun(id)).not.toHaveProperty('ciWait');
    store = reopened;
  });
  it.each(['running', 'done'] as const)('retains an unreadable previous observation for %s runs across repeated reads', (status) => {
    // The reopen below is a restart: this store goes first, or it still owns the running run.
    store.updateRun(id, { status }); store.close();
    const records = readPersistedRuns(directory);
    records[0].lastCiWait = { ...wait, phase: 'delivered', result: { outcome: 'passed' } };
    seedRuns(directory, records);
    const reopened = RunStore.open(directory, { keepLive: true });
    expect(reopened.getRun(id)?.status).toBe(status);
    // The read-only index intentionally marks orphan running records failed. It answers list rows,
    // which carry no CI observation; the salvaged field is the store's to keep.
    expect(readRunIndexFromDisk(directory).runs[0]?.status).toBe(status === 'running' ? 'failed' : status);
    expect(reopened.getRun(id)).toMatchObject({ lastWaitsError: expect.stringContaining('saved wait is unreadable') });
    expect(reopened.getRun(id)?.lastWaits).toBeUndefined();
    reopened.flush();
    expect(RunStore.open(directory, { keepLive: true }).getRun(id)?.lastWaitsError).toContain('unreadable');
    reopened.commitCiWait(id, wait);
    expect(reopened.getRun(id)?.lastWaitsError).toBeUndefined();
    expect(RunStore.open(directory, { keepLive: true }).getRun(id)?.lastWaitsError).toBeUndefined();
  });

});
