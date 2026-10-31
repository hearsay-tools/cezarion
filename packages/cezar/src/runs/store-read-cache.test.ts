import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationState } from '@open-mercato/cezar-contract';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { seedRuns } from './run-store.testkit.ts';
import { RunStore, type RunRecord } from './store.ts';

/** Successful `decodeRunRow` calls, by run id: the store calls `collectRawExtras` once per decode. */
const decodes = vi.hoisted(() => new Map<string, number>());
vi.mock('./raw-record.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./raw-record.ts')>();
  return { ...actual, collectRawExtras: (raw: unknown, parsed: unknown) => {
    const id = (parsed as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string') decodes.set(id, (decodes.get(id) ?? 0) + 1);
    return actual.collectRawExtras(raw, parsed);
  } };
});

/** `RunStore.withReadCache` (hearsay-tools/cezarion#2378): one decode per cold run, and every
 *  write visible to the reads after it. */
let dataDir: string;
const stores: RunStore[] = [];
const open = () => { const store = RunStore.open(dataDir, { keepLive: true }); stores.push(store); return store; };
const record = (over: Partial<RunRecord> = {}): RunRecord =>
  makeRunRecord({ id: randomUUID(), title: 'settled', status: RUN_STATUS.done, finishedAt: '2026-10-01T01:00:00.000Z', ...over });
const rootDelegation = (): DelegationState => ({ role: 'root', permissions: [], receipts: [] });
const workerDelegation = (parentRunId: string, id: string): DelegationState => ({
  role: 'worker', parentRunId, permissions: [],
  workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
});

let run: RunRecord;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-read-cache-'));
  run = record();
  seedRuns(dataDir, [run]);
  decodes.clear();
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('RunStore.withReadCache', () => {
  it('decodes a cold run once and answers every read of the scope with that copy', () => {
    const store = open();
    const [first, second] = store.withReadCache(() => [store.getRun(run.id), store.withReadCache(() => store.getRun(run.id))]);
    expect(second).toBe(first);
    expect(decodes.get(run.id)).toBe(1);
    expect(store.heldIds()).toEqual([]);
    // The cache ends with the scope: a later read decodes the row again.
    expect(store.getRun(run.id)).not.toBe(first);
    expect(decodes.get(run.id)).toBe(2);
  });

  it('a write in the scope is visible to the reads after it, without a second decode', () => {
    const store = open();
    store.withReadCache(() => {
      expect(store.getRun(run.id)?.title).toBe('settled');
      store.updateRun(run.id, { title: 'renamed' });
      expect(store.getRun(run.id)?.title).toBe('renamed');
      store.appendEvent(run.id, { type: 'note', message: 'written' });
      expect(store.getRun(run.id)?.title).toBe('renamed');
    });
    expect(decodes.get(run.id)).toBe(1);
    expect(store.readEvents(run.id).map((event) => event.type)).toEqual(['note']);
  });

  it('a written run that leaves memory in the scope is read again, never the copy from before the write', () => {
    const store = open();
    store.withReadCache(() => {
      const before = store.getRun(run.id);
      store.updateRun(run.id, { title: 'renamed' });
      store.flush(); // the settled write lets the run leave memory
      expect(store.heldIds()).toEqual([]);
      const after = store.getRun(run.id);
      expect(after).not.toBe(before);
      expect(after?.title).toBe('renamed');
    });
  });

  it('a run with no row reads as absent in the scope', () => {
    const store = open();
    expect(store.withReadCache(() => store.getRun(randomUUID()))).toBeUndefined();
  });

  it('a run deleted in the scope reads as absent', () => {
    const store = open();
    store.withReadCache(() => {
      expect(store.getRun(run.id)).toBeDefined();
      expect(store.deleteRun(run.id)).toBe(true);
      expect(store.getRun(run.id)).toBeUndefined();
    });
  });

  it('a direct read sees another store\'s update and deletion inside the scope', () => {
    const store = open();
    const other = open();
    store.withReadCache(() => {
      expect(store.getRun(run.id)?.title).toBe('settled');
      other.updateRun(run.id, { title: 'changed elsewhere' });
      other.flush();
      expect(store.getRun(run.id)?.title).toBe('changed elsewhere');
      expect(other.deleteRun(run.id)).toBe(true);
      other.flush();
      expect(store.getRun(run.id)).toBeUndefined();
    });
  });

  it('a row another writer changed is decoded again, by query and by a write', () => {
    const root = record({ delegation: rootDelegation() });
    const workerId = randomUUID();
    const worker = record({ id: workerId, delegation: workerDelegation(root.id, workerId) });
    seedRuns(dataDir, [root, worker]);
    const store = open();
    const other = open();
    store.withReadCache(() => {
      expect(store.getRun(workerId)?.title).toBe('settled');
      other.updateRun(workerId, { title: 'changed elsewhere' });
      other.flush(); // released: this store may claim the family again
      // A query reads the row again and sees its new revision.
      expect(store.listWorkersOf(root.id).map((entry) => entry.title)).toEqual(['changed elsewhere']);
      expect(store.getRun(workerId)?.title).toBe('changed elsewhere');
    });
    store.withReadCache(() => {
      expect(store.getRun(workerId)?.title).toBe('changed elsewhere');
      other.updateRun(workerId, { title: 'changed again' });
      other.flush();
      // The write claims the family, then holds the row at its claimed revision, not the cached one.
      store.updateRun(workerId, { task: 'mine' });
      expect(store.getRun(workerId)).toMatchObject({ title: 'changed again', task: 'mine' });
    });
    expect(store.listQuarantinedRunIds()).toEqual([]);
  });
});
