import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ARCHIVED_WINDOW, RunStore } from './store.ts';
import { seedRuns } from './run-store.testkit.ts';

/**
 * The windowed run list (#864): every unarchived run, plus the newest `ARCHIVED_WINDOW` archived
 * ROOT runs. Archived workers never count against the window, so they can no longer push an
 * older live root out of it — the incident behind the issue.
 */

let dataDir: string;
const stores: RunStore[] = [];
const open = () => {
  const store = RunStore.open(dataDir, { keepLive: true });
  stores.push(store);
  return store;
};

/** Minute `n` after a fixed start, so a larger `n` is newer. */
const at = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString();

const root = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  id, title: `run ${id}`, workflow: 'quick-task', task: `task ${id}`, status: 'done', createdAt: at(n),
  finishedAt: at(n), tokensUsed: 0, archived: true, steps: [], ...over,
});

const worker = (id: string, parentRunId: string, n: number, over: Record<string, unknown> = {}) => root(id, n, {
  delegation: {
    role: 'worker', parentRunId, permissions: [],
    workspace: {
      ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: `/managed/${id}`,
      branch: `cez/${id}`, baselineSha: '0'.repeat(40),
    },
  },
  ...over,
});

/** The incident's shape: an old waiting root behind many newer archived roots and workers. */
function seedIncident(archivedRoots = 250) {
  const records: unknown[] = [
    root('old-waiting', 0, { status: 'waiting', archived: false, finishedAt: undefined, hasPendingHumanAsk: true }),
  ];
  for (let i = 1; i <= 4; i++) records.push(root(`live-${i}`, 10_000 + i, { status: 'done', archived: false }));
  records.push(worker('w-live-1', 'live-1', 10_010, { archived: false }));
  records.push(worker('w-live-2', 'live-2', 10_011, { archived: false }));
  for (let i = 1; i <= archivedRoots; i++) records.push(root(`arch-${i}`, 100 + i * 2));
  for (let i = 1; i <= 300; i++) records.push(worker(`w-arch-${i}`, `arch-${(i % archivedRoots) + 1}`, 101 + i * 2));
  seedRuns(dataDir, records);
}

const ids = (runs: { id: string }[]) => runs.map((run) => run.id);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-store-window-'));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('RunStore.listRunSummaries({ archivedWindow })', () => {
  it('keeps every unarchived run and only the newest archived roots', () => {
    seedIncident();
    const { runs, truncated } = open().listRunSummaries({ archivedWindow: ARCHIVED_WINDOW });

    expect(ARCHIVED_WINDOW).toBe(200);
    const unarchived = runs.filter((run) => !run.archived);
    expect(ids(unarchived).sort()).toEqual(['live-1', 'live-2', 'live-3', 'live-4', 'old-waiting', 'w-live-1', 'w-live-2']);
    const archived = runs.filter((run) => run.archived);
    expect(archived).toHaveLength(200);
    expect(archived.every((run) => run.delegation?.role !== 'worker')).toBe(true);
    // The newest 200 of arch-1..arch-250 are arch-51..arch-250.
    expect(ids(archived).sort()).toEqual(Array.from({ length: 200 }, (_, i) => `arch-${i + 51}`).sort());
    expect(truncated).toBe(true);
    // Newest first, as every list reads.
    const created = runs.map((run) => run.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });

  it('says truncated only when an archived root was left out', () => {
    seedIncident(200);
    expect(open().listRunSummaries({ archivedWindow: 200 }).truncated).toBe(false);
    for (const store of stores.splice(0)) store.close();
    rmSync(dataDir, { recursive: true, force: true });
    seedIncident(201);
    expect(open().listRunSummaries({ archivedWindow: 200 }).truncated).toBe(true);
  });

  it('ranks a held archived root by its record, not its row', () => {
    seedIncident();
    const store = open();
    const fresh = store.createRun({ title: 'fresh', task: 'fresh', workflow: 'quick-task', steps: [] });
    store.setArchived(fresh.id, true);

    const { runs, truncated } = store.listRunSummaries({ archivedWindow: 200 });
    const archived = ids(runs.filter((run) => run.archived));
    expect(archived).toHaveLength(200);
    expect(archived[0]).toBe(fresh.id);
    expect(archived).not.toContain('arch-51');
    expect(truncated).toBe(true);
  });

  it('lists a run unarchived in memory whose row is still archived past the window', () => {
    seedIncident();
    const store = open();
    store.setArchived('arch-1', false);

    const listed = store.listRunSummaries({ archivedWindow: 200 }).runs.find((run) => run.id === 'arch-1');
    expect(listed?.archived).toBe(false);
  });

  it('leaves out a held archived worker', () => {
    // A live record is held, and a worker's delegation must validate to stay a worker.
    const parent = randomUUID();
    const heldWorker = randomUUID();
    seedRuns(dataDir, [
      root(parent, 1, { status: 'running', archived: false, finishedAt: undefined }),
      worker(heldWorker, parent, 2, { status: 'running', archived: true, finishedAt: undefined }),
    ]);
    const store = open();
    expect(store.getRun(heldWorker)?.delegation?.role).toBe('worker');
    expect(store.heldIds()).toContain(heldWorker);
    expect(ids(store.listRunSummaries({ archivedWindow: 200 }).runs)).toEqual([parent]);
    expect(ids(store.listRunSummaries().runs)).toEqual([heldWorker, parent]);
  });

  it('still lists every run without the option', () => {
    seedIncident();
    expect(open().listRunSummaries().runs).toHaveLength(1 + 4 + 2 + 250 + 300);
  });
});
