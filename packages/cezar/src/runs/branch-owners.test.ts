import { describe, expect, it } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { BranchOwnerRow } from './run-database.ts';
import { listBranchOwners } from './branch-owners.ts';
import type { RunRecord } from './store.ts';

/** hearsay-tools/squawk#911: a worker's branch is released only once its whole family has ended. */
describe('branch owners of an ended worker family', () => {
  const worker = (id: string, live: boolean): BranchOwnerRow => ({
    id, createdAt: '2026-11-01T00:00:00.000Z', status: live ? RUN_STATUS.running : RUN_STATUS.done, archived: true, live,
    branch: `cez/${id}`, baseBranch: null,
    summary: JSON.stringify({ id, title: id, status: live ? RUN_STATUS.running : RUN_STATUS.done, createdAt: '2026-11-01T00:00:00.000Z', archived: true,
      delegation: { role: 'worker', parentRunId: 'root' } }),
  });
  const root: RunRecord = makeRunRecord({ id: 'root', status: RUN_STATUS.done, archived: true });
  const ended = (rows: BranchOwnerRow[]) =>
    listBranchOwners(rows, [], (id) => (id === 'root' ? root : undefined)).find((owner) => owner.id === 'settled')?.endedWorker;

  it('marks a settled worker of an archived settled root', () => {
    expect(ended([worker('settled', false)])).toBe(true);
  });

  it('keeps the mark off while a sibling row another process keeps live exists', () => {
    expect(ended([worker('settled', false), worker('sibling', true)])).toBeUndefined();
  });
});
