import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { seedRuns, readPersistedRuns, blockRunWrites } from '../runs/run-store.testkit.ts';
import type { ForgeDriver, ForgeMergeInput, ForgePrMergeState, ForgePrMergeStateResult } from './forge/types.ts';
import { type CompletionActionDeps, CompletionActionCoordinator } from './completion-actions.ts';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture(patch: Partial<RunRecord> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cez-complete-actions-')), dir = join(root, '.ai/cezar');
  const id = randomUUID(), token = randomUUID(), sha = 'a'.repeat(40), branch = 'cez/task';
  const record = { id, title: 'task', task: 'task', workflow: 'quick-task', steps: [], status: 'done', tokensUsed: 0,
    createdAt: '2026-01-01T00:00:00.000Z', archived: false, archiveWhenDone: true, autoMergePr: true,
    completionAction: { id: token, phase: 'pending' }, branch, worktreePath: join(root, 'worktree'),
    pullRequests: [{ number: 12, url: 'https://github.com/o/r/pull/12', source: 'created' }], ...patch };
  seedRuns(dir, [record]);
  let store = RunStore.open(dir, { keepLive: true, maintenance: true });
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let state: ForgePrMergeState = { number: 12, title: 'task', url: 'https://github.com/o/r/pull/12', state: 'open', isDraft: false,
    headRef: branch, baseRef: 'main', headSha: sha, mergeable: 'mergeable', reviewDecision: 'approved',
    checks: [{ name: 'test', state: 'passing', required: true }], methods: ['squash'], defaultMethod: 'squash',
    eligibility: 'ready', blockers: [], canMerge: true, canOverride: false };
  const read = vi.fn(async (): Promise<ForgePrMergeStateResult> => ({ available: true, mergeState: state }));
  const merge = vi.fn(async (_number: number, _input: ForgeMergeInput) => ({ merged: true as const, number: 12, url: state.url, method: 'squash' as const }));
  const ready = vi.fn(async (): Promise<ForgePrMergeStateResult> => { state = { ...state, isDraft: false }; return { available: true, mergeState: state }; });
  const driver = { prMergeState: read, mergePR: merge, readyPR: ready } as unknown as ForgeDriver;
  const forge = vi.fn(async () => ({ driver, repository: 'https://github.com/o/r' }));
  const head = vi.fn(async () => sha as string | undefined);
  const deps: CompletionActionDeps = { projects: async () => [{ id: 'p', root }], forge, head,
    withStore: async (_project, work) => work(store, () => true) };
  const coordinator = () => new CompletionActionCoordinator(deps, 0);
  return { id, token, dir, read, merge, ready, forge, head, coordinator, store: () => store,
    state: (patch: Partial<ForgePrMergeState>) => { state = { ...state, ...patch }; },
    restart: () => { store.close(); store = RunStore.open(dir, { keepLive: true, maintenance: true }); } };
}

it('merges a verified current head before committing the archive, without a live manager', async () => {
  const f = fixture();
  f.merge.mockImplementationOnce(async () => {
    expect(readPersistedRuns(f.dir)[0].archived).toBe(false);
    return { merged: true, number: 12, url: 'https://github.com/o/r/pull/12', method: 'squash' };
  });
  await f.coordinator().tick();
  expect(f.merge).toHaveBeenCalledWith(12, expect.objectContaining({ expectedHeadSha: 'a'.repeat(40), expectedHeadRef: 'cez/task', requirePassingChecks: true }));
  expect(f.merge.mock.calls[0]?.[1]).not.toHaveProperty('overrideRules');
  expect(readPersistedRuns(f.dir)[0]).toMatchObject({ archived: true, completionAction: { phase: 'complete' } });
});
it('marks its draft ready, then checks CI and merges', async () => {
  const f = fixture(); f.state({ isDraft: true });
  await f.coordinator().tick();
  expect(f.ready).toHaveBeenCalledOnce(); expect(f.merge).toHaveBeenCalledOnce();
});
it.each(['pending', 'failing', 'unknown', 'absent'] as const)('keeps %s CI visible and retries after restart', async status => {
  const f = fixture(); f.state({ checks: status === 'absent' ? [] : [{ name: 'test', state: status, required: false }] });
  await f.coordinator().tick();
  expect(f.merge).not.toHaveBeenCalled(); expect(f.store().getRun(f.id)).toMatchObject({ archived: false, completionAction: { phase: 'blocked', message: expect.stringContaining('CI') } });
  f.restart(); f.state({ checks: [{ name: 'test', state: 'passing', required: false }] });
  await f.coordinator().tick(); expect(f.store().getRun(f.id)?.archived).toBe(true);
});
it('requires GitHub reviews and branch rules even when CI passes', async () => {
  const f = fixture(); f.state({ canMerge: false, canOverride: true, blockers: [{ code: 'review', message: 'Review required' }] });
  await f.coordinator().tick(); expect(f.merge).not.toHaveBeenCalled();
  expect(f.store().getRun(f.id)?.completionAction?.message).toBe('Review required');
});
it.each(['head', 'branch', 'repository', 'closed'] as const)('refuses changed %s identity', async change => {
  const f = fixture();
  f.state(change === 'head' ? { headSha: 'b'.repeat(40) } : change === 'branch' ? { headRef: 'other' } : change === 'repository' ? { url: 'https://github.com/foreign/r/pull/12' } : { state: 'closed' });
  await f.coordinator().tick(); expect(f.merge).not.toHaveBeenCalled(); expect(f.store().getRun(f.id)?.archived).toBe(false);
});
it.each(['disable', 'continue', 'restore', 'stop', 'branch'] as const)('invalidates intent during an await after %s', async change => {
  const f = fixture(), c = f.coordinator();
  f.read.mockImplementationOnce(async () => {
    if (change === 'disable') f.store().updateRun(f.id, { autoMergePr: false });
    if (change === 'continue') f.store().updateRun(f.id, { status: 'running' });
    if (change === 'restore') { f.store().setArchived(f.id, true); f.store().setArchived(f.id, false); }
    if (change === 'stop') c.stop();
    if (change === 'branch') f.store().updateRun(f.id, { branch: 'changed' });
    return { available: true, mergeState: {} as ForgePrMergeState };
  });
  await c.tick(); expect(f.merge).not.toHaveBeenCalled();
  if (change !== 'disable') expect(f.store().getRun(f.id)?.archived).toBe(false);
});
it('does not archive when settings change while a GitHub merge is in flight', async () => {
  const f = fixture();
  f.merge.mockImplementationOnce(async () => {
    f.store().updateRun(f.id, { archiveWhenDone: false });
    return { merged: true, number: 12, url: 'https://github.com/o/r/pull/12', method: 'squash' };
  });
  await f.coordinator().tick(); expect(f.store().getRun(f.id)?.archived).toBe(false);
});
it('reconciles an already merged PR after response loss and restart without repeating a mutation', async () => {
  const f = fixture(); f.state({ state: 'merged' }); f.restart();
  await f.coordinator().tick(); expect(f.merge).not.toHaveBeenCalled(); expect(f.store().getRun(f.id)?.archived).toBe(true);
});
it('archives no-PR completion without making a forge request', async () => {
  const f = fixture({ pullRequests: [] }); await f.coordinator().tick();
  expect(f.forge).not.toHaveBeenCalled(); expect(f.store().getRun(f.id)?.archived).toBe(true);
});
it.each([
  { number: 12, source: 'declared' as const },
  { number: 12, url: 'https://github.com/foreign/r/pull/12', source: 'created' as const },
  { number: 12, source: 'created' as const },
])('does not merge an unverified PR %j', async pr => {
  const f = fixture({ pullRequests: [pr] }); await f.coordinator().tick();
  expect(f.merge).not.toHaveBeenCalled(); expect(f.store().getRun(f.id)?.archived).toBe(false);
});
it.each(['review', 'failed', 'cancelled', 'waiting'] as const)('does no automatic work in %s', async status => {
  const f = fixture({ status }); await f.coordinator().tick(); expect(f.forge).not.toHaveBeenCalled();
});
it('does not rearm a manually restored completion on restart', async () => {
  const f = fixture(); await f.coordinator().tick(); f.store().setArchived(f.id, false); f.restart();
  await f.coordinator().tick(); expect(f.merge).toHaveBeenCalledOnce(); expect(f.store().getRun(f.id)?.archived).toBe(false);
});
it('leaves failed GitHub mutations visible with an actionable blocker', async () => {
  const f = fixture(); f.read.mockResolvedValueOnce({ available: false, reason: 'GitHub unavailable. Retry later.' });
  await f.coordinator().tick(); expect(f.store().getRun(f.id)?.completionAction).toMatchObject({ phase: 'blocked', message: 'GitHub unavailable. Retry later.' });
  expect(f.store().getRun(f.id)?.archived).toBe(false);
});

it('holds a committed family claim through remote reads and mutations', async () => {
  const f = fixture(), other = RunStore.open(f.dir, { keepLive: true, maintenance: true });
  try {
    f.read.mockImplementationOnce(async () => {
      f.store().flush(); // A store sweep must retain the in-flight family claim.
      expect(other.runOwnership(f.id)).toBe('foreign');
      expect(other.updateRun(f.id, { autoMergePr: false })).toBeUndefined();
      return { available: true, mergeState: { number: 12, url: 'https://github.com/o/r/pull/12',
        headRef: 'cez/task', headSha: 'a'.repeat(40), state: 'merged' } as ForgePrMergeState };
    });
    await f.coordinator().tick();
    expect(f.read).toHaveBeenCalledOnce();
    expect(readPersistedRuns(f.dir)[0]).toMatchObject({ archived: true, autoMergePr: true });
  } finally { other.close(); }
});

it('does not contact GitHub while its family claim cannot commit', async () => {
  const f = fixture(), release = blockRunWrites(f.dir);
  try { await f.coordinator().tick(); } finally { release(); }
  expect(f.forge).not.toHaveBeenCalled();
  expect(f.merge).not.toHaveBeenCalled();
  expect(readPersistedRuns(f.dir)[0]).toMatchObject({ archived: false, completionAction: { phase: 'pending' } });
});
