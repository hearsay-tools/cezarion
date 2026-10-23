import type { ArchivePullRequestIdentity } from '@open-mercato/cezar-contract';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';
import { fetchMergedPullRequests } from './forge/github.ts';

const dirs: string[] = [], stores: RunStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture(families = 1, prs = 1) {
  const root = mkdtempSync(join(tmpdir(), 'cez-archive-coordinator-')); dirs.push(root);
  const ids = Array.from({ length: families }, () => randomUUID()); const id = ids[0]!; const dataDir = join(root, '.ai/cezar');
  seedRuns(dataDir, ids.map(id => ({ id, task: 'task', title: 'task', workflow: 'quick-task', status: 'review', steps: [], createdAt: '2026-01-01T00:00:00.000Z', archived: false, tokensUsed: 0, pullRequests: Array.from({ length: prs }, (_, i) => ({ number: 42 + i, source: 'declared' })) })));
  const store = RunStore.open(dataDir, { keepLive: true, maintenance: true }); stores.push(store);
  let enabled = true;
  const lookup = vi.fn(async (_root: string, identities: ArchivePullRequestIdentity[]) => identities.map(pr => ({ ...pr, mergedAt: '2026-01-02T00:00:00.000Z' })));
  const withStore = vi.fn(async (_project, work) => work(store, () => false, () => true));
  const coordinator = new ArchiveOnMergeCoordinator({
    projects: async () => [{ id: 'p', root, status: 'ok' }],
    enabled: async () => enabled,
    repository: async () => 'https://github.com/o/r',
    withStore,
    lookup,
  });
  return { coordinator, store, id, ids, lookup, withStore, disable: () => { enabled = false; } };
}
it('runs without a browser or agent, commits once and adds no calls while disabled', async () => {
  const f = fixture(); f.disable(); await f.coordinator.tick(); expect(f.lookup).not.toHaveBeenCalled(); expect(f.withStore).not.toHaveBeenCalled();
  const g = fixture(); await g.coordinator.tick(); expect(g.store.getRun(g.id)?.archived).toBe(true);
  await g.coordinator.tick(); expect(g.lookup).toHaveBeenCalledTimes(1);
});
it.each(['disable', 'restore', 'stop', 'continue'] as const)('invalidates late network results after %s', async action => {
  const f = fixture();
  f.lookup.mockImplementationOnce(async (_root: string, identities: ArchivePullRequestIdentity[]) => {
    if (action === 'disable') f.disable();
    if (action === 'restore') { f.store.setArchived(f.id, true); f.store.setArchived(f.id, false); }
    if (action === 'continue') f.store.updateRun(f.id, { status: 'running' });
    if (action === 'stop') f.coordinator.stop();
    return identities.map(pr => ({ ...pr, mergedAt: '2026-01-02T00:00:00.000Z' }));
  });
  await f.coordinator.tick(); expect(f.store.getRun(f.id)?.archived).toBe(false);
});
it('defers missing or wrong-repository observations and retries after an outage', async () => {
  const f = fixture();
  f.lookup.mockResolvedValueOnce([{ owner: 'wrong', repo: 'r', number: 42, mergedAt: '2026-01-02T00:00:00.000Z' }]);
  await f.coordinator.tick(); expect(f.store.getRun(f.id)?.archived).toBe(false);
  f.lookup.mockRejectedValueOnce(new Error('offline'));
  await f.coordinator.tick(); expect(f.store.getRun(f.id)?.archived).toBe(false);
});

it('archives a merged family when a different family declares a nonexistent PR', async () => {
  const f = fixture(2);
  f.store.updateRun(f.ids[1]!, { pullRequests: [{ number: 43, source: 'declared' }] }); f.store.flush();
  f.lookup.mockImplementation(async (_root, identities) => fetchMergedPullRequests(async query => {
    const repository = { nameWithOwner: 'o/r', pr42: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'MERGED', mergedAt: '2026-01-02T00:00:00Z' }, pr43: null };
    if (query.includes('pr43:')) throw Object.assign(new Error('gh: Could not resolve PR 43'), {
      code: 1, stdout: JSON.stringify({ data: { repository }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pr43'] }] }),
    });
    return JSON.stringify({ data: { repository } });
  }, identities));
  await f.coordinator.tick();
  expect(f.store.getRun(f.id)?.archived).toBe(true);
  expect(f.store.getRun(f.ids[1]!)?.archived).toBe(false);
});

it.each([0, 32])('eventually checks complete large PR sets across more than 32 families with %i open sets', async openSets => {
  const f = fixture(36, 65);
  for (const id of f.ids.slice(0, openSets)) {
    f.store.updateRun(id, { pullRequests: Array.from({ length: 65 }, (_, i) => ({ number: 1000 + i, source: 'declared' })) });
  }
  f.store.flush();
  f.lookup.mockImplementation(async (_root, identities) => identities.filter(pr => pr.number < 1000).map(pr => ({ ...pr, mergedAt: '2026-01-02T00:00:00.000Z' })));
  for (let i = 0; i < 100; i++) await f.coordinator.tick();
  expect(f.ids.slice(openSets).every(id => f.store.getRun(id)?.archived)).toBe(true);
  expect(f.ids.slice(0, openSets).every(id => !f.store.getRun(id)?.archived)).toBe(true);
  expect(f.lookup.mock.calls.every(([, requests]) => requests.length <= 256)).toBe(true);
});

it('shows the unresolved PR as a blocker instead of silently hiding the reason', async () => {
  const f = fixture(); f.lookup.mockResolvedValueOnce([]);
  await f.coordinator.tick();
  expect(f.store.getRun(f.id)?.archiveBlocker).toMatchObject({ runId: f.id, pullRequestUrl: 'https://github.com/o/r/pull/42', message: expect.stringContaining('not confirmed merged') });
  await f.coordinator.tick(); expect(f.store.getRun(f.id)?.archived).toBe(true);
  expect(f.store.getRun(f.id)?.archiveBlocker).toBeUndefined();
});
