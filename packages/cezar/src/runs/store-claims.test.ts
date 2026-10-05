import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNS_DB_FILE, RunConflictError, RunDatabase } from './run-database.ts';
import { encodeRunRow } from './run-row.ts';
import { blockRunWrites, crashStore, readPersistedRuns, seedRuns } from './run-store.testkit.ts';
import { agentTmpDir } from './agent-tmpdir.ts';
import { WorkerScratchCleanup } from '../delegation/scratch-cleanup.ts';
import { RUN_IN_USE_ELSEWHERE, RunStore, RunWriteRefusedError, type RunRecord } from './store.ts';

/**
 * Two stores on one project (#779, plan step 3): `serve` and a headless `cez run` open the same
 * `runs.db`. Each writes only the delegation families it claims; the other's runs stay readable.
 * Two stores in one process stand in for two processes: their claims carry different sessions.
 * `run-claims.test.ts` covers a real second process (pid and start identity).
 */

const record = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, title: `run ${id}`, workflow: 'quick-task', task: `task ${id}`, status: 'done',
  createdAt: `2026-09-0${id.length % 9}T00:00:00.000Z`, tokensUsed: 0, archived: false, steps: [],
  ...over,
});

let dataDir: string;
const stores: RunStore[] = [];
const open = (opts?: { keepLive?: boolean }) => {
  const store = RunStore.open(dataDir, opts);
  stores.push(store);
  return store;
};
const db = () => RunDatabase.open(join(dataDir, RUNS_DB_FILE));
const persisted = (id: string) => readPersistedRuns(dataDir).find((run) => run.id === id);
/** Another writer that ignores claims: what a conflict looks like from inside a store. */
const writeBehindItsBack = (run: RunRecord | null, id = run?.id) => {
  const raw = db();
  try { raw.transaction({ upserts: run ? [encodeRunRow(run)] : [], deletes: run ? [] : [id!] }); } finally { raw.close(); }
};
/** A run's events, handoff and images on disk, as a finished run leaves them. */
const historyFiles = (id: string): string[] => {
  const runs = join(dataDir, 'runs');
  mkdirSync(join(runs, `${id}-images`), { recursive: true });
  writeFileSync(join(runs, `${id}.ndjson`), '{"seq":1}\n');
  writeFileSync(join(runs, `${id}.handoff.md`), '# handoff\n');
  writeFileSync(join(runs, `${id}-images`, 'shot.png'), 'png');
  return [join(runs, `${id}.ndjson`), join(runs, `${id}.handoff.md`), join(runs, `${id}-images`, 'shot.png')];
};
const conflicts = () => {
  const raw = db();
  try { return raw.listConflicts(); } finally { raw.close(); }
};
const claims = () => {
  const raw = db();
  try { return raw.listClaims(); } finally { raw.close(); }
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-store-claims-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('open leaves another live store\'s runs alone', () => {
  it('a headless open (no keepLive) does not settle serve\'s parked and monitoring runs as interrupted', () => {
    // T2b review: dirty-only saves no longer heal what another process wrote, so this used to
    // turn serve's parked run into `failed` for good once serve restarted.
    const serve = open({ keepLive: true });
    const parked = serve.createRun({ title: 'parked', workflow: 'w', task: 't', steps: [] });
    serve.updateRun(parked.id, { status: 'waiting' });
    const monitoring = serve.createRun({ title: 'monitoring', workflow: 'w', task: 't', steps: [] });
    serve.updateRun(monitoring.id, { status: 'running', activity: 'monitoring', monitoringWakeAt: '2026-10-05T12:00:00.000Z' });
    serve.flush();

    const headless = open();
    const heldThere = headless.heldIds();
    // Still readable there, as the owner wrote it.
    expect(headless.listRunSummaries().runs.map((run) => run.id).sort()).toEqual([parked.id, monitoring.id].sort());
    headless.close();

    expect(persisted(parked.id)).toMatchObject({ status: 'waiting' });
    expect(persisted(monitoring.id)).toMatchObject({ status: 'running', activity: 'monitoring' });
    expect(heldThere).toEqual([]);
    serve.close();
    const restarted = open({ keepLive: true });
    expect(restarted.getRun(parked.id)?.status).toBe('waiting');
    expect(restarted.getRun(monitoring.id)?.status).toBe('running');
  });

  it('still settles a live run nobody alive owns, as a headless open always has', () => {
    seedRuns(dataDir, [record('left-running', { status: 'running' })]);
    const headless = open();
    expect(headless.getRun('left-running')).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    headless.close();
    expect(persisted('left-running')).toMatchObject({ status: 'failed' });
  });
});

describe('another store\'s runs are readable and refuse writes', () => {
  it('answers reads, refuses every write, and leaves the row as its owner wrote it', () => {
    const owner = open({ keepLive: true });
    const run = owner.createRun({ title: 'theirs', workflow: 'w', task: 't', steps: [] });
    owner.appendEvent(run.id, { type: 'note', message: 'from the owner' });
    owner.flush();
    const other = open({ keepLive: true });

    expect(other.runOwnership(run.id)).toBe('foreign');
    expect(other.writeRefusal(run.id)).toBe(RUN_IN_USE_ELSEWHERE);
    expect(other.getRun(run.id)?.title).toBe('theirs');
    expect(other.readEvents(run.id).map((event) => event.type)).toEqual(['note']);

    expect(other.updateRun(run.id, { title: 'mine now' })).toBeUndefined();
    expect(other.setArchived(run.id, true)).toBeUndefined();
    expect(other.setRead(run.id)).toBeUndefined();
    expect(other.pin(run.id, 'continue')).toBeUndefined();
    expect(() => other.appendEvent(run.id, { type: 'note', message: 'not mine' })).toThrow(RunWriteRefusedError);
    expect(() => other.commitDelegation([{ id: run.id, delegation: { role: 'invalid' } }])).toThrow(RunWriteRefusedError);
    expect(other.deleteRun(run.id)).toBe(false);
    other.flush();

    expect(other.heldIds()).toEqual([]);
    expect(persisted(run.id)).toMatchObject({ title: 'theirs', archived: false });
    expect(owner.readEvents(run.id).map((event) => event.type)).toEqual(['note']);
  });

  it('sweeps skip another store\'s finished runs until it lets them go', () => {
    const owner = open({ keepLive: true });
    const run = owner.createRun({ title: 'done there', workflow: 'w', task: 't', steps: [] });
    owner.updateRun(run.id, { status: 'done', finishedAt: '2026-10-05T10:00:00.000Z' });
    owner.pin(run.id, 'active'); // still settling there
    owner.flush();
    const other = open({ keepLive: true });
    expect(other.markAllRead()).toBe(0);
    expect(other.archiveFinished()).toEqual({ archived: 0, ids: [], pinnedIds: [] });

    owner.unpin(run.id, 'active');
    owner.flush();
    expect(owner.heldIds()).toEqual([]);
    expect(claims()).toEqual([]);
    expect(other.runOwnership(run.id)).toBe('free');
    expect(other.markAllRead()).toBe(1);
    expect(other.archiveFinished().ids).toEqual([run.id]);
    other.flush();
    expect(persisted(run.id)).toMatchObject({ archived: true });
  });
});

describe('claims follow memory', () => {
  it('claims what it holds, releases a family once it leaves memory, and everything on close', () => {
    seedRuns(dataDir, [record('finished')]);
    const store = open({ keepLive: true });
    const live = store.createRun({ title: 'live', workflow: 'w', task: 't', steps: [] });
    expect(claims().map((claim) => claim.family)).toEqual([live.id]);
    expect(store.runOwnership(live.id)).toBe('held');

    store.setRead('finished');
    expect(claims().map((claim) => claim.family).sort()).toEqual(['finished', live.id].sort());
    store.flush();
    expect(claims().map((claim) => claim.family)).toEqual([live.id]);

    store.close();
    expect(claims()).toEqual([]);
  });

  it('a worker is claimed with its parent: one family', () => {
    const store = open({ keepLive: true });
    const root = store.createRun({ title: 'root', workflow: 'w', task: 't', steps: [] });
    store.commitDelegation([{ id: root.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
    store.flush();
    const other = open({ keepLive: true });
    // Only the row's columns matter here: `parent_run_id` files it under the root.
    const raw = db();
    try { raw.transaction({ upserts: [{ ...encodeRunRow(record('worker-1')), parentRunId: root.id }], deletes: [] }); } finally { raw.close(); }
    expect(other.runOwnership('worker-1')).toBe('foreign');
    expect(store.runOwnership('worker-1')).toBe('held');
  });

  it('takes over the claims of a store in this process that is gone without releasing them', () => {
    const gone = open({ keepLive: true });
    const run = gone.createRun({ title: 'left', workflow: 'w', task: 't', steps: [] });
    gone.flush();
    // A store that vanished without close(): its session is no longer open in this process.
    const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    raw.prepare("UPDATE run_claims SET session = 'a-session-nobody-opened'").run();
    raw.close();

    const other = open({ keepLive: true });
    expect(other.heldIds()).toEqual([run.id]);
    expect(other.runOwnership(run.id)).toBe('held');
  });
});

describe('deleting a run', () => {
  it('removes its history files once the delete commits, never before', () => {
    seedRuns(dataDir, [record('old')]);
    const files = historyFiles('old');
    const store = open();
    expect(store.deleteRun('old')).toBe(true);
    for (const file of files) expect(existsSync(file), file).toBe(true);
    store.flush();
    expect(persisted('old')).toBeUndefined();
    for (const file of files) expect(existsSync(file), file).toBe(false);
  });
});

describe('a run changed under this store', () => {
  it('fails the write unchanged, stores original/local/current, stops writing that row and lets the rest through', () => {
    const store = open({ keepLive: true });
    const a = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    const b = store.createRun({ title: 'b', workflow: 'w', task: 't', steps: [] });
    store.flush();
    const original = persisted(a.id);
    writeBehindItsBack({ ...original, title: 'a from elsewhere' });
    const events: string[] = [];
    store.on('run', (run: RunRecord) => events.push(`${run.id}:${run.title}`));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    store.updateRun(a.id, { title: 'a local' });
    store.updateRun(b.id, { title: 'b local' });
    let caught: unknown;
    try { store.commitDelegation([{ id: b.id, delegation: { role: 'invalid' } }]); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(RunConflictError);
    // The durable operation failed unchanged: b's commit installed nothing.
    expect(store.getRun(b.id)?.delegation).toBeUndefined();
    expect(conflicts()).toEqual([expect.objectContaining({
      runId: a.id, reason: 'changed', localDeleted: false,
      baseData: JSON.stringify(original),
      localData: expect.stringContaining('"title":"a local"'),
      currentData: expect.stringContaining('"title":"a from elsewhere"'),
    })]);
    // The corrected view, announced; the row is refused from now on.
    expect(store.getRun(a.id)?.title).toBe('a from elsewhere');
    expect(events).toContain(`${a.id}:a from elsewhere`);
    expect(store.runOwnership(a.id)).toBe('quarantined');
    // One line that names the run and where its evidence is.
    expect(errors.mock.calls.flat().join('\n')).toMatch(new RegExp(`run ${a.id} was changed by another writer .*run_conflicts, seq 1`));
    expect(store.updateRun(a.id, { title: 'again' })).toBeUndefined();
    expect(() => store.commitDelegation([{ id: a.id, delegation: { role: 'invalid' } }])).toThrow(RunWriteRefusedError);

    // Unrelated durable work proceeds.
    store.commitDelegation([{ id: b.id, delegation: { role: 'invalid' } }]);
    store.flush();
    expect(persisted(b.id)).toMatchObject({ title: 'b local', delegation: { role: 'invalid' } });
    expect(persisted(a.id)).toMatchObject({ title: 'a from elsewhere' });
  });

  it('keeps the changes pending when the evidence cannot be stored', () => {
    const store = open({ keepLive: true });
    const a = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    store.flush();
    writeBehindItsBack({ ...persisted(a.id), title: 'elsewhere' });
    const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    raw.exec("CREATE TRIGGER no_evidence BEFORE INSERT ON run_conflicts BEGIN SELECT RAISE(ABORT, 'evidence disk full'); END");
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    store.updateRun(a.id, { title: 'local' });
    store.flush();
    expect(errors.mock.calls.flat().join('\n')).toContain('could not record the conflicting write');
    expect(store.runOwnership(a.id)).toBe('held');
    expect(store.getRun(a.id)?.title).toBe('local');
    expect(conflicts()).toEqual([]);

    // Once evidence can be written, the next save meets the same conflict and settles it.
    raw.exec('DROP TRIGGER no_evidence');
    raw.close();
    store.flush();
    expect(conflicts()).toEqual([expect.objectContaining({ runId: a.id, localData: expect.stringContaining('"title":"local"') })]);
    expect(store.runOwnership(a.id)).toBe('quarantined');
    expect(store.getRun(a.id)?.title).toBe('elsewhere');
  });

  it('detects a row deleted under it and drops it, with its intent recorded', () => {
    const store = open({ keepLive: true });
    const a = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    store.flush();
    writeBehindItsBack(null, a.id);
    const deleted: string[] = [];
    store.on('deleted', (id: string) => deleted.push(id));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    store.updateRun(a.id, { title: 'local' });
    store.flush();
    expect(conflicts()).toEqual([expect.objectContaining({ runId: a.id, reason: 'deleted', currentData: null, localDeleted: false })]);
    expect(store.getRun(a.id)).toBeUndefined();
    expect(deleted).toEqual([a.id]);
    expect(persisted(a.id)).toBeUndefined();
  });

  it('records a deletion this store meant to make on a row that changed meanwhile', () => {
    seedRuns(dataDir, [record('old')]);
    const store = open({ keepLive: true });
    store.setRead('old');
    store.flush();
    store.pin('old', 'cleanup');
    writeBehindItsBack({ ...persisted('old'), title: 'touched elsewhere' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.unpin('old', 'cleanup');
    expect(store.deleteRun('old')).toBe(true);
    store.flush();
    expect(conflicts()).toEqual([expect.objectContaining({ runId: 'old', reason: 'changed', localDeleted: true, localData: null })]);
    expect(persisted('old')).toMatchObject({ title: 'touched elsewhere' });
  });

  it('keeps the history files of a deletion a conflict undid: the row is back, and so are its events', () => {
    seedRuns(dataDir, [record('old')]);
    const files = historyFiles('old');
    const store = open({ keepLive: true });
    store.setRead('old');
    store.flush();
    store.pin('old', 'cleanup');
    writeBehindItsBack({ ...persisted('old'), title: 'touched elsewhere' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.unpin('old', 'cleanup');
    expect(store.deleteRun('old')).toBe(true);
    store.flush();
    expect(persisted('old')).toMatchObject({ title: 'touched elsewhere' });
    for (const file of files) expect(existsSync(file), file).toBe(true);
  });

  it('never takes a row deleted and created again for the one it read, though its id is the same', () => {
    const store = open({ keepLive: true });
    const a = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    store.flush();
    const seen = persisted(a.id);
    // Deleted and written again under the same id, as many times as it takes per-row counters to
    // come back round to the revision this store holds.
    for (let i = 0; i < 3; i++) {
      writeBehindItsBack(null, a.id);
      writeBehindItsBack({ ...seen, title: `again ${i}` });
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.updateRun(a.id, { title: 'local' });
    store.flush();
    expect(conflicts()).toEqual([expect.objectContaining({ runId: a.id, reason: 'changed' })]);
    expect(persisted(a.id)).toMatchObject({ title: 'again 2' });
  });

  it('stops writing a family whose claim another writer took', () => {
    const store = open({ keepLive: true });
    const a = store.createRun({ title: 'a', workflow: 'w', task: 't', steps: [] });
    store.flush();
    const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    raw.prepare("UPDATE run_claims SET session = 'someone-else', generation = generation + 100").run();
    raw.close();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store.updateRun(a.id, { title: 'local' });
    store.flush();
    expect(conflicts()).toEqual([expect.objectContaining({ runId: a.id, reason: 'claim-lost' })]);
    expect(store.runOwnership(a.id)).toBe('quarantined');
    expect(persisted(a.id)).toMatchObject({ title: 'a' });
  });
});

describe('a run nobody alive owns', () => {
  it('a live row without a live owner is orphaned: writes leave it alone until it is adopted', () => {
    const gone = open({ keepLive: true });
    const run = gone.createRun({ title: 'left running', workflow: 'w', task: 't', steps: [] });
    gone.updateRun(run.id, { status: 'running' });
    gone.flush();
    const store = open({ keepLive: true });
    expect(store.runOwnership(run.id)).toBe('foreign');
    crashStore(gone);

    expect(store.runOwnership(run.id)).toBe('orphaned');
    // An ordinary write must not inherit it: the manager adopts and recovers it first.
    expect(store.updateRun(run.id, { title: 'mine' })).toBeUndefined();
    expect(store.adoptFamily(run.id)).toBe(run.id);
    expect(store.runOwnership(run.id)).toBe('held');
    // Adopted for a control, it is settled, never kept running for recovery to resume.
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    expect(store.updateRun(run.id, { title: 'mine' })?.title).toBe('mine');
  });

  it('a busy database does not refuse a write: its own transaction takes the claim', () => {
    seedRuns(dataDir, [record('finished')]);
    const store = open({ keepLive: true });
    const release = blockRunWrites(dataDir);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Before #779 an optimistic write never touched the database; it still does not fail.
      expect(store.setRead('finished')?.seenAt).toBeDefined();
      expect(claims()).toEqual([]);
      store.flush();
      expect(errors.mock.calls.flat().join('\n')).toContain('database is locked');
    } finally {
      release();
    }
    store.flush();
    expect(persisted('finished')?.seenAt).toBeDefined();
    // Taken with the write, then released once the run left memory.
    expect(claims()).toEqual([]);
  });

  it('keeps another live process\'s agent scratch when it sweeps for orphans', () => {
    const owner = open({ keepLive: true });
    const run = owner.createRun({ title: 'theirs', workflow: 'w', task: 't', steps: [] });
    owner.updateRun(run.id, { status: 'running' });
    owner.flush();
    const scratch = agentTmpDir(dataDir, run.id);
    mkdirSync(scratch, { recursive: true });
    const store = open({ keepLive: true });
    new WorkerScratchCleanup(store, dataDir, () => false).recover();
    expect(existsSync(scratch)).toBe(true);
  });
});
