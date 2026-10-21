import { readHistoryText, historyPaths } from './history-file.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from './store.ts';
import { seedRuns, blockRunWrites, readPersistedRuns } from './run-store.testkit.ts';
import { archivePullRequests } from './pull-requests.ts';
import { registerRunProcess, unregisterRunProcess } from '../core/process-usage.ts';

const processProbes = vi.hoisted(() => ({ scan: vi.fn(() => new Map<number, string>()), unshared: vi.fn() }));
vi.mock('../delegation/process-liveness.ts', async original => {
  const actual = await original<typeof import('../delegation/process-liveness.ts')>();
  return { ...actual,
    sharedCwdScan: () => actual.sharedCwdScan(processProbes.scan),
    inspectGeneration: (input: Parameters<typeof actual.inspectGeneration>[0]) => {
      if (!input.cwds) processProbes.unshared();
      return actual.inspectGeneration(input);
    },
  };
});

const repo = 'https://github.com/o/r';
const pr = { number: 42, source: 'declared' as const };
const mergedAt = '2026-01-02T00:00:00.000Z';
const dirs: string[] = [];
const stores: RunStore[] = [];
function setup(overrides: Partial<RunRecord> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-autoarchive-')); dirs.push(dir);
  const run = { id: randomUUID(), title: 'task', task: 'task', workflow: 'quick-task', status: 'done', createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [], pullRequests: [pr], ...overrides };
  seedRuns(dir, [run]);
  const store = RunStore.open(dir, { keepLive: true }); stores.push(store);
  return { dir, store, id: run.id };
}
function observations(snapshot: NonNullable<ReturnType<RunStore['archiveOnMergeSnapshot']>>) {
  return snapshot.pullRequests.map(identity => ({ ...identity, mergedAt }));
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('authoritative archive associations', () => {
  it('requires all canonical identities and never substitutes a local same-number PR', () => {
    expect(archivePullRequests([{ pullRequests: [pr, { ...pr, url: 'https://github.com/foreign/repo/pull/42' }] }], repo)).toEqual([
      { owner: 'foreign', repo: 'repo', number: 42 }, { owner: 'o', repo: 'r', number: 42 },
    ]);
    expect(archivePullRequests([{ pullRequests: [pr] }])).toBeUndefined();
    expect(archivePullRequests([{ pullRequests: [{ ...pr, url: `${repo}/pull/43` }] }], repo)).toBeUndefined();
  });
  it('accepts only verified local legacy created links and rejects display-only evidence', () => {
    expect(archivePullRequests([{ pullRequestUrl: `${repo}/pull/42` }], repo)).toEqual([{ owner: 'o', repo: 'r', number: 42 }]);
    expect(archivePullRequests([{ pullRequestUrl: 'https://github.com/foreign/repo/pull/42' }], repo)).toBeUndefined();
    expect(archivePullRequests([{ pullRequests: [], pullRequestUrl: `${repo}/pull/42` }], repo)).toBeUndefined();
    expect(archivePullRequests([{ referencedPullRequestUrl: `${repo}/pull/42`, prNumber: 42 }], repo)).toBeUndefined();
  });
});

describe('guarded automatic archive', () => {
  it('durably commits a receipt and suppresses replays after unarchive and restart', () => {
    const { store, id, dir } = setup();
    const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
    expect(store.archiveAfterMerge(snapshot, observations(snapshot), repo)).toBe(true);
    expect(readPersistedRuns(dir)[0]).toMatchObject({ archived: true, autoArchive: { reason: 'pull-requests-merged', fingerprint: snapshot.fingerprint } });
    store.setArchived(id, false); store.flush();
    expect(store.getRun(id)).toMatchObject({ archived: false, manualUnarchivedAt: expect.any(String), autoArchive: { fingerprint: snapshot.fingerprint } });
    expect(store.archiveOnMergeSnapshot(id, repo)).toBeUndefined();
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = RunStore.open(dir, { keepLive: true }); stores.push(reopened);
    expect(reopened.archiveOnMergeSnapshot(id, repo)).toBeUndefined();
  });
  it('lets a manual restore during lookup win and does not archive old merges after a manual archive', () => {
    const { store, id } = setup();
    const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
    store.setArchived(id, true); store.setArchived(id, false);
    expect(store.archiveAfterMerge(snapshot, observations(snapshot), repo)).toBe(false);
    const fresh = store.archiveOnMergeSnapshot(id, repo)!;
    expect(store.archiveAfterMerge(fresh, observations(fresh), repo)).toBe(false);
  });
  it.each([{ status: 'waiting' }, { activity: 'monitoring' }, { waits: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'timer', source: 'agent', via: 'cezar_wait',
    registeredAt: '2026-12-31T23:55:00.000Z', deadline: '2027-01-01T00:00:00.000Z', phase: 'open', turnId: 'turn', seconds: 300 }] }, { waits: [{ id: '33333333-3333-4333-8333-333333333333', kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: '2026-12-31T23:55:00.000Z', phase: 'open', turnId: 'turn' }] }, { hasPendingPermission: true }, { delegation: { role: 'invalid', reason: 'bad' } }])('defers live/uncertain evidence %j', overrides => {
    const { store, id } = setup(overrides as Partial<RunRecord>);
    expect(store.archiveOnMergeSnapshot(id, repo)).toBeUndefined();
  });
  it('refuses incomplete merge observations, association changes, pins and registered processes', () => {
    const { store, id } = setup(); const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
    expect(store.archiveAfterMerge(snapshot, [], repo)).toBe(false);
    store.pin(id, 'active'); expect(store.archiveOnMergeSnapshot(id, repo)).toBeUndefined(); store.unpin(id, 'active');
    registerRunProcess(id, process.pid); expect(store.archiveOnMergeSnapshot(id, repo)).toBeUndefined(); unregisterRunProcess(id);
    store.updateRun(id, { pullRequests: [pr, { number: 43, source: 'declared' }] });
    expect(store.archiveAfterMerge(snapshot, observations(snapshot), repo)).toBe(false);
  });
  it('publishes neither archive nor receipt when the durable write fails', () => {
    const { store, id, dir } = setup(); const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
    const unblock = blockRunWrites(dir);
    try { expect(() => store.archiveAfterMerge(snapshot, observations(snapshot), repo)).toThrow(); }
    finally { unblock(); }
    expect(store.getRun(id)?.archived).toBe(false);
    expect(readPersistedRuns(dir)[0]).not.toHaveProperty('autoArchive');
  });
  it('allows a new set whose last merge happened after restoration', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
      const { store, id } = setup();
      store.setArchived(id, true); store.setArchived(id, false); store.flush();
      store.updateRun(id, { pullRequests: [pr, { number: 43, source: 'declared' }] }); store.flush();
      vi.setSystemTime(new Date('2026-01-05T00:00:00Z'));
      const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
      expect(store.archiveAfterMerge(snapshot, snapshot.pullRequests.map(identity => ({ ...identity, mergedAt: identity.number === 43 ? '2026-01-04T00:00:00Z' : mergedAt })), repo)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('preserves transcript bytes through automatic compression and manual restore', async () => {
    const { store, id, dir } = setup();
    const history = '{"seq":1,"type":"note","text":"keep this history"}\n';
    writeFileSync(historyPaths(dir, id).plain, history);
    await store.prepareArchiveOnMerge(id);
    const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
    expect(store.archiveAfterMerge(snapshot, observations(snapshot), repo)).toBe(true);
    await store.historyIdle();
    expect(existsSync(historyPaths(dir, id).compressed)).toBe(true);
    expect(readHistoryText(dir, id)).toBe(history);
    store.setArchived(id, false);
    expect(existsSync(historyPaths(dir, id).plain)).toBe(true);
    expect(readHistoryText(dir, id)).toBe(history);
  });

  it('includes worker-only PRs, blocks unfinished execution, and commits the whole cascade', () => {
    const { store, id, dir } = setup({ pullRequests: undefined });
    store.updateRun(id, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const worker = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude', steps: [] }, id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: id, workspace: { ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated', path: join(dir, 'absent-worktree'), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
    }, 'a'.repeat(64));
    store.updateRun(worker.id, { pullRequests: [pr] }); store.flush();
    expect(store.archiveOnMergeSnapshot(id, repo)).toBeUndefined();
    store.commitWorkerCancellation(worker.id);
    expect(store.archiveOnMergeSnapshot(id, repo)).toBeUndefined();
    const proof = store.readWorkerExecution(worker.id)!;
    expect(store.commitWorkerExecutionComplete(worker.id, proof.generation)).toBe(true);
    store.flush();
    mkdirSync(join(dir, 'absent-worktree'));
    mkdirSync(join(dir, 'root-worktree'));
    store.updateRun(id, { worktreePath: join(dir, 'root-worktree') }); store.flush();
    processProbes.scan.mockClear(); processProbes.unshared.mockClear();
    const snapshot = store.archiveOnMergeSnapshot(id, repo)!;
    expect(snapshot?.pullRequests).toEqual([{ owner: 'o', repo: 'r', number: 42 }]);
    expect(processProbes.scan).toHaveBeenCalledTimes(1);
    const seen: boolean[][] = [];
    store.on('run', () => seen.push([store.getRun(id)!.archived, store.getRun(worker.id)!.archived]));
    expect(store.archiveAfterMerge(snapshot, observations(snapshot), repo)).toBe(true);
    expect(processProbes.scan).toHaveBeenCalledTimes(2);
    expect(processProbes.unshared).not.toHaveBeenCalled();
    expect(seen.every(pair => pair.every(Boolean))).toBe(true);
    expect(readPersistedRuns(dir).every(run => run.archived)).toBe(true);
  });

  it('enumerates eligible roots in bounded pages', () => {
    const { store, id } = setup();
    expect(store.listArchiveOnMergeCandidates(0, 1)).toEqual([{ id, seq: expect.any(Number) }]);
    const page = store.listArchiveOnMergeCandidates(0, 1);
    expect(store.listArchiveOnMergeCandidates(page[0]!.seq, 1)).toEqual([]);
  });
});
