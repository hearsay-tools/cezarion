import { describe, expect, it } from 'vitest';

import { branchFor } from '../git-worktree.ts';
import { encodeRunRow, isLiveRecord, isLiveStatus } from './run-row.ts';
import type { RunRecord } from './store.ts';

const ID = '0123abcd-0000-4000-8000-000000000000';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: ID, title: 't', workflow: 'quick-task', task: 'do it', status: 'done', createdAt: '2026-10-05T00:00:00.000Z',
    tokensUsed: 0, archived: false, steps: [], ...overrides,
  } as RunRecord;
}

const worker = (extra: Record<string, unknown> = {}) => ({
  role: 'worker', parentRunId: 'parent-1',
  workspace: { ownerRunId: ID, resourceId: 'r', kind: 'owned-isolated', path: `/repo/.ai/cezar/worktrees/${ID}`, branch: 'cez/0123abcd', baselineSha: 'a'.repeat(40) },
  ...extra,
}) as unknown as RunRecord['delegation'];

describe('isLiveStatus', () => {
  it('is true only for queued, running and waiting', () => {
    expect(isLiveStatus('queued')).toBe(true);
    expect(isLiveStatus('running')).toBe(true);
    expect(isLiveStatus('waiting')).toBe(true);
    expect(isLiveStatus('done')).toBe(false);
    expect(isLiveStatus('review')).toBe(false);
    expect(isLiveStatus('failed')).toBe(false);
    expect(isLiveStatus('cancelled')).toBe(false);
  });
});

describe('isLiveRecord', () => {
  it('is false for a finished run with nothing pending', () => {
    for (const status of ['review', 'done', 'failed', 'cancelled'] as const) expect(isLiveRecord(record({ status }))).toBe(false);
  });

  // One case per clause: drop any clause from the predicate and its case goes false.
  it.each([
    ['queued', { status: 'queued' }],
    ['running', { status: 'running' }],
    ['waiting', { status: 'waiting' }],
    // A wait counts until it is delivered or cancelled (unified waits: `lastWaits` holds those).
    ['an open wait', { waits: [{ id: 'w', phase: 'open' }] }],
    ['a resolved wait not yet delivered', { waits: [{ id: 'w', phase: 'resolved' }] }],
    ['a pending usage-limit resume', { status: 'failed', autoResumeAt: '2026-10-06T00:00:00.000Z' }],
    ['a worker whose destroy is still owed', { delegation: worker({ destroy: { phase: 'requested' } }) }],
    ['a root whose Finish has not settled', { status: 'cancelled', delegation: { role: 'root', finishRequestedAt: '2026-10-05T00:00:00.000Z' } }],
    ['an accepted Stop not yet settled', { stopping: { requestedAt: '2026-10-05T00:00:00.000Z' } }],
  ])('is true for %s', (_name, overrides) => {
    expect(isLiveRecord(record(overrides as Partial<RunRecord>))).toBe(true);
  });

  it('lets a run go once its waits are delivered or cancelled', () => {
    expect(isLiveRecord(record({ lastWaits: [{ id: 'w', phase: 'delivered' }, { id: 'x', phase: 'cancelled' }] } as unknown as Partial<RunRecord>))).toBe(false);
  });

  it('lets a worker go once its destroy completed', () => {
    expect(isLiveRecord(record({ delegation: worker({ destroy: { phase: 'complete' } }) }))).toBe(false);
  });

  // Every worker wait is a list entry, covered by the open-wait case above: store schema 7 reads the
  // old engine's `delegation.wait` into the list on open (hearsay-tools/cezarion#1301).
  it('does not read the old engine\'s delegation.wait', () => {
    expect(isLiveRecord(record({ delegation: { role: 'root', wait: { id: 'wait' } } } as unknown as Partial<RunRecord>))).toBe(false);
    expect(isLiveRecord(record({ delegation: worker({ wait: { id: 'wait' } }) }))).toBe(false);
  });

  it('does not read a wait off a quarantined delegation', () => {
    expect(isLiveRecord(record({ delegation: { role: 'invalid', wait: { id: 'x' } } as unknown as RunRecord['delegation'] }))).toBe(false);
  });
});

describe('encodeRunRow', () => {
  it('stores the live predicate as the live column', () => {
    expect(encodeRunRow(record()).live).toBe(false);
    expect(encodeRunRow(record({ status: 'running' })).live).toBe(true);
    expect(encodeRunRow(record({ waits: [{ id: 'w', phase: 'open' }] as unknown as RunRecord['waits'] })).live).toBe(true);
  });

  it('copies the query columns off the record', () => {
    const row = encodeRunRow(record({
      clientRequestId: 'req', groupId: 'g', worktreePath: '/w/t', branch: 'cez/t', baseBranch: 'main', finishedAt: '2026-10-05T01:00:00.000Z',
    }));
    expect(row).toMatchObject({
      clientRequestId: 'req', groupId: 'g', worktreePath: '/w/t', branch: 'cez/t', baseBranch: 'main',
      finishedAt: '2026-10-05T01:00:00.000Z', parentRunId: null,
    });
    expect(encodeRunRow(record())).toMatchObject({
      clientRequestId: null, groupId: null, worktreePath: null, branch: null, baseBranch: null, finishedAt: null,
    });
  });

  it('keeps a reclaimed worktree out of the worktree column', () => {
    expect(encodeRunRow(record({ worktreePath: '/w/t', worktreeReclaimedAt: '2026-10-05T00:00:00.000Z' })).worktreePath).toBeNull();
  });

  it("names the branch a run owns: its own, an owned worker's planned one, else its worktree's task branch", () => {
    expect(encodeRunRow(record({ branch: 'feature/x', worktreePath: '/w/t' })).branch).toBe('feature/x');
    expect(encodeRunRow(record({ worktreePath: '/w/t' })).branch).toBe('cez/0123abcd');
    expect(encodeRunRow(record({ delegation: worker() })).branch).toBe('cez/0123abcd');
    expect(encodeRunRow(record({ worktree: false })).branch).toBeNull();
  });

  it("spells a worktree's task branch exactly as branchFor does, which it cannot import", () => {
    for (const id of [ID, 'short', 'ffffffff-ffff-4fff-8fff-ffffffffffff']) {
      expect(encodeRunRow(record({ id, worktreePath: '/w/t' })).branch).toBe(branchFor(id));
    }
  });

  it("files a worker under its parent", () => {
    expect(encodeRunRow(record({ delegation: worker() })).parentRunId).toBe('parent-1');
    expect(encodeRunRow(record({ delegation: { role: 'root' } as unknown as RunRecord['delegation'] })).parentRunId).toBeNull();
  });
});
