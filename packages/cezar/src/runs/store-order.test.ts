import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from './store.ts';

/**
 * Runs created in the same millisecond (#779, T7). Before `runs.db`, every list was a stable sort
 * of the in-memory map by `createdAt`, so ties came out in the order the runs were inserted:
 * `runs.json` order on open, then creation order. Recovery and the queue start runs in that
 * order, so in a one-slot project it decides which tied run goes first.
 */

let dataDir: string;
const stores: RunStore[] = [];
const open = (opts?: { keepLive?: boolean }) => {
  const store = RunStore.open(dataDir, opts);
  stores.push(store);
  return store;
};

const CREATED_AT = '2026-09-01T00:00:00.000Z';
const record = (id: string, status = 'done') => ({
  id, title: `run ${id}`, workflow: 'quick-task', task: `task ${id}`, status, createdAt: CREATED_AT,
  ...(status === 'done' ? { finishedAt: '2026-09-01T01:00:00.000Z' } : {}), tokensUsed: 0, archived: false, steps: [],
});

/** Every order a list read answers, as ids. */
function orders(store: RunStore) {
  return {
    live: store.listRuns().map((run) => run.id),
    summaries: store.listRunSummaries().runs.map((run) => run.id),
    all: store.listAllRunsForLegacyRoute().map((run) => run.id),
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-store-order-'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runs with the same createdAt', () => {
  // Neither id order: ascending would read a, b, c and descending c, b, a.
  const fileOrder = ['run-b', 'run-c', 'run-a'];

  it('list in runs.json order after the import, after a write and after a reopen', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([
      ...fileOrder.map((id) => record(id, 'running')),
      record('older', 'running'),
    ].map((run) => (run.id === 'older' ? { ...run, createdAt: '2026-08-31T00:00:00.000Z' } : run))));
    const expected = [...fileOrder, 'older'];

    const store = open({ keepLive: true });
    expect(orders(store)).toEqual({ live: expected, summaries: expected, all: expected });
    // Memory holds them in that order too, as the map loaded from runs.json did.
    expect(store.heldIds()).toEqual(['run-b', 'run-c', 'run-a', 'older']);

    // A write keeps a row where it was inserted.
    store.updateRun('run-c', { title: 'renamed' });
    store.updateRun('run-b', { title: 'renamed' });
    store.flush();
    expect(orders(store)).toEqual({ live: expected, summaries: expected, all: expected });

    store.close();
    expect(orders(open({ keepLive: true }))).toEqual({ live: expected, summaries: expected, all: expected });
  });

  it('list finished runs (read cold) in runs.json order too, interleaved with a held one', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('run-b'), record('run-c', 'running'), record('run-a')]));
    const store = open({ keepLive: true });
    expect(store.heldIds()).toEqual(['run-c']);
    expect(orders(store)).toEqual({ live: ['run-c'], summaries: fileOrder, all: fileOrder });
  });

  it('list in creation order, before and after they are written, and after a reopen', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(CREATED_AT));
    let store = open();
    // Random ids: six of them make an id order that happens to match creation order 1 in 720.
    const created = Array.from({ length: 6 }, (_, index) => store.createRun({ title: `t${index}`, workflow: 'w', task: 'task', steps: [] }).id);
    expect(store.listRuns().map((run) => run.id)).toEqual(created);
    expect(store.listRunSummaries().runs.map((run) => run.id)).toEqual(created);

    store.flush();
    expect(store.listRuns().map((run) => run.id)).toEqual(created);
    expect(store.listRunSummaries().runs.map((run) => run.id)).toEqual(created);

    store.close();
    store = open({ keepLive: true });
    expect(store.listRuns().map((run) => run.id)).toEqual(created);
    expect(store.listRunSummaries().runs.map((run) => run.id)).toEqual(created);
  });

  it('list in creation order when a durable commit of the newest writes them all', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(CREATED_AT));
    let store = open();
    const created = Array.from({ length: 3 }, (_, index) => store.createRun({ title: `t${index}`, workflow: 'w', task: 'task', steps: [] }).id);
    // Stages the newest, and the same transaction writes the two a debounced save still owes.
    store.commitQueuedMessageDelivery(created[2]!, 'no-such-message');
    expect(store.listRuns().map((run) => run.id)).toEqual(created);

    store.close();
    store = open({ keepLive: true });
    expect(store.listRuns().map((run) => run.id)).toEqual(created);
  });
});
