import { afterEach, expect, it, vi } from 'vitest';
import { ReportsWatch, reportMetadataKey } from './reports-watch.ts';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
afterEach(() => vi.useRealTimers());
it('retains finite demand for fifteen seconds from the latest read', async () => {
  vi.useFakeTimers();
  const reconcile = vi.fn(async () => {}), watch = new ReportsWatch(async () => {}, reconcile);
  watch.markRead();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  watch.markRead();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reconcile).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(10_000);
  const count = reconcile.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reconcile).toHaveBeenCalledTimes(count);
  expect(watch.watching()).toBe(false);
  watch.close();
});
it.each([
  { title: 'Other' }, { status: RUN_STATUS.done }, { titleSummary: 'Summary' }, { branch: 'branch' },
  { workflow: 'workflow' }, { workflowLabel: 'Workflow label' },
  { pullRequestUrl: 'https://github.com/owner/repo/pull/1' },
  { referencedPullRequestUrl: 'https://github.com/owner/repo/pull/2' },
  { referencedIssueUrl: 'https://github.com/owner/repo/issues/3' },
  { prNumber: 4 }, { issueNumber: 5 }, { markerRefs: { pr: 6, issue: 7 } },
  { pullRequests: [{ url: 'https://github.com/owner/repo/pull/8', number: 8, source: 'created' as const }] },
])('tracks a stored-search or displayed field: %j', change => {
  const summary = toRunSummary(makeRunRecord({ status: RUN_STATUS.running }));
  expect(reportMetadataKey({ ...summary, ...change })).not.toBe(reportMetadataKey(summary));
});
it('does not count usage, pin or archive changes as report metadata', () => {
  const run = makeRunRecord();
  expect(reportMetadataKey(toRunSummary({ ...run, pinned: true, archived: true }))).toBe(reportMetadataKey(toRunSummary(run)));
});
