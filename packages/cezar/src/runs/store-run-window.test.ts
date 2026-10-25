import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARCHIVED_ROOT, RUNS_DB_FILE, RunDatabase } from './run-database.ts';
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

  it('with roots, leaves every worker out, unarchived and held ones too (the runs index)', () => {
    seedIncident();
    const store = open();
    const parent = randomUUID();
    const heldWorker = randomUUID();
    store.close();
    stores.splice(0);
    seedRuns(dataDir, [
      root(parent, 20_000, { status: 'running', archived: false, finishedAt: undefined }),
      worker(heldWorker, parent, 20_001, { status: 'running', archived: false, finishedAt: undefined }),
      root('active', 1, { archived: false }),
      worker('w-active', 'active', 2, { archived: false }),
    ]);
    const reopened = open();
    expect(reopened.heldIds()).toContain(heldWorker);
    expect(ids(reopened.listRunSummaries({ archivedWindow: 200, roots: true }).runs)).toEqual([parent, 'active']);
    // The cockpit's own list keeps them: a parent's workers are rows there.
    expect(ids(reopened.listRunSummaries({ archivedWindow: 200 }).runs)).toEqual([heldWorker, parent, 'w-active', 'active']);
  });

  it('still lists every run without the option', () => {
    seedIncident();
    expect(open().listRunSummaries().runs).toHaveLength(1 + 4 + 2 + 250 + 300);
  });
});

it('archived search retains summaries whose only match is a PR in the collection', () => {
  seedRuns(dataDir, [root('split', 1, { pullRequests: [812, 813, 814, 815, 816].map(number => ({ number, source: 'declared' })) })]);
  const store = open();
  for (const number of [812, 813, 814, 815, 816]) {
    const found = store.listArchivedRuns({ q: `#${number}`, limit: 50 });
    expect('error' in found).toBe(false);
    if (!('error' in found)) expect(found.runs.map(run => run.id)).toEqual(['split']);
  }
});

/**
 * `listArchivedRuns` (#864, hearsay-tools/cezarion#1644): guards for the steps its body took in
 * one pass — the cursor, the stored rows, the held overlay, the page and its hydration. They pin
 * what the function answers and which store reads it makes, so splitting it into steps cannot
 * change either.
 */
describe('RunStore.listArchivedRuns', () => {
  /** A step status the record schema rejects: the row's stored summary is valid, its record is not. */
  const unreadableSteps = [{ id: 's', name: 's', kind: 'agent', status: 'bogus', iterations: 1, tokensUsed: 0 }];

  const list = (store: RunStore, options: Parameters<RunStore['listArchivedRuns']>[0]) => {
    const found = store.listArchivedRuns(options);
    if ('error' in found) throw new Error(found.error);
    return found;
  };

  /** The three store reads the archived list may make; each still calls through. */
  const spyOnReads = () => ({
    keys: vi.spyOn(RunDatabase.prototype, 'listKeysWhere'),
    search: vi.spyOn(RunDatabase.prototype, 'searchRootSummaries'),
    summaries: vi.spyOn(RunDatabase.prototype, 'getSummaries'),
  });

  /** Rewrite a stored summary the way an older writer left it, while the record stays valid. */
  const setStoredSummaries = (summaries: Record<string, string>) => {
    const db = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    try {
      for (const [id, summary] of Object.entries(summaries)) db.prepare('UPDATE runs SET summary = ? WHERE id = ?').run(summary, id);
    } finally {
      db.close();
    }
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers { error } for a cursor this store did not write, before it reads a row', () => {
    seedRuns(dataDir, [root('a', 1)]);
    const store = open();
    const { keys, search, summaries } = spyOnReads();
    // `{"c":1}`: JSON, but not a cursor this store wrote.
    for (const before of ['garbage', 'eyJjIjoxfQ']) {
      expect(store.listArchivedRuns({ before, limit: 10 })).toEqual({ error: 'before is not a cursor this server wrote' });
    }
    for (const spy of [keys, search, summaries]) expect(spy).not.toHaveBeenCalled();
  });

  it('ranks by key alone and reads only the page rows in full', () => {
    seedRuns(dataDir, [1, 2, 3, 4, 5].map((n) => root(`a${n}`, n)));
    const store = open();
    const { keys, search, summaries } = spyOnReads();

    const first = list(store, { limit: 2 });
    expect(ids(first.runs)).toEqual(['a5', 'a4']);
    expect(first.total).toBe(5);
    expect(first.nextCursor).not.toBeNull();
    expect(keys).toHaveBeenCalledExactlyOnceWith(ARCHIVED_ROOT);
    expect(search).not.toHaveBeenCalled();
    expect(summaries).toHaveBeenCalledExactlyOnceWith(['a5', 'a4']);
    expect(keys.mock.invocationCallOrder[0]).toBeLessThan(summaries.mock.invocationCallOrder[0]!);

    const second = list(store, { limit: 2, before: first.nextCursor! });
    expect(ids(second.runs)).toEqual(['a3', 'a2']);
    expect(second.total).toBe(5);
    const last = list(store, { limit: 2, before: second.nextCursor! });
    expect(ids(last.runs)).toEqual(['a1']);
    expect(last).toMatchObject({ total: 5, nextCursor: null });
  });

  it('gives no next cursor when the page takes the last row, and one when a row is left', () => {
    seedRuns(dataDir, [1, 2, 3].map((n) => root(`a${n}`, n)));
    const store = open();
    expect(list(store, { limit: 3 })).toMatchObject({ total: 3, nextCursor: null });
    expect(list(store, { limit: 2 }).nextCursor).not.toBeNull();
  });

  it('with q, searches once, makes no other ranking read and counts only the matches', () => {
    seedRuns(dataDir, [
      root('a1', 1, { title: 'needle one' }), root('a2', 2), root('a3', 3, { title: 'needle three' }), root('a4', 4),
      // The search reads roots, archived or not; only archived ones list.
      root('live', 5, { title: 'needle live', archived: false }),
    ]);
    const store = open();
    const { keys, search, summaries } = spyOnReads();

    // Every ranked row carries its summary, so the page reads none in full.
    const found = list(store, { q: '  needle ', limit: 1 });
    expect(ids(found.runs)).toEqual(['a3']);
    expect(found.total).toBe(2);
    expect(found.nextCursor).not.toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
    expect(summaries).toHaveBeenCalledExactlyOnceWith([]);

    // A q of spaces is no q.
    expect(list(store, { q: '   ', limit: 10 }).total).toBe(4);
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('skips a deleted run, an unreadable run and the stored row of a held run, with and without q', () => {
    seedRuns(dataDir, [
      root('a1', 1, { title: 'needle' }), root('a2', 2, { title: 'needle' }), root('a3', 3, { title: 'needle' }),
      root('a4', 4, { title: 'needle', steps: unreadableSteps }), root('a5', 5, { title: 'needle' }),
    ]);
    const store = open();
    expect(store.getRun('a4')).toBeUndefined();
    expect(store.isUnreadable('a4')).toBe(true);
    // Held and unarchived in memory, while its row is still archived: the record wins.
    store.setArchived('a3', false);
    // Last: a write commits the deletes pending before it, and this row must still be stored.
    expect(store.deleteRun('a2')).toBe(true);

    for (const q of [undefined, 'needle']) {
      const found = list(store, { limit: 10, ...(q === undefined ? {} : { q }) });
      expect(ids(found.runs), `q=${q}`).toEqual(['a5', 'a1']);
      expect(found.total, `q=${q}`).toBe(2);
    }
  });

  it('lists a held run by its record, in place of its stored row', () => {
    seedRuns(dataDir, [root('a1', 1, { title: 'alpha' }), root('a2', 2, { title: 'alpha' }), root('a3', 3, { title: 'alpha' })]);
    const store = open();
    store.updateRun('a2', { title: 'omega' });

    const all = list(store, { limit: 10 });
    expect(all.runs.map((run) => [run.id, run.title])).toEqual([['a3', 'alpha'], ['a2', 'omega'], ['a1', 'alpha']]);
    expect(all.total).toBe(3);
    // Found by the record alone: the stored summary never says omega.
    expect(ids(list(store, { q: 'omega', limit: 10 }).runs)).toEqual(['a2']);
    // The stored row said alpha, but the record that replaces it does not.
    const alpha = list(store, { q: 'alpha', limit: 10 });
    expect(ids(alpha.runs)).toEqual(['a3', 'a1']);
    expect(alpha.total).toBe(2);
  });

  it('matches a stored run and a held run by their automation\'s name when given the names (hearsay-tools/cezarion#1616)', () => {
    const trigger = { automationId: 'auto-7f3', automationRevision: 1, receiptId: 'r1', trigger: 'schedule', occurrenceAt: at(1) };
    seedRuns(dataDir, [root('stored', 1, { automationTrigger: trigger }), root('held', 2, { automationTrigger: trigger }), root('other', 3)]);
    const store = open();
    store.updateRun('held', { title: 'held run' });
    const automationNames = new Map([['auto-7f3', 'Dependency bump']]);

    // The stored summary holds the automation's id, never its name, so SQL must not drop the row.
    expect(ids(list(store, { q: 'dependency', limit: 10, automationNames }).runs)).toEqual(['held', 'stored']);
    expect(ids(list(store, { q: 'bump held', limit: 10, automationNames }).runs)).toEqual(['held']);
    // Without a lookup the automation is not searched; an empty one finds it by its recorded id.
    expect(ids(list(store, { q: 'dependency', limit: 10 }).runs)).toEqual([]);
    expect(ids(list(store, { q: 'auto-7f3', limit: 10 }).runs)).toEqual([]);
    expect(ids(list(store, { q: 'auto-7f3', limit: 10, automationNames: new Map() }).runs)).toEqual(['held', 'stored']);
  });

  it('leaves out a held archived worker, with and without q', () => {
    const parent = randomUUID();
    const heldWorker = randomUUID();
    seedRuns(dataDir, [
      root('a1', 1),
      root(parent, 2, { status: 'running', archived: false, finishedAt: undefined }),
      worker(heldWorker, parent, 3, { status: 'running', archived: true, finishedAt: undefined }),
    ]);
    const store = open();
    expect(store.heldIds()).toContain(heldWorker);
    for (const q of [undefined, 'run']) {
      const found = list(store, { limit: 10, ...(q === undefined ? {} : { q }) });
      expect(ids(found.runs), `q=${q}`).toEqual(['a1']);
      expect(found.total, `q=${q}`).toBe(1);
    }
  });

  it('projects a summary from the record when the stored one does not fit the contract', () => {
    seedRuns(dataDir, [
      root('a1', 1), root('a2', 2, { title: 'needle' }), root('a3', 3), root('a4', 4, { steps: unreadableSteps }), root('a5', 5),
    ]);
    // a1 and a4 have no summary at all; a2's and a5's hold the search word but are no summary, and
    // the record decides a5 does not match it.
    setStoredSummaries({ a1: '{}', a2: '{"title":"needle"}', a4: '{}', a5: '{"title":"needle"}' });
    const store = open();

    const all = list(store, { limit: 10 });
    // a4 cannot be read at all, so it has nothing to list, and the read marks it.
    expect(all.runs.map((run) => [run.id, run.title, run.archived])).toEqual([
      ['a5', 'run a5', true], ['a3', 'run a3', true], ['a2', 'needle', true], ['a1', 'run a1', true],
    ]);
    expect(store.isUnreadable('a4')).toBe(true);
    expect(list(store, { limit: 10 }).total).toBe(4);

    const found = list(store, { q: 'needle', limit: 10 });
    expect(found.runs.map((run) => [run.id, run.title])).toEqual([['a2', 'needle']]);
    expect(found.total).toBe(1);
  });
});
