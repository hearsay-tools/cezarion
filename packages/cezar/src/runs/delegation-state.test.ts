import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentInputSchema, agentInputEventSchema, delegationStateSchema, runRelationshipsSchema,
  workerDestroySchema, workerDestroyResultSchema, workerDiffSchema, workerInspectionSchema,
  workerOperationSchema, workerOutcomeSchema, workerSpawnRequestSchema, workerSteerRequestSchema,
  workerStopResultSchema, workerWaitRequestSchema, workerWaitSchema, workerWorkspaceSchema,
  delegationErrorResponseSchema,
} from '@open-mercato/cezar-contract';
import type { DelegationState } from '@open-mercato/cezar-contract';
import { RunStore, runRecordSchema } from './store.ts';

const workerId = randomUUID();
const requestId = randomUUID();
const parentRunId = randomUUID();
const baselineSha = 'a'.repeat(40);
const requestHash = 'b'.repeat(64);
const now = '2026-09-06T12:00:00.000Z';
const workspace = {
  ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated' as const,
  path: `/managed/${workerId}`, branch: `cez/${workerId.slice(0, 8)}`, baselineSha,
};
const root: DelegationState = { role: 'root', permissions: ['spawn', 'wait'], receipts: [] };
const outcome = { workerId, status: 'done' as const, observedAt: now };
const wait = { id: randomUUID(), workerIds: [workerId], deadline: now, phase: 'registered', outcomes: [] };
const destruction = { requestedAt: now, phase: 'requested', remaining: ['process', 'worktree', 'branch'] };
const input = { title: 'fix tests', task: 'fix tests', workflow: 'quick-task', steps: [] };
function worker(parentId: string = parentRunId, id: string = workerId): DelegationState {
  return {
    role: 'worker', parentRunId: parentId, permissions: [],
    workspace: { ...workspace, ownerRunId: id, resourceId: randomUUID(), path: `/managed/${id}`, branch: `cez/${id.slice(0, 8)}` },
  };
}

describe('delegation schemas', () => {
  it('bounds and defaults unique wait selections without accepting caller identity', () => {
    expect(workerWaitRequestSchema.parse({ workerIds: [workerId] }).timeoutSeconds).toBe(600);
    expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId], timeoutSeconds: 1801 }).success).toBe(false);
    for (const body of [
      { workerIds: [] }, { workerIds: [workerId, workerId] },
      { workerIds: Array.from({ length: 33 }, () => randomUUID()) }, { workerIds: ['bad'] },
      { workerIds: [workerId], timeoutSeconds: 0 }, { workerIds: [workerId], timeoutSeconds: 1.5 },
      { workerIds: [workerId], parentRunId },
    ]) expect(workerWaitRequestSchema.safeParse(body).success).toBe(false);
    expect(workerWaitRequestSchema.parse({ workerIds: [workerId], timeoutSeconds: 1800 }).timeoutSeconds).toBe(1800);
  });

  it('requires a bounded spawn task, explicit baseline and UUID retry ID with no elevation fields', () => {
    const spawn = { task: 'fix tests', requestId, baseline: 'parent-head' };
    expect(workerSpawnRequestSchema.parse(spawn)).toEqual(spawn);
    expect(workerSpawnRequestSchema.safeParse({ task: 'fix tests', requestId, baseline: 'parent-head', parentRunId: workerId }).success).toBe(false);
    for (const patch of [
      { requestId: 'bad' }, { baseline: undefined }, { baseline: '' }, { baseline: 'x'.repeat(1025) },
      { task: '' }, { task: 'x'.repeat(100001) }, { requestHash }, { env: {} },
      { path: '/tmp' }, { permissions: ['spawn'] }, { worktree: false }, { runner: 'codex' },
    ]) expect(workerSpawnRequestSchema.safeParse({ ...spawn, ...patch }).success).toBe(false);
    expect(workerSpawnRequestSchema.safeParse({ ...spawn, task: 'x'.repeat(100000) }).success).toBe(true);
  });

  it('accepts only nonempty bounded steering, not human answers or attachments', () => {
    expect(workerSteerRequestSchema.parse({ text: 'use the unit test' })).toEqual({ text: 'use the unit test' });
    for (const body of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(100001) }, { text: 'ok', images: [] }, { text: 'ok', parentRunId }]) {
      expect(workerSteerRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('discriminates operations, roles and validated owned workspace identity', () => {
    expect(workerOperationSchema.options).toEqual(['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait']);
    expect(workerOperationSchema.safeParse('merge').success).toBe(false);
    expect(delegationStateSchema.parse(root)).toEqual(root);
    expect(delegationStateSchema.parse({ ...root, finishRequestedAt: now })).toMatchObject({ finishRequestedAt: now });
    expect(delegationStateSchema.safeParse({ ...root, finishRequestedAt: 'tomorrow' }).success).toBe(false);
    expect(delegationStateSchema.parse(worker())).toMatchObject({ role: 'worker', permissions: [] });
    expect(delegationStateSchema.parse({ role: 'invalid' })).toEqual({ role: 'invalid' });
    for (const value of [{ role: 'other' }, { ...root, permissions: ['merge'] }, { role: 'worker', permissions: [] }]) {
      expect(delegationStateSchema.safeParse(value).success).toBe(false);
    }
    expect(workerWorkspaceSchema.parse(workspace)).toEqual(workspace);
    for (const patch of [
      { ownerRunId: 'bad' }, { resourceId: 'bad' }, { kind: 'shared' }, { path: '' }, { branch: '' },
      { baselineSha: 'abc123' }, { baselineSha: 'z'.repeat(40) },
    ]) expect(workerWorkspaceSchema.safeParse({ ...workspace, ...patch }).success).toBe(false);
    expect(workerWorkspaceSchema.safeParse({ ...workspace, baselineSha: 'a'.repeat(64) }).success).toBe(true);
  });

  it('validates wait, terminal outcome, destruction phases and timestamps', () => {
    expect(workerWaitSchema.parse(wait)).toEqual(wait);
    expect(workerWaitSchema.safeParse({ ...wait, phase: 'wake-pending', wakeId: randomUUID(), outcomes: [outcome] }).success).toBe(true);
    expect(workerOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(workerDestroySchema.parse(destruction)).toEqual(destruction);
    for (const patch of [{ deadline: 'yesterday' }, { phase: 'done' }, { wakeId: 'bad' }, { id: 'bad' }]) {
      expect(workerWaitSchema.safeParse({ ...wait, ...patch }).success).toBe(false);
    }
    for (const patch of [{ status: 'running' }, { observedAt: 'yesterday' }, { workerId: 'bad' }, { summary: 'x'.repeat(4001) }]) {
      expect(workerOutcomeSchema.safeParse({ ...outcome, ...patch }).success).toBe(false);
    }
    for (const patch of [{ requestedAt: 'yesterday' }, { phase: 'done' }, { remaining: ['cwd'] }, { error: 'x'.repeat(2001) }]) {
      expect(workerDestroySchema.safeParse({ ...destruction, ...patch }).success).toBe(false);
    }
  });

  it('bounds unique creation receipts and validates request hashes', () => {
    const receipt = { requestId, workerId, requestHash };
    expect(delegationStateSchema.parse({ ...root, receipts: [receipt] })).toMatchObject({ receipts: [receipt] });
    for (const receipts of [
      [{ ...receipt, requestHash: 'bad' }], [{ ...receipt, requestId: 'bad' }],
      [receipt, receipt], [receipt, { ...receipt, requestId: randomUUID() }],
      Array.from({ length: 33 }, () => ({ ...receipt, requestId: randomUUID(), workerId: randomUUID() })),
    ]) expect(delegationStateSchema.safeParse({ ...root, receipts }).success).toBe(false);
  });

  it('retains attributed input in records and typed transcript events', () => {
    const agentInput = { id: randomUUID(), source: 'agent', parentRunId, text: 'use tests', createdAt: now };
    expect(agentInputSchema.parse(agentInput)).toEqual(agentInput);
    expect(agentInputSchema.safeParse({ ...agentInput, source: 'human' }).success).toBe(false);
    expect(agentInputSchema.safeParse({ ...agentInput, deliveredAt: 'yesterday' }).success).toBe(false);
    expect(agentInputEventSchema.parse({ seq: 1, ts: now, type: 'agent-input', input: agentInput })).toMatchObject({ input: agentInput });
    const record = { ...input, id: workerId, status: 'queued', createdAt: now, tokensUsed: 0, agentInputs: [agentInput] };
    expect(runRecordSchema.parse(record).agentInputs).toEqual([agentInput]);
    expect(runRecordSchema.parse(record).delegation).toBeUndefined();
  });

  it('describes bounded inspection, relationships, diff and explicit operation outcomes', () => {
    const inspection = { workerId, parentRunId, status: 'done', workspace, outcome };
    expect(workerInspectionSchema.parse(inspection)).toEqual(inspection);
    expect(runRelationshipsSchema.parse({ workers: [inspection] })).toEqual({ workers: [inspection] });
    expect(runRelationshipsSchema.safeParse({ workers: Array(33).fill(inspection) }).success).toBe(false);
    expect(workerDiffSchema.parse({ workerId, baselineSha, diff: '', truncated: false }).diff).toBe('');
    expect(workerDiffSchema.safeParse({ workerId, baselineSha, diff: 'x'.repeat(400001), truncated: true }).success).toBe(false);
    expect(workerStopResultSchema.safeParse({ workerId, state: 'stopping' }).success).toBe(true);
    expect(workerStopResultSchema.safeParse({ workerId, state: 'done' }).success).toBe(false);
    expect(workerDestroyResultSchema.safeParse({ workerId, state: 'incomplete', remaining: ['branch'] }).success).toBe(true);
    expect(workerDestroyResultSchema.safeParse({ workerId, state: 'complete', remaining: [] }).success).toBe(true);
    expect(delegationErrorResponseSchema.safeParse({ code: 'denied_scope', error: 'not owned' }).success).toBe(true);
    expect(delegationErrorResponseSchema.safeParse({ code: 'oops', error: 'bad' }).success).toBe(false);
  });
});

describe('RunStore durable delegation', () => {
  let dataDir: string;
  let store: RunStore;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-delegation-'));
    store = RunStore.open(dataDir, { keepLive: true });
  });
  afterEach(() => {
    store.flush();
    rmSync(dataDir, { recursive: true, force: true });
  });
  function parent() {
    const run = store.createRun(input);
    store.commitDelegation([{ id: run.id, delegation: root }]);
    return run;
  }
  function disk() { return JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8')); }

  it('atomically withdraws only the selected wait and preserves human FIFO, attachments and other inputs', () => {
    const run = parent(); const wakeId = randomUUID();
    const selected = workerWaitSchema.parse({ ...wait, phase: 'wake-pending', wakeId });
    store.commitDelegation([{ id: run.id, delegation: { ...root, wait: selected } }]);
    const old = { id: randomUUID(), text: 'earlier update', images: ['earlier.png'], createdAt: now };
    const next = { id: randomUUID(), text: 'new update', images: ['new.pdf'], createdAt: now };
    store.updateRun(run.id, { queuedMessages: [old], continuationMessage: { id: 'continue-1', text: 'human opening', origin: 'human', images: ['opening.png'], createdAt: now } });
    const wake = { id: wakeId, source: 'lifecycle' as const, parentRunId: run.id, text: 'wake', createdAt: now };
    const unrelated = { ...wake, id: randomUUID(), deliveredAt: now };
    store.commitAgentInputs(run.id, [wake, unrelated]);
    const before = JSON.stringify(store.getRun(run.id));
    expect(() => store.commitWorkerWaitWithdrawal(run.id, randomUUID(), next)).toThrow();
    expect(JSON.stringify(store.getRun(run.id))).toBe(before);
    store.commitWorkerWaitWithdrawal(run.id, selected.id, next);
    const reopened = RunStore.open(dataDir, { keepLive: true }).getRun(run.id);
    expect(reopened?.delegation).toEqual({ ...root, lastWait: { ...selected, reason: 'timeout' } });
    expect(reopened?.agentInputs).toEqual([unrelated]);
    expect(reopened?.queuedMessages).toEqual([old, next]);
    expect(reopened?.continuationMessage).toMatchObject({ text: 'human opening', images: ['opening.png'], origin: 'human' });
    store.commitQueuedMessageDelivery(run.id, next.id);
    expect(RunStore.open(dataDir, { keepLive: true }).getRun(run.id)?.queuedMessages).toEqual([old]);
  });

  it('retains a delivered wake receipt and publishes nothing if human withdrawal cannot persist', () => {
    const run = parent(); const wakeId = randomUUID();
    const selected = workerWaitSchema.parse({ ...wait, phase: 'wake-pending', wakeId });
    store.commitDelegation([{ id: run.id, delegation: { ...root, wait: selected } }]);
    const delivered = { id: wakeId, source: 'lifecycle' as const, parentRunId: run.id, text: 'wake', createdAt: now, deliveredAt: now };
    store.commitAgentInputs(run.id, [delivered]);
    const before = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    const notifications: unknown[] = []; store.on('run', value => notifications.push(value));
    mkdirSync(join(dataDir, 'runs.json.tmp'));
    try {
      expect(() => store.commitWorkerWaitWithdrawal(run.id, selected.id, { id: randomUUID(), text: 'new', createdAt: now })).toThrow();
      expect(notifications).toEqual([]);
      expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(before);
      expect(store.getRun(run.id)?.delegation).toEqual({ ...root, wait: selected });
    } finally { rmSync(join(dataDir, 'runs.json.tmp'), { recursive: true }); }
    store.commitWorkerWaitWithdrawal(run.id, selected.id);
    expect(RunStore.open(dataDir, { keepLive: true }).getRun(run.id)?.agentInputs).toEqual([delivered]);
  });

  it('Finish cancellation atomically retires intent, fails closed on write failure and rejects late success', () => {
    const run = parent();
    store.updateRun(run.id, { status: 'waiting' });
    store.commitRootFinishIntent(run.id);
    const before = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    const snapshot = structuredClone(store.getRun(run.id));
    const notifications: unknown[] = []; store.on('run', value => notifications.push(value));
    mkdirSync(join(dataDir, 'runs.json.tmp'));
    try {
      expect(() => store.commitRootFinishCancellation(run.id)).toThrow();
      expect(store.getRun(run.id)).toEqual(snapshot);
      expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(before);
      expect(notifications).toEqual([]);
    } finally { rmSync(join(dataDir, 'runs.json.tmp'), { recursive: true }); }
    expect(store.commitRootFinishCancellation(run.id)).toBe(true);
    const cancelled = RunStore.open(dataDir, { keepLive: true }).getRun(run.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', delegation: root });
    expect(cancelled?.delegation).not.toHaveProperty('finishRequestedAt');
    expect(store.commitRootFinishSuccess(run.id, 'done')).toBe(false);
    expect(store.commitRootFinishCancellation(run.id)).toBe(false);
    // Even if a human continuation has already parked again, the old diff is obsolete.
    store.updateRun(run.id, { status: 'waiting' });
    expect(store.commitRootFinishSuccess(run.id, 'review')).toBe(false);
    expect(store.getRun(run.id)?.status).toBe('waiting');
  });

  it('publishes the complete durable proposed index before notifying any listener', () => {
    const first = store.createRun(input);
    const second = store.createRun(input);
    const observed: unknown[] = [];
    store.on('run', () => observed.push({ disk: disk(), memory: store.listRuns().map(r => r.delegation) }));
    store.commitDelegation([{ id: first.id, delegation: root }, { id: second.id, delegation: { role: 'invalid' } }]);
    expect(observed).toHaveLength(2);
    for (const value of observed) {
      expect(value).toMatchObject({
        memory: expect.arrayContaining([root, { role: 'invalid' }]),
        disk: expect.arrayContaining([
          { ...first, delegation: root }, { ...second, delegation: { role: 'invalid' } },
        ]),
      });
    }
    expect(RunStore.open(dataDir, { keepLive: true }).getRun(first.id)?.delegation).toEqual(root);
  });

  it('failed atomic writes publish no metadata, receipts, workers or events', () => {
    const run = parent();
    const original = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    const emitted: unknown[] = [];
    store.on('run', r => emitted.push(r));
    store.on('event', e => emitted.push(e));
    // Real filesystem write failure, even under root: a directory cannot be opened as a file.
    mkdirSync(join(dataDir, 'runs.json.tmp'));
    try {
      expect(() => store.commitDelegation([{ id: run.id, delegation: { ...root, wait: workerWaitSchema.parse(wait) } }])).toThrow();
      expect(() => store.createOwnedRun(input, run.id, requestId, worker(run.id), requestHash)).toThrow();
      expect(store.listRuns()).toHaveLength(1);
      expect(store.getRun(run.id)?.delegation).toEqual(root);
      expect(emitted).toEqual([]);
      expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(original);
    } finally { rmSync(join(dataDir, 'runs.json.tmp'), { recursive: true }); }
  });

  it('failed rename publishes nothing even after the temporary file is written', () => {
    const run = parent();
    const before = store.getRun(run.id)?.delegation;
    rmSync(join(dataDir, 'runs.json'));
    mkdirSync(join(dataDir, 'runs.json'));
    const emitted: unknown[] = [];
    store.on('run', r => emitted.push(r));
    try {
      expect(() => store.createOwnedRun(input, run.id, requestId, worker(run.id), requestHash)).toThrow();
      expect(store.listRuns()).toHaveLength(1);
      expect(store.getRun(run.id)?.delegation).toEqual(before);
      expect(emitted).toEqual([]);
    } finally { rmSync(join(dataDir, 'runs.json'), { recursive: true }); }
  });

  it('atomically persists receipt and worker, replays retries after restart, and rejects a changed request', () => {
    const run = parent();
    const metadata = worker(run.id);
    const emitted: string[] = [];
    store.on('run', r => {
      emitted.push(r.id);
      expect(disk()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: run.id, delegation: expect.objectContaining({ receipts: [{ requestId, workerId, requestHash }] }) }),
        expect.objectContaining({ id: workerId, delegation: metadata }),
      ]));
    });
    const created = store.createOwnedRun({ ...input, runner: 'codex', model: 'model', agentProfile: 'account' }, run.id, requestId, metadata, requestHash);
    expect(created).toMatchObject({ id: workerId, delegation: metadata, status: 'queued', runner: 'codex', model: 'model', agentProfile: 'account' });
    expect(emitted.sort()).toEqual([run.id, workerId].sort());
    store.flush();
    store = RunStore.open(dataDir, { keepLive: true });
    // The selector hash is unchanged even if parent HEAD and inherited settings have moved.
    const retry = store.createOwnedRun(input, run.id, requestId, worker(run.id, randomUUID()), requestHash);
    expect(retry).toMatchObject({ id: workerId, delegation: { workspace: { baselineSha } } });
    expect(store.listRuns()).toHaveLength(2);
    expect(() => store.createOwnedRun({ ...input, task: 'different' }, run.id, requestId, metadata, 'c'.repeat(64))).toThrow(/request/i);
    expect(store.listRuns()).toHaveLength(2);
  });

  it('rejects missing, malformed or duplicate patch targets without a partial commit', () => {
    const run = parent();
    const original = readFileSync(join(dataDir, 'runs.json'), 'utf8');
    for (const patches of [
      [{ id: run.id, delegation: { role: 'invalid' } }, { id: randomUUID(), delegation: root }],
      [{ id: run.id, delegation: { role: 'invalid' } }, { id: run.id, delegation: root }],
      [{ id: run.id, delegation: { role: 'worker' } }],
    ]) expect(() => store.commitDelegation(patches as Parameters<RunStore['commitDelegation']>[0])).toThrow();
    expect(store.getRun(run.id)?.delegation).toEqual(root);
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(original);
  });

  it('denies invalid parents and worker/parent/resource collisions', () => {
    const run = parent();
    const other = store.createRun(input);
    const metadata = worker(run.id);
    expect(() => store.createOwnedRun(input, other.id, requestId, worker(other.id), requestHash)).toThrow();
    expect(() => store.createOwnedRun(input, run.id, requestId, worker(run.id, run.id), requestHash)).toThrow();
    expect(() => store.createOwnedRun(input, run.id, requestId, worker(other.id), requestHash)).toThrow();
    expect(() => store.createOwnedRun(input, run.id, requestId, worker(run.id, other.id), requestHash)).toThrow();
    store.createOwnedRun(input, run.id, requestId, metadata, requestHash);
    if (metadata.role !== 'worker') throw new Error('fixture');
    for (const key of ['resourceId', 'path', 'branch'] as const) {
      const collision = worker(run.id, randomUUID());
      if (collision.role !== 'worker') throw new Error('fixture');
      collision.workspace[key] = metadata.workspace[key];
      expect(() => store.createOwnedRun(input, run.id, randomUUID(), collision, requestHash)).toThrow();
    }
    expect(store.listRuns()).toHaveLength(3);
  });

  // Exercise all 32 real durable creations; this is not a 5s filesystem throughput assertion.
  it('keeps the lifetime creation cap across restart, including destroyed workers and retries', { timeout: 30_000 }, () => {
    const run = parent();
    for (let i = 0; i < 32; i++) {
      const id = randomUUID();
      const metadata = worker(run.id, id);
      if (metadata.role !== 'worker') throw new Error('fixture');
      store.createOwnedRun(input, run.id, i === 0 ? requestId : randomUUID(), metadata, requestHash);
      store.commitDelegation([{ id, delegation: {
        ...metadata, destroy: { requestedAt: now, phase: 'complete', remaining: [] },
      } }]);
    }
    store.flush();
    store = RunStore.open(dataDir, { keepLive: true });
    expect(() => store.createOwnedRun(input, run.id, randomUUID(), worker(run.id, randomUUID()), requestHash)).toThrow();
    expect(store.createOwnedRun(input, run.id, requestId, worker(run.id, randomUUID()), requestHash).delegation).toMatchObject({ destroy: { phase: 'complete' } });
    expect(store.listRuns()).toHaveLength(33);
  });

  it('fails closed when a retry receipt points at a missing worker', () => {
    const run = parent();
    store.createOwnedRun(input, run.id, requestId, worker(run.id), requestHash);
    store.flush();
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(disk().filter((r: { id: string }) => r.id !== workerId)));
    store = RunStore.open(dataDir, { keepLive: true });
    expect(() => store.createOwnedRun(input, run.id, requestId, worker(run.id, randomUUID()), requestHash)).toThrow(/receipt/i);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('fails closed when a retry receipt no longer points at an intact owned worker', () => {
    const run = parent();
    store.createOwnedRun(input, run.id, requestId, worker(run.id), requestHash);
    store.commitDelegation([{ id: workerId, delegation: { role: 'invalid' } }]);
    expect(() => store.createOwnedRun(input, run.id, requestId, worker(run.id), requestHash)).toThrow();
  });

  it('quarantines malformed delegation locally, preserving all runs and legacy absence on reopen', () => {
    const legacy = store.createRun(input);
    const broken = store.createRun(input);
    const valid = parent();
    store.flush();
    const rows = disk().map((r: { id: string }) => r.id === broken.id ? { ...r, delegation: { role: 'worker', parentRunId: 'bad' } } : r);
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(rows));
    store = RunStore.open(dataDir, { keepLive: true });
    expect(store.listRuns()).toHaveLength(3);
    expect(store.getRun(legacy.id)?.delegation).toBeUndefined();
    expect(store.getRun(broken.id)?.delegation).toEqual({ role: 'invalid' });
    expect(store.getRun(valid.id)?.delegation).toEqual(root);
    expect(() => store.createOwnedRun(input, broken.id, requestId, worker(broken.id), requestHash)).toThrow();
    store.flush();
    expect(RunStore.open(dataDir).getRun(broken.id)?.delegation).toEqual({ role: 'invalid' });
  });
});
