import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationState } from '@open-mercato/cezar-contract';

import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';
import { blockRunWrites, readPersistedRuns, runIds, seedRuns } from './run-store.testkit.ts';
import { RunStore, type RunRecord } from './store.ts';

/**
 * The held set (#779, Amendment 2): `RunStore` keeps only live runs, the runs a RunManager pins,
 * their delegation families and unsettled writes in memory. Everything else is read from
 * `runs.db` on demand.
 */

let dataDir: string;
const stores: RunStore[] = [];
const open = (opts?: { keepLive?: boolean }) => {
  const store = RunStore.open(dataDir, opts);
  stores.push(store);
  return store;
};

let clock = 0;
const record = (over: Partial<RunRecord> = {}): RunRecord => {
  clock++;
  return {
    id: randomUUID(), title: `run ${clock}`, workflow: 'quick-task', task: 'task', status: 'done',
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, clock)).toISOString(), finishedAt: new Date(Date.UTC(2026, 8, 1, 1, clock)).toISOString(),
    tokensUsed: 0, archived: false, steps: [], ...over,
  };
};
const rootDelegation = (): DelegationState => ({ role: 'root', permissions: ['spawn', 'wait'], receipts: [] });
const workerDelegation = (parentRunId: string, id: string): DelegationState => ({
  role: 'worker', parentRunId, permissions: [],
  workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
});
/** A root and its workers, each with the given status. */
function family(rootStatus: RunRecord['status'], workerStatuses: Array<RunRecord['status']>): RunRecord[] {
  const root = record({ status: rootStatus, delegation: rootDelegation() });
  return [root, ...workerStatuses.map((status) => {
    const id = randomUUID();
    return record({ id, status, delegation: workerDelegation(root.id, id) });
  })];
}
const ids = (runs: readonly RunRecord[]) => runs.map((run) => run.id).sort();
const held = (store: RunStore) => store.heldIds().sort();

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-live-set-'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('open', () => {
  it('holds exactly the live runs and their delegation families', () => {
    const live = [
      record({ status: 'queued' }), record({ status: 'running' }), record({ status: 'waiting' }),
      record({ status: 'failed', autoResumeAt: '2099-01-01T00:00:00.000Z' }),
    ];
    const finished = [record(), record({ status: 'review' }), record({ status: 'failed' }), record({ status: 'cancelled', archived: true })];
    // A finished root whose one running worker keeps the whole family in memory…
    const liveFamily = family('done', ['done', 'running', 'failed']);
    // …and a family with nobody live, which stays on disk.
    const deadFamily = family('done', ['done', 'cancelled']);
    seedRuns(dataDir, [...live, ...finished, ...liveFamily, ...deadFamily]);

    const store = open({ keepLive: true });

    expect(held(store)).toEqual(ids([...live, ...liveFamily]));
    // The rest is still there, on demand.
    expect(runIds(store).sort()).toEqual(ids([...live, ...finished, ...liveFamily, ...deadFamily]));
    for (const run of [...finished, ...deadFamily]) expect(store.getRun(run.id)?.title).toBe(run.title);
  });

  it('decodes no finished row it does not hold', () => {
    const finished = Array.from({ length: 5 }, () => record());
    const running = record({ status: 'running' });
    seedRuns(dataDir, [...finished, running]);
    const decoded = vi.spyOn(JSON, 'parse');
    open({ keepLive: true });
    const records = decoded.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('"steps"'));
    expect(records.map(([text]) => JSON.parse(text as string).id)).toEqual([running.id]);
  });

  it('repairs a finished row whose stored summary lags a load normalization, then lets it go', () => {
    // Written before `referencedPrDeclaration`: the created PR's re-declaration erased the about-PR.
    const legacy = record({
      task: 'review the change', markerRefs: { pr: 7 }, pullRequestUrl: 'https://github.com/o/r/pull/7',
      referencedPrCandidates: ['https://github.com/o/r/pull/3'],
    });
    seedRuns(dataDir, [legacy, record({ markerRefs: { pr: 9 } })]);
    const store = open();
    expect(held(store)).toEqual([legacy.id]);
    store.flush();
    expect(held(store)).toEqual([]);
    const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE))!;
    try {
      expect(JSON.parse(db.get(legacy.id)!.summary).referencedPullRequestUrl).toBe('https://github.com/o/r/pull/3');
    } finally {
      db.close();
    }
  });
});

describe('reading a finished run', () => {
  it('answers a fresh copy every time, frozen under vitest', () => {
    const done = record();
    seedRuns(dataDir, [done]);
    const store = open();
    const first = store.getRun(done.id)!;
    const second = store.getRun(done.id)!;
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(() => { first.title = 'lost'; }).toThrow(TypeError);
    expect(() => { first.steps.push({} as never); }).toThrow(TypeError);
    expect(held(store)).toEqual([]);
  });

  it('answers the held object for a live run, so a commit installs into what the caller holds', () => {
    const running = record({ status: 'running' });
    seedRuns(dataDir, [running]);
    const store = open({ keepLive: true });
    const heldRecord = store.getRun(running.id)!;
    expect(store.getRun(running.id)).toBe(heldRecord);
    store.commitQueuedMessageDelivery(running.id, 'none');
    store.updateRun(running.id, { title: 'renamed' });
    expect(heldRecord.title).toBe('renamed');
  });
});

describe('writing a finished run', () => {
  it('goes through the store, persists the row and emits, then the run leaves memory', () => {
    const done = record();
    seedRuns(dataDir, [done]);
    const store = open();
    const emitted: RunRecord[] = [];
    store.on('run', (run: RunRecord) => emitted.push(run));

    const read = store.setRead(done.id)!;
    expect(emitted).toEqual([read]);
    expect(read.seenAt).toBeDefined();
    // Until its write settles it is held, and reads see the write.
    expect(store.getRun(done.id)).toBe(read);
    store.flush();
    expect(held(store)).toEqual([]);
    expect(readPersistedRuns(dataDir)[0].seenAt).toBe(read.seenAt);
    expect(store.getRun(done.id)?.seenAt).toBe(read.seenAt);
  });

  it('keeps a dirty row in memory while its save fails, and lets it go once it lands', () => {
    const done = record();
    seedRuns(dataDir, [done]);
    const store = open();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = blockRunWrites(dataDir);
    store.updateRun(done.id, { title: 'pending' });
    store.flush();
    expect(held(store)).toEqual([done.id]);
    expect(store.getRun(done.id)?.title).toBe('pending');
    release();
    store.flush();
    expect(held(store)).toEqual([]);
    expect(store.getRun(done.id)?.title).toBe('pending');
  });

  it('never evicts a run inside a pending durable commit, even when a listener saves mid-commit', () => {
    const first = record({ status: 'queued', delegation: rootDelegation() });
    const second = record({ status: 'review' });
    seedRuns(dataDir, [first, second]);
    const store = open({ keepLive: true });
    const events: string[] = [];
    store.on('run', (run: RunRecord) => { events.push(`run ${run.id}`); store.flush(); });
    store.on('deleted', (id: string) => events.push(`deleted ${id}`));
    const internal = store as unknown as { commitIndex(staged: Map<string, RunRecord>): void };
    internal.commitIndex(new Map([[first.id, { ...store.getRun(first.id)!, title: 'one' }], [second.id, { ...store.getRun(second.id)!, title: 'two' }]]));
    expect(events).toEqual([`run ${first.id}`, `run ${second.id}`]);
    store.flush();
    expect(held(store)).toEqual([first.id]);
    expect(store.getRun(second.id)?.title).toBe('two');
  });
});

describe('pins', () => {
  it('holds a finished run per holder: releasing one holder never releases another', () => {
    const done = record();
    seedRuns(dataDir, [done]);
    const store = open();
    const pinned = store.pin(done.id, 'active')!;
    store.pin(done.id, 'continue');
    expect(store.getRun(done.id)).toBe(pinned);
    expect(store.listRuns()).toEqual([pinned]);
    store.unpin(done.id, 'continue');
    store.flush();
    expect(store.getRun(done.id)).toBe(pinned);
    store.unpin(done.id, 'active');
    store.flush();
    expect(held(store)).toEqual([]);
    expect(store.listRuns()).toEqual([]);
  });

  it('answers nothing for a run that does not exist', () => {
    const store = open();
    expect(store.pin('missing', 'active')).toBeUndefined();
    expect(held(store)).toEqual([]);
  });
});

describe('the live set stays in memory', () => {
  it.each([
    ['a parked run', { status: 'waiting' as const }],
    ['a monitoring run', { status: 'running' as const, activity: 'monitoring' as const, monitoringWakeAt: '2099-01-01T00:00:00.000Z' }],
    ['a run waiting out a usage limit', { status: 'failed' as const, autoResumeAt: '2099-01-01T00:00:00.000Z' }],
  ])('%s', (_name, over) => {
    const run = record(over);
    seedRuns(dataDir, [run]);
    const store = open({ keepLive: true });
    store.updateRun(run.id, { title: 'touched' });
    store.flush();
    expect(held(store)).toEqual([run.id]);
    expect(store.listRuns().map((r) => r.id)).toEqual([run.id]);
  });

  it('lets a run go once it finishes and its last write settles', () => {
    const run = record({ status: 'running' });
    seedRuns(dataDir, [run]);
    const store = open({ keepLive: true });
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });
    expect(held(store)).toEqual([run.id]);
    store.flush();
    expect(held(store)).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('done');
  });

  it('lets a whole family go when its last live worker settles', () => {
    const [root, ...workers] = family('done', ['done', 'running']);
    const others = family('running', ['done']);
    seedRuns(dataDir, [root!, ...workers, ...others]);
    const store = open({ keepLive: true });
    expect(held(store)).toEqual(ids([root!, ...workers, ...others]));
    const live = workers[1]!;
    store.updateRun(live.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.flush();
    expect(held(store)).toEqual(ids(others));
  });

  it('holds a cold family member it reads while the family is live, and never a grandchild', () => {
    const [root, done] = family('running', ['done']);
    seedRuns(dataDir, [root!]);
    const store = open({ keepLive: true });
    expect(held(store)).toEqual([root!.id]);
    // A worker that reached runs.db by another path, read once: it belongs to a live family.
    seedRuns(dataDir, [root!, done!, (() => { const id = randomUUID(); return record({ id, delegation: workerDelegation(done!.id, id) }); })()]);
    const read = store.getRun(done!.id)!;
    expect(store.getRun(done!.id)).toBe(read);
    expect(store.listWorkersOf(done!.id)).toHaveLength(1);
    store.flush();
    expect(held(store)).toEqual(ids([root!, done!]));
  });
});

describe('list rows', () => {
  it('lay memory over the stored summary: unsaved changes, new runs and pending deletions', () => {
    vi.useFakeTimers();
    const kept = record({ title: 'stored title', status: 'running' });
    const gone = record();
    seedRuns(dataDir, [kept, gone, record()]);
    const store = open({ keepLive: true });
    store.updateRun(kept.id, { title: 'unsaved title' });
    const created = store.createRun({ title: 'new', workflow: 'w', task: 't', steps: [] });
    expect(store.deleteRun(gone.id)).toBe(true);

    const rows = store.listRunSummaries().runs;
    expect(rows.map((row) => row.id)).not.toContain(gone.id);
    expect(rows[0]?.id).toBe(created.id);
    expect(rows.find((row) => row.id === kept.id)?.title).toBe('unsaved title');
    // The row on disk is still behind.
    expect(readPersistedRuns(dataDir).find((run) => run.id === kept.id)?.title).toBe('stored title');
  });

  it('serve the stored projection, byte for byte, for a run not in memory', () => {
    const done = record({ pinned: true, diffStat: { adds: 1, dels: 2, files: 3 } });
    seedRuns(dataDir, [done]);
    const store = open();
    const db = RunDatabase.openReadOnly(join(dataDir, RUNS_DB_FILE))!;
    try {
      expect(JSON.stringify(store.listRunSummaries().runs[0])).toBe(db.get(done.id)!.summary);
    } finally {
      db.close();
    }
  });

  it('cap archived roots at the window and say so, never unarchived runs', () => {
    const archived = Array.from({ length: 4 }, () => record({ archived: true }));
    const active = record();
    seedRuns(dataDir, [active, ...archived]);
    const store = open();
    expect(store.listRunSummaries({ archivedWindow: 3 })).toMatchObject({ truncated: true });
    expect(store.listRunSummaries({ archivedWindow: 3 }).runs.map((row) => row.id))
      .toEqual([active, ...archived.slice(1).reverse()].map((run) => run.id));
    expect(store.listRunSummaries({ archivedWindow: 4 }).truncated).toBe(false);
  });

  it('list only the live set from listRuns', () => {
    const running = record({ status: 'running' });
    seedRuns(dataDir, [running, record(), record({ status: 'review' })]);
    expect(open({ keepLive: true }).listRuns().map((run) => run.id)).toEqual([running.id]);
  });
});

describe('indexed queries reach runs not in memory', () => {
  it('find a run by its client request id, a group, the worktree owners and the branch owners', () => {
    const requested = record({ clientRequestId: 'client-1' });
    const variantA = record({ groupId: 'g', variant: 'A' });
    const variantB = record({ groupId: 'g', variant: 'B' });
    const tree = record({ worktreePath: '/w/t', branch: 'cez/t', baseBranch: 'main', pullRequestUrl: 'https://github.com/o/r/pull/1' });
    const reclaimed = record({ worktreePath: '/w/r', worktreeReclaimedAt: '2026-09-02T00:00:00.000Z' });
    // No branch, but git-log attribution maps its squash commit by PR number.
    const prOnly = record({ worktree: false, pullRequestUrl: 'https://github.com/o/r/pull/9' });
    seedRuns(dataDir, [requested, variantA, variantB, tree, reclaimed, prOnly]);
    const store = open();
    expect(store.findRunByClientRequestId('client-1')?.id).toBe(requested.id);
    expect(store.findRunByClientRequestId('client-2')).toBeUndefined();
    expect(ids(store.listGroupRuns('g'))).toEqual(ids([variantA, variantB]));
    expect(store.listRunsWithWorktree().map((run) => run.id)).toEqual([tree.id]);
    expect(store.listBranchOwners().find((owner) => owner.id === tree.id)).toEqual({
      id: tree.id, title: tree.title, status: 'done', archived: false, createdAt: tree.createdAt, branch: 'cez/t', baseBranch: 'main',
      pullRequestUrl: 'https://github.com/o/r/pull/1',
    });
    expect(store.listBranchOwners().find((owner) => owner.id === prOnly.id)).toEqual({
      id: prOnly.id, title: prOnly.title, status: 'done', archived: false, createdAt: prOnly.createdAt, pullRequestUrl: 'https://github.com/o/r/pull/9',
    });
    expect(store.listBranchOwners().map((owner) => owner.id)).not.toContain(variantA.id);
    expect(held(store)).toEqual([]);
  });

  it("list a parent's workers and every worker id", () => {
    const [root, ...workers] = family('done', ['done', 'failed']);
    seedRuns(dataDir, [root!, ...workers, record()]);
    const store = open();
    expect(ids(store.listWorkersOf(root!.id))).toEqual(ids(workers));
    expect(store.listWorkerIds().sort()).toEqual(ids(workers));
    expect(store.listRunIds()).toHaveLength(4);
  });

  it('let archive-finished and mark-all-read reach every finished run', () => {
    const unread = record({ status: 'done' });
    const read = record({ status: 'done', seenAt: '2099-01-01T00:00:00.000Z' });
    const scheduled = record({ status: 'failed', autoResumeAt: '2099-01-01T00:00:00.000Z' });
    seedRuns(dataDir, [unread, read, scheduled]);
    const store = open({ keepLive: true });
    expect(store.markAllRead()).toBe(1);
    expect(store.archiveFinished()).toMatchObject({ archived: 2, ids: [read.id, unread.id] });
    store.flush();
    expect(readPersistedRuns(dataDir).filter((run) => run.archived).map((run) => run.id).sort()).toEqual(ids([unread, read]));
    expect(held(store)).toEqual([scheduled.id]);
  });

  it('heal a stored foreign reference once the repository handle arrives', () => {
    const foreign = record({ task: 'unrelated', referencedPullRequestUrl: 'https://github.com/other/repo/pull/5', referencedPrCandidates: ['https://github.com/other/repo/pull/5'] });
    const own = record({ task: 'ours', referencedPullRequestUrl: 'https://github.com/me/repo/pull/6', referencedPrCandidates: ['https://github.com/me/repo/pull/6'] });
    seedRuns(dataDir, [foreign, own]);
    const store = open();
    store.setRepoHandle({ owner: 'me', name: 'repo' });
    expect(store.listRunSummaries().runs.find((row) => row.id === foreign.id)?.referencedPullRequestUrl).toBeUndefined();
    expect(held(store)).toEqual([]);
    const persisted = readPersistedRuns(dataDir);
    expect(persisted.find((run) => run.id === foreign.id)?.referencedPullRequestUrl).toBeUndefined();
    expect(persisted.find((run) => run.id === own.id)?.referencedPullRequestUrl).toBe('https://github.com/me/repo/pull/6');
  });
});
