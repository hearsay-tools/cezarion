import type { ArchivePullRequestIdentity } from '@open-mercato/cezar-contract';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { ArchiveOnMergeCoordinator } from './archive-on-merge.ts';

const dirs: string[] = [], stores: RunStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-archive-coordinator-')); dirs.push(root);
  const id = randomUUID(); const dataDir = join(root, '.ai/cezar');
  seedRuns(dataDir, [{ id, task: 'task', title: 'task', workflow: 'quick-task', status: 'review', steps: [], createdAt: '2026-01-01T00:00:00.000Z', archived: false, tokensUsed: 0, pullRequests: [{ number: 42, source: 'declared' }] }]);
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
  return { coordinator, store, id, lookup, withStore, disable: () => { enabled = false; } };
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
