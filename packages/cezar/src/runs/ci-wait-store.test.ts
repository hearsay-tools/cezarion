import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInput, CiWait } from '@open-mercato/cezar-contract';
import { RunStore } from './store.ts';
import { readRunIndexFromDisk } from './run-index.ts';

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
    const disk = readFileSync(join(directory, 'runs.json'), 'utf8');
    const events = vi.fn(); store.on('run', events);
    vi.spyOn(store as unknown as { writeIndex(): void }, 'writeIndex').mockImplementation(() => { throw new Error('read only'); });
    expect(() => store.commitCiWait(id, wait)).toThrow('read only');
    expect(store.getRun(id)?.ciWait).toBeUndefined();
    expect(events).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'runs.json'), 'utf8')).toBe(disk);
  });

  it('settlement and deterministic queue entry survive reopen with no duplicate input', () => {
    const settled: CiWait = { ...wait, phase: 'wake-pending', wakeId: wait.id, result: {
      outcome: 'deadline', headSha: wait.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false,
    } };
    store.commitCiWait(id, settled, input(id, wait.id));
    store.commitCiWait(id, settled, input(id, wait.id));
    const reopened = RunStore.open(directory, { keepLive: true });
    expect(reopened.getRun(id)?.ciWait?.result?.outcome).toBe('deadline');
    expect(reopened.getRun(id)?.agentInputs).toHaveLength(1);
  });

  it('withdrawal retires the wait and pending lifecycle input while retaining the human message', () => {
    store.commitCiWait(id, { ...wait, phase: 'wake-pending', wakeId: wait.id }, input(id, wait.id));
    const human = { id: randomUUID(), text: 'change direction', createdAt: new Date().toISOString() };
    store.commitCiWaitWithdrawal(id, human);
    for (const record of [store.getRun(id), RunStore.open(directory, { keepLive: true }).getRun(id)]) {
      expect(record?.ciWait).toBeUndefined();
      expect(record?.lastCiWait?.phase).toBe('withdrawn');
      expect(record?.agentInputs).toEqual([]);
      expect(record?.queuedMessages).toEqual([human]);
    }
  });

  it('checkpointing delivery retires current intent atomically and preserves the stable receipt', () => {
    store.commitCiWait(id, { ...wait, phase: 'wake-pending', wakeId: wait.id }, input(id, wait.id));
    store.commitCiWaitDelivery(id, wait.id);
    const record = RunStore.open(directory, { keepLive: true }).getRun(id);
    expect(store.getRun(id)?.ciWait).toBeUndefined();
    expect(record?.ciWait).toBeUndefined();
    expect(record?.lastCiWait).toMatchObject({ id: wait.id, phase: 'delivered' });
    expect(record?.agentInputs?.[0]?.deliveredAt).toBe(record?.lastCiWait?.deliveredAt);
  });

  it('a corrupt persisted wait retains the registry and requests human attention', () => {
    store.flush();
    const records = JSON.parse(readFileSync(join(directory, 'runs.json'), 'utf8'));
    records[0].ciWait = { phase: 'parked', deadline: 'invalid' };
    writeFileSync(join(directory, 'runs.json'), JSON.stringify(records));
    const indexed = readRunIndexFromDisk(directory);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('CI wait state is unreadable') });
    const reopened = RunStore.open(directory, { keepLive: true });
    expect(reopened.listRuns()).toHaveLength(1);
    expect(reopened.getRun(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('CI wait state is unreadable') });
    expect(reopened.getRun(id)?.ciWait).toBeUndefined();
  });
  it.each(['running', 'done'] as const)('retains an unreadable previous observation for %s runs across repeated reads', (status) => {
    store.updateRun(id, { status }); store.flush();
    const records = JSON.parse(readFileSync(join(directory, 'runs.json'), 'utf8'));
    records[0].lastCiWait = { ...wait, phase: 'delivered', result: { outcome: 'passed' } };
    writeFileSync(join(directory, 'runs.json'), JSON.stringify(records));
    const reopened = RunStore.open(directory, { keepLive: true });
    expect(reopened.getRun(id)?.status).toBe(status);
    // The read-only index intentionally marks orphan running records failed.
    expect(readRunIndexFromDisk(directory)[0]?.status).toBe(status === 'running' ? 'failed' : status);
    for (const record of [readRunIndexFromDisk(directory)[0], reopened.getRun(id)]) {
      expect(record).toMatchObject({ lastCiWaitError: expect.stringContaining('saved observation is unreadable') });
      expect(record?.lastCiWait).toBeUndefined();
    }
    reopened.flush();
    expect(RunStore.open(directory, { keepLive: true }).getRun(id)?.lastCiWaitError).toContain('unreadable');
    reopened.commitCiWait(id, wait);
    expect(reopened.getRun(id)?.lastCiWaitError).toBeUndefined();
    expect(RunStore.open(directory, { keepLive: true }).getRun(id)?.lastCiWaitError).toBeUndefined();
  });

});
