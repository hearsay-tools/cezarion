import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord, RunStatus } from './store.ts';
import { isReclaimable, selectReclaimableWorktrees } from './retention.ts';

/**
 * The pure retention selector (#483). It only reads a handful of fields, so the
 * tests build minimal run records rather than driving the whole store.
 */
function run(partial: {
  id: string;
  status: RunStatus;
  worktreePath?: string | null;
  createdAt?: string;
  finishedAt?: string;
  worktreeReclaimedAt?: string;
  role?: 'worker' | 'invalid';
  destroying?: boolean;
}): RunRecord {
  // The selector reads only `role`, `parentRunId` and `destroy`, so a worker here is that much and
  // no more; the cast is the one loose field, and the record around it is typed.
  const delegation =
    partial.role === 'invalid'
      ? { role: 'invalid' as const }
      : partial.role === 'worker'
        ? {
            role: 'worker' as const,
            parentRunId: 'parent',
            permissions: [] as const,
            ...(partial.destroying
              ? {
                  destroy: {
                    requestedAt: '2026-07-01T00:00:00.000Z',
                    phase: 'requested' as const,
                    remaining: ['worktree'],
                  },
                }
              : {}),
          }
        : undefined;
  const worktreePath = partial.worktreePath === null ? undefined : partial.worktreePath ?? process.cwd();
  return makeRunRecord({
    id: partial.id,
    status: partial.status,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    ...(partial.finishedAt === undefined ? {} : { finishedAt: partial.finishedAt }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(partial.worktreeReclaimedAt === undefined ? {} : { worktreeReclaimedAt: partial.worktreeReclaimedAt }),
    ...(delegation === undefined ? {} : { delegation: delegation as unknown as RunRecord['delegation'] }),
  });
}

describe('selectReclaimableWorktrees (#483)', () => {
  it('keeps the newest N finished worktrees and reclaims the older ones', () => {
    const runs = [
      run({ id: 'a', status: RUN_STATUS.done, finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'b', status: RUN_STATUS.done, finishedAt: '2026-07-02T00:00:00Z' }),
      run({ id: 'c', status: RUN_STATUS.failed, finishedAt: '2026-07-03T00:00:00Z' }),
      run({ id: 'd', status: RUN_STATUS.cancelled, finishedAt: '2026-07-04T00:00:00Z' }),
    ];
    // keep the 2 newest (d, c) → reclaim the 2 oldest (b, a).
    expect(selectReclaimableWorktrees(runs, 2).sort()).toEqual(['a', 'b']);
  });

  it('orders by finishedAt, falling back to createdAt when finishedAt is absent', () => {
    const runs = [
      run({ id: 'old', status: RUN_STATUS.done, createdAt: '2026-06-01T00:00:00Z' }),
      run({ id: 'new', status: RUN_STATUS.done, finishedAt: '2026-07-09T00:00:00Z' }),
    ];
    expect(selectReclaimableWorktrees(runs, 1)).toEqual(['old']);
  });

  it('excludes review and live runs from the budget entirely', () => {
    const runs = [
      run({ id: 'review', status: RUN_STATUS.review, finishedAt: '2026-07-09T00:00:00Z' }),
      run({ id: 'running', status: RUN_STATUS.running }),
      run({ id: 'queued', status: RUN_STATUS.queued }),
      run({ id: 'waiting', status: RUN_STATUS.waiting }),
      run({ id: 'done1', status: RUN_STATUS.done, finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'done2', status: RUN_STATUS.done, finishedAt: '2026-07-02T00:00:00Z' }),
    ];
    // Only done1/done2 count; keep=1 reclaims the older finished one (done1).
    expect(selectReclaimableWorktrees(runs, 1)).toEqual(['done1']);
  });

  it('excludes runs with no worktree dir and already-reclaimed runs', () => {
    const runs = [
      run({ id: 'nodir', status: RUN_STATUS.done, worktreePath: null, finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'gone', status: RUN_STATUS.done, worktreeReclaimedAt: '2026-07-05T00:00:00Z', finishedAt: '2026-07-02T00:00:00Z' }),
      run({ id: 'live-dir', status: RUN_STATUS.done, finishedAt: '2026-07-03T00:00:00Z' }),
    ];
    // Only live-dir is reclaimable; keep=0 would disable, so use keep=... none over budget.
    expect(selectReclaimableWorktrees(runs, 5)).toEqual([]);
    // With keep below the single reclaimable count it still never selects the excluded ones.
    // (live-dir is the only candidate; keeping 0 finished means "unlimited", see next test.)
  });

  it('does not let a missing worktree directory occupy a keep slot (#571)', () => {
    const missingPath = join(process.cwd(), '.missing-retention-worktree-571');
    const stale = run({
      id: 'stale',
      status: RUN_STATUS.done,
      worktreePath: missingPath,
      finishedAt: '2026-07-02T00:00:00Z',
    });
    const live = run({
      id: 'live',
      status: RUN_STATUS.done,
      finishedAt: '2026-07-01T00:00:00Z',
    });

    expect(isReclaimable(stale)).toBe(false);
    expect(selectReclaimableWorktrees([stale, live], 1)).toEqual([]);
  });

  it('treats keep=0 as unlimited (never reclaims)', () => {
    const runs = [
      run({ id: 'a', status: RUN_STATUS.done, finishedAt: '2026-07-01T00:00:00Z' }),
      run({ id: 'b', status: RUN_STATUS.done, finishedAt: '2026-07-02T00:00:00Z' }),
    ];
    expect(selectReclaimableWorktrees(runs, 0)).toEqual([]);
  });

  it('reclaims nothing when the count is at or below the limit', () => {
    const runs = [run({ id: 'a', status: RUN_STATUS.done, finishedAt: '2026-07-01T00:00:00Z' })];
    expect(selectReclaimableWorktrees(runs, 10)).toEqual([]);
  });

  it('isReclaimable reflects the finished + has-dir + not-yet-reclaimed rule', () => {
    expect(isReclaimable(run({ id: 'x', status: RUN_STATUS.done }))).toBe(true);
    expect(isReclaimable(run({ id: 'x', status: RUN_STATUS.review }))).toBe(false);
    expect(isReclaimable(run({ id: 'x', status: RUN_STATUS.done, worktreePath: null }))).toBe(false);
    expect(isReclaimable(run({ id: 'x', status: RUN_STATUS.done, worktreeReclaimedAt: '2026-07-05T00:00:00Z' }))).toBe(false);
  });

  it('treats a finished worker with an existing dir as reclaimable (#575)', () => {
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.done, role: 'worker' }))).toBe(true);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.failed, role: 'worker' }))).toBe(true);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.cancelled, role: 'worker' }))).toBe(true);
  });

  it('keeps a finished worker while its parent is still live so collect can verify the workspace', () => {
    const parent = run({ id: 'parent', status: RUN_STATUS.waiting });
    const worker = run({
      id: 'w',
      status: RUN_STATUS.done,
      role: 'worker',
      finishedAt: '2026-07-01T00:00:00Z',
    });
    expect(isReclaimable(worker, (id) => [parent, worker].find((r) => r.id === id))).toBe(false);
    expect(selectReclaimableWorktrees([parent, worker], 1)).toEqual([]);
    const finishedParent = run({
      id: 'parent',
      status: RUN_STATUS.done,
      finishedAt: '2026-07-02T00:00:00Z',
    });
    expect(isReclaimable(worker, (id) => [finishedParent, worker].find((r) => r.id === id))).toBe(true);
    expect(selectReclaimableWorktrees([finishedParent, worker], 1)).toEqual(['w']);
  });

  it('leaves live, review, destroying, and invalid workers non-reclaimable (#575)', () => {
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.running, role: 'worker' }))).toBe(false);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.queued, role: 'worker' }))).toBe(false);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.waiting, role: 'worker' }))).toBe(false);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.review, role: 'worker' }))).toBe(false);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.done, role: 'worker', destroying: true }))).toBe(false);
    expect(isReclaimable(run({ id: 'w', status: RUN_STATUS.done, role: 'invalid' }))).toBe(false);
  });

  it('reclaims a finished-worker majority when over keep (#575)', () => {
    // Operator snapshot: 23 finished workers (June) + 7 finished parents (July), keep 8.
    const workers = Array.from({ length: 23 }, (_, i) =>
      run({
        id: `w${String(i).padStart(2, '0')}`,
        status: RUN_STATUS.done,
        role: 'worker',
        finishedAt: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    const parents = Array.from({ length: 7 }, (_, i) =>
      run({
        id: `p${i}`,
        status: RUN_STATUS.done,
        finishedAt: `2026-07-0${i + 1}T00:00:00Z`,
      }),
    );
    const reclaimed = selectReclaimableWorktrees([...workers, ...parents], 8);
    // 30 reclaimable; keep the 7 July parents + newest worker (w22). Reclaim the other 22 workers.
    expect(reclaimed).toHaveLength(22);
    expect(reclaimed.every((id) => id.startsWith('w'))).toBe(true);
    expect(reclaimed).not.toContain('w22');
    expect(parents.every((p) => !reclaimed.includes(p.id))).toBe(true);
  });
});
