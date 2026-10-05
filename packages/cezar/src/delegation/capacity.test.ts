import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkerDestroy } from '@open-mercato/cezar-contract';
import { runRecordSchema, type RunRecord } from '../runs/store.ts';
import { capacityError, workerCapacity, WORKER_CAPACITY, WORKER_CREATION_LIMIT } from './capacity.ts';

const now = '2026-10-04T12:00:00.000Z';
const parentId = randomUUID();
type Receipt = { requestId: string; workerId: string; requestHash: string; deletion?: { phase: 'pending' | 'complete'; revision: number; resourceId: string; generation: string } };

function receipt(workerId: string, deletion?: 'pending' | 'complete'): Receipt {
  return { requestId: randomUUID(), workerId, requestHash: 'b'.repeat(64),
    ...(deletion ? { deletion: { phase: deletion, revision: 0, resourceId: randomUUID(), generation: randomUUID() } } : {}) };
}
function parent(receipts: Receipt[]): RunRecord {
  return runRecordSchema.parse({ id: parentId, title: 'parent', task: 'task', workflow: 'quick-task', status: 'running',
    createdAt: now, tokensUsed: 0, steps: [], delegation: { role: 'root', permissions: ['spawn'], receipts } });
}
function worker(id: string, status: RunRecord['status'], destroy?: WorkerDestroy): RunRecord {
  return runRecordSchema.parse({ id, title: 'worker', task: 'task', workflow: 'quick-task', status, createdAt: now, tokensUsed: 0, steps: [],
    delegation: { role: 'worker', parentRunId: parentId, permissions: [],
      workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
      ...(destroy ? { destroy } : {}) } });
}
const destroy = (phase: WorkerDestroy['phase'], remaining: WorkerDestroy['remaining'] = []): WorkerDestroy => ({ requestedAt: now, phase, remaining });

describe('workerCapacity', () => {
  it('counts accepted, live, settled and not-verifiably-destroyed workers as outstanding', () => {
    const runs = [
      worker(randomUUID(), 'queued'), worker(randomUUID(), 'running'), worker(randomUUID(), 'done'),
      worker(randomUUID(), 'done', destroy('cleaning', ['worktree'])),
      worker(randomUUID(), 'done', destroy('incomplete', ['branch'])),
      // A complete phase that still names a remaining resource is not a verified destroy.
      worker(randomUUID(), 'done', destroy('complete', ['branch'])),
    ];
    const byId = new Map(runs.map(run => [run.id, run]));
    expect(workerCapacity(parent(runs.map(run => receipt(run.id))), id => byId.get(id)))
      .toEqual({ outstanding: 6, limit: WORKER_CAPACITY, created: 6, creationLimit: WORKER_CREATION_LIMIT });
  });

  it('releases a verified complete destroy and a history-deleted receipt', () => {
    const destroyed = worker(randomUUID(), 'done', destroy('complete'));
    const live = worker(randomUUID(), 'running');
    const byId = new Map([destroyed, live].map(run => [run.id, run]));
    const receipts = [receipt(destroyed.id), receipt(live.id), receipt(randomUUID(), 'pending'), receipt(randomUUID(), 'complete')];
    expect(workerCapacity(parent(receipts), id => byId.get(id))).toMatchObject({ outstanding: 1, created: 4 });
  });

  it('keeps a receipt whose record vanished without a deletion marker outstanding', () => {
    expect(workerCapacity(parent([receipt(randomUUID())]), () => undefined)).toMatchObject({ outstanding: 1, created: 1 });
  });

  it('reports zero usage for a run that is not a delegation root', () => {
    const run = worker(randomUUID(), 'running');
    expect(workerCapacity(run, () => undefined)).toEqual({ outstanding: 0, limit: 32, created: 0, creationLimit: 1024 });
  });
});

describe('capacityError', () => {
  const base = { limit: 32, creationLimit: 1024 };
  it('names the creation ceiling first, even with free capacity', () => {
    expect(capacityError({ ...base, outstanding: 0, created: 1024 }))
      .toBe('Parent reached 1,024 worker creations; start a new task to delegate further');
  });
  it('names the recovery at 32 outstanding workers', () => {
    expect(capacityError({ ...base, outstanding: 32, created: 40 }))
      .toBe('Parent has 32 outstanding workers (accepted, live, or not verifiably destroyed). Collect results, then destroy finished workers to free capacity; incomplete cleanup holds its slot until a retry completes');
  });
  it('admits a creation below both limits', () => {
    expect(capacityError({ ...base, outstanding: 31, created: 1023 })).toBeUndefined();
  });
});
