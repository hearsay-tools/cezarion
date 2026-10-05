import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toRunSummary } from '@open-mercato/cezar-contract';

import { RUNS_DB_FILE, RUNS_IMPORT_COMPLETE_KEY, RunDatabase, type RunDatabaseChanges } from './run-database.ts';
import { blockRunWrites, readPersistedRuns, seedRuns } from './run-store.testkit.ts';
import { LEGACY_INDEX_BACKUP_FILE, RunStore, type RunRecord } from './store.ts';

/** RunStore on `runs.db` (#779): import, failure ordering, dirty-only saves, disposal. */

const record = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, title: `run ${id}`, workflow: 'quick-task', task: `task ${id}`, status: 'done',
  createdAt: `2026-09-0${id.length}T00:00:00.000Z`, tokensUsed: 0, archived: false, steps: [],
  ...over,
});

let dataDir: string;
const stores: RunStore[] = [];
const open = (opts?: { keepLive?: boolean }) => {
  const store = RunStore.open(dataDir, opts);
  stores.push(store);
  return store;
};
/** The change sets `store` hands the database, in order. */
const writes = (store: RunStore) => {
  const target = store as unknown as { writeIndex(changes: RunDatabaseChanges): void };
  const original = target.writeIndex.bind(store);
  const seen: Array<{ upserts: string[]; deletes: string[] }> = [];
  vi.spyOn(target, 'writeIndex').mockImplementation((changes) => {
    seen.push({ upserts: changes.upserts.map((row) => row.id), deletes: [...changes.deletes] });
    original(changes);
  });
  return seen;
};
const row = (id: string) => {
  const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE))!;
  try { return db.get(id); } finally { db.close(); }
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-store-db-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('importing runs.json', () => {
  it('imports every record, keeps the exact bytes beside it and never writes runs.json again', () => {
    const bytes = JSON.stringify([record('a'), record('bb', { status: 'review' })], null, 2);
    writeFileSync(join(dataDir, 'runs.json'), bytes);

    const store = open();
    expect(store.listRuns().map((run) => run.id)).toEqual(['bb', 'a']);
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe(bytes);
    expect(readPersistedRuns(dataDir).map((run) => run.id)).toEqual(['bb', 'a']);

    store.updateRun('a', { title: 'renamed' });
    store.createRun({ title: 'new', workflow: 'w', task: 't', steps: [] });
    store.flush();
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(bytes);
    expect(RunStore.open(dataDir).getRun('a')?.title).toBe('renamed');
  });

  it('reads only the database once the import is complete, whatever runs.json says later', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    open().close();
    // An older cezar writing runs.json after the upgrade: re-upgrading must not import it.
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a', { title: 'downgraded' }), record('zz')]));
    const store = open();
    expect(store.getRun('a')?.title).toBe('run a');
    expect(store.getRun('zz')).toBeUndefined();
  });

  it('never overwrites an existing backup', () => {
    writeFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'earlier backup');
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a')]));
    expect(open().getRun('a')).toBeDefined();
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe('earlier backup');
  });

  it.each([
    ['not JSON', '{ this is not json'],
    ['a record the schema rejects', JSON.stringify([record('a'), { id: 'broken' }])],
  ])('starts fresh from an unparseable runs.json (%s), as it always has, and keeps its bytes', (_, bytes) => {
    writeFileSync(join(dataDir, 'runs.json'), bytes);
    const store = open();
    expect(store.listRuns()).toEqual([]);
    expect(readFileSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE), 'utf8')).toBe(bytes);

    const run = store.createRun({ title: 'new', workflow: 'w', task: 't', steps: [] });
    store.flush();
    // Before #779 the next save overwrote the unreadable file; now nothing writes it.
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(bytes);
    expect(RunStore.open(dataDir).listRuns().map((saved) => saved.id)).toEqual([run.id]);
  });

  it('starts an empty database when there is nothing to import', () => {
    const store = open();
    expect(store.listRuns()).toEqual([]);
    expect(existsSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE))).toBe(false);
    const run = store.createRun({ title: 'new', workflow: 'w', task: 't', steps: [] });
    store.flush();
    expect(readPersistedRuns(dataDir).map((saved) => saved.id)).toEqual([run.id]);
    // The marker is set: a runs.json that shows up later is somebody else's history.
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('late')]));
    expect(RunStore.open(dataDir).getRun('late')).toBeUndefined();
  });

  it('commits the records and the completion marker together, or neither', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([record('a'), record('bb')]));
    RunDatabase.open(join(dataDir, RUNS_DB_FILE)).close();
    const release = blockRunWrites(dataDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(open().listRuns()).toEqual([]);
    } finally {
      release();
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('runs database unavailable (busy)'));
    const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE))!;
    try {
      expect(db.listAll()).toEqual([]);
      expect(db.getMeta(RUNS_IMPORT_COMPLETE_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
    // Nothing was half-imported, so the next open simply imports.
    expect(open().listRuns().map((run) => run.id)).toEqual(['bb', 'a']);
  });
});

describe('a database that cannot be opened', () => {
  it('is never reset: the store starts empty, warns once and writes nothing', () => {
    const files = { [RUNS_DB_FILE]: 'corrupt '.repeat(600), [`${RUNS_DB_FILE}-wal`]: 'wal '.repeat(300), 'runs.json': JSON.stringify([record('a')]) };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dataDir, name), text);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = open();
    expect(store.listRuns()).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('runs database unavailable (corrupt)'));

    vi.useFakeTimers();
    const run = store.createRun({ title: 'in memory', workflow: 'w', task: 't', steps: [] });
    expect(store.getRun(run.id)).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
    store.flush();
    expect(() => store.commitDelegation([{ id: run.id, delegation: { role: 'invalid' } }])).toThrow('runs database unavailable');
    store.close();
    for (const [name, text] of Object.entries(files)) expect(readFileSync(join(dataDir, name), 'utf8')).toBe(text);
    expect(existsSync(join(dataDir, LEGACY_INDEX_BACKUP_FILE))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('loads every readable row and leaves an unreadable one in the database untouched', () => {
    seedRuns(dataDir, [record('a'), { id: 'broken', status: 'done', createdAt: '2026-09-09T00:00:00.000Z' }, record('bb')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = open();
    expect(store.listRuns().map((run) => run.id)).toEqual(['bb', 'a']);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('1 run(s) in runs.db could not be read'));
    store.updateRun('a', { title: 'touched' });
    store.flush();
    expect(readPersistedRuns(dataDir).map((run) => run.id)).toEqual(['broken', 'bb', 'a']);
  });
});

describe('durable commits', () => {
  it('a failed commit changes neither memory, the database nor subscribers, and keeps pending rows pending', () => {
    vi.useFakeTimers();
    const store = open();
    const x = store.createRun({ title: 'x', workflow: 'w', task: 't', steps: [] });
    const y = store.createRun({ title: 'y', workflow: 'w', task: 't', steps: [] });
    store.flush();
    store.updateRun(x.id, { title: 'x pending' });
    const persisted = readPersistedRuns(dataDir);
    const before = structuredClone(store.getRun(y.id));
    const events: unknown[] = [];
    store.on('run', (run) => events.push(run));
    store.on('deleted', (id) => events.push(id));

    const release = blockRunWrites(dataDir);
    try {
      expect(() => store.commitDelegation([{ id: y.id, delegation: { role: 'invalid' } }])).toThrow(/locked/);
    } finally {
      release();
    }
    expect(store.getRun(y.id)).toEqual(before);
    expect(events).toEqual([]);
    expect(readPersistedRuns(dataDir)).toEqual(persisted);
    // The debounced update the failed commit would have carried is still owed.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(300);
    expect(readPersistedRuns(dataDir).find((run) => run.id === x.id)?.title).toBe('x pending');
  });

  it('a successful commit carries every pending row and deletion in the same transaction', () => {
    vi.useFakeTimers();
    const store = open();
    const x = store.createRun({ title: 'x', workflow: 'w', task: 't', steps: [] });
    const y = store.createRun({ title: 'y', workflow: 'w', task: 't', steps: [] });
    const gone = store.createRun({ title: 'gone', workflow: 'w', task: 't', steps: [] });
    store.flush();
    const seen = writes(store);
    store.updateRun(x.id, { title: 'x pending' });
    expect(store.deleteRun(gone.id)).toBe(true);

    store.commitDelegation([{ id: y.id, delegation: { role: 'invalid' } }]);
    expect(seen).toEqual([{ upserts: [y.id, x.id], deletes: [gone.id] }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(readPersistedRuns(dataDir).map((run) => [run.id, run.title])).toEqual(
      expect.arrayContaining([[x.id, 'x pending'], [y.id, 'y']]),
    );
    expect(readPersistedRuns(dataDir).some((run) => run.id === gone.id)).toBe(false);
  });

  it('a failed commit that would have been the first write of a deletion keeps the deletion owed', () => {
    const store = open();
    const run = store.createRun({ title: 'x', workflow: 'w', task: 't', steps: [] });
    const other = store.createRun({ title: 'y', workflow: 'w', task: 't', steps: [] });
    store.flush();
    store.deleteRun(run.id);
    const target = store as unknown as { writeIndex(changes: RunDatabaseChanges): void };
    vi.spyOn(target, 'writeIndex').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => store.commitDelegation([{ id: other.id, delegation: { role: 'invalid' } }])).toThrow('disk unavailable');
    store.flush();
    expect(readPersistedRuns(dataDir).map((saved) => saved.id)).toEqual([other.id]);
  });

  it('two stores on one project each write their own rows, never a stale copy of the other\'s', () => {
    // Before #779 every save rewrote the whole index from memory, so the second store's save put
    // back its stale copy of the first store's run. Each store now writes only what it changed.
    // keepLive, as `serve` opens a project: these runs are still queued.
    const first = open({ keepLive: true });
    const a = first.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    const b = first.createRun({ title: 'b', workflow: 'w', task: 't', steps: [] });
    first.flush();
    const second = open({ keepLive: true });

    first.updateRun(a.id, { title: 'a from first' });
    first.flush();
    second.updateRun(b.id, { title: 'b from second' });
    second.flush();

    const reopened = RunStore.open(dataDir, { keepLive: true });
    expect(reopened.getRun(a.id)?.title).toBe('a from first');
    expect(reopened.getRun(b.id)?.title).toBe('b from second');
  });

  it('a failed commit does not let a later save clobber what another store wrote meanwhile', () => {
    const first = open({ keepLive: true });
    const x = first.createRun({ title: 'x', workflow: 'w', task: 't', steps: [] });
    const y = first.createRun({ title: 'y', workflow: 'w', task: 't', steps: [] });
    first.flush();
    const second = open({ keepLive: true });
    const z = second.createRun({ title: 'z from second', workflow: 'w', task: 't', steps: [] });
    second.flush();

    first.updateRun(x.id, { title: 'x pending' });
    const target = first as unknown as { writeIndex(changes: unknown): void };
    vi.spyOn(target, 'writeIndex').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => first.commitDelegation([{ id: y.id, delegation: { role: 'invalid' } }])).toThrow('disk unavailable');
    first.flush();

    const reopened = RunStore.open(dataDir, { keepLive: true });
    expect(reopened.getRun(x.id)?.title).toBe('x pending');
    expect(reopened.getRun(y.id)?.delegation).toBeUndefined();
    expect(reopened.getRun(z.id)?.title).toBe('z from second');
  });
});

describe('debounced saves write only what changed', () => {
  it('writes the dirty row, the deleted row and nothing else', () => {
    vi.useFakeTimers();
    seedRuns(dataDir, Array.from({ length: 20 }, (_, i) => record(`run-${String(i).padStart(2, '0')}`)));
    const store = open();
    const seen = writes(store);
    store.flush();
    expect(seen).toEqual([]);

    store.updateRun('run-03', { title: 'changed' });
    store.updateRun('run-03', { tokensUsed: 5 });
    store.deleteRun('run-07');
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([{ upserts: ['run-03'], deletes: ['run-07'] }]);
    expect(row('run-03')?.revision).toBe(2);
    expect(row('run-04')?.revision).toBe(1);
    expect(row('run-07')).toBeUndefined();
  });

  it('retention deletes exactly the rows it pruned', () => {
    seedRuns(dataDir, [
      record('old-1', { createdAt: '2026-01-01T00:00:00.000Z' }),
      // With the run created below, one more than the 300 unarchived runs retention keeps.
      ...Array.from({ length: 299 }, (_, i) => record(`kept-${i}`, { createdAt: '2026-02-01T00:00:00.000Z' })),
    ]);
    const store = open();
    const seen = writes(store);
    const run = store.createRun({ title: 'trigger retention', workflow: 'w', task: 't', steps: [] });
    store.flush();
    expect(seen).toEqual([{ upserts: [run.id], deletes: ['old-1'] }]);
  });

  it('stores the record, its toRunSummary projection and the query columns', () => {
    const store = open();
    const run = store.createRun({ title: 'summary', workflow: '(planned)', task: 't', steps: [{ id: 's', name: 'Planner', kind: 'agent' }] });
    store.updateRun(run.id, { status: 'failed', autoResumeAt: '2026-10-06T00:00:00.000Z', finishedAt: '2026-10-05T00:00:00.000Z' });
    store.setArchived(run.id, false);
    store.flush();
    const saved = row(run.id)!;
    expect(JSON.parse(saved.data)).toEqual(JSON.parse(JSON.stringify(store.getRun(run.id))));
    expect(JSON.parse(saved.summary)).toEqual(JSON.parse(JSON.stringify(toRunSummary(store.getRun(run.id)!))));
    expect(saved).toMatchObject({
      status: 'failed', archived: false, finishedAt: '2026-10-05T00:00:00.000Z', wakeAt: '2026-10-06T00:00:00.000Z', parentRunId: null,
    });
  });
});

describe('loading normalizes and saves exactly the rows it changed', () => {
  const steps = [{ id: 's', name: 'S', kind: 'agent' as const, status: 'running' as const, iterations: 1, tokensUsed: 0 }];
  // One case per field `loadNormalizedFields` watches; the control row must not be rewritten.
  const cases: Array<[string, RunRecord, boolean | undefined, (run: RunRecord) => void]> = [
    ['an accepted stop', record('stop', { status: 'running', stopping: true, steps }), true, (run) => expect(run).toMatchObject({ status: 'cancelled', steps: [{ status: 'cancelled' }] })],
    ['an interrupted live run', record('live', { status: 'running', steps }), undefined, (run) => expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted'), steps: [{ status: 'failed' }] })],
    ['stale monitoring on a finished run', record('mon', { activity: 'monitoring', monitoringWakeAt: '2026-10-06T00:00:00.000Z' }), true, (run) => expect(run).not.toHaveProperty('activity')],
    ['a usage-limit resume on a run that is not failed', record('auto', { autoResumeAt: '2026-10-06T00:00:00.000Z' }), true, (run) => expect(run).not.toHaveProperty('autoResumeAt')],
    ['an exhausted wake cap from the previous process', record('cap', { status: 'running', monitoringWakeCapReached: true }), true, (run) => expect(run).not.toHaveProperty('monitoringWakeCapReached')],
    ['a referenced PR the created-PR declaration used to erase', record('heal', {
      markerRefs: { pr: 9 }, pullRequestUrl: 'https://github.com/o/r/pull/9', referencedPrCandidates: ['https://github.com/o/r/pull/4'],
    }), true, (run) => expect(run.referencedPullRequestUrl).toBe('https://github.com/o/r/pull/4')],
  ];

  it.each(cases)('%s', (_, seeded, keepLive, expectSaved) => {
    seedRuns(dataDir, [seeded, record('control')]);
    const store = open({ keepLive });
    const seen = writes(store);
    store.flush();
    expect(seen).toEqual([{ upserts: [seeded.id], deletes: [] }]);
    expectSaved(readPersistedRuns(dataDir).find((run) => run.id === seeded.id)!);
    expect(row('control')?.revision).toBe(1);
  });

  it('a refreshed pending human ask', () => {
    const root = record('root', { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [] } });
    seedRuns(dataDir, [root, record('control')]);
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const questions = [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }];
    writeFileSync(join(dataDir, 'runs', 'root.ndjson'),
      `${JSON.stringify({ seq: 1, ts: '2026-10-05T00:00:00.000Z', type: 'ask.requested', requestId: 'q1', questions })}\n`);
    const store = open({ keepLive: true });
    if (store.getRun('root')?.hasPendingHumanAsk !== true) throw new Error('fixture: the ask was not recognised');
    const seen = writes(store);
    store.flush();
    expect(seen).toEqual([{ upserts: ['root'], deletes: [] }]);
    expect(readPersistedRuns(dataDir).find((run) => run.id === 'root')?.hasPendingHumanAsk).toBe(true);
  });

  it('a store with nothing to normalize writes nothing', () => {
    seedRuns(dataDir, [record('a'), record('bb', { status: 'review' })]);
    const store = open();
    const seen = writes(store);
    store.flush();
    expect(seen).toEqual([]);
  });
});

describe('close', () => {
  it('writes what is pending, then saves nothing more and refuses durable commits', () => {
    vi.useFakeTimers();
    const store = RunStore.open(dataDir);
    const run = store.createRun({ title: 'x', workflow: 'w', task: 't', steps: [] });
    store.close();
    expect(readPersistedRuns(dataDir).map((saved) => saved.id)).toEqual([run.id]);
    expect(vi.getTimerCount()).toBe(0);

    store.updateRun(run.id, { title: 'after close' });
    expect(store.getRun(run.id)?.title).toBe('after close');
    expect(vi.getTimerCount()).toBe(0);
    store.flush();
    expect(() => store.commitDelegation([{ id: run.id, delegation: { role: 'invalid' } }])).toThrow('runs database unavailable');
    expect(() => store.close()).not.toThrow();
    expect(readPersistedRuns(dataDir)[0]?.title).toBe('x');
  });
});
