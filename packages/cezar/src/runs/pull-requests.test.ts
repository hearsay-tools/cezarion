import { describe, expect, it } from 'vitest';
import { runPullRequestSchema, type RunPullRequest } from '@open-mercato/cezar-contract';
import { mergePullRequests, ownPullRequestNumbers } from './pull-requests.ts';

const repo = 'https://github.com/o/r';
const local: RunPullRequest = { number: 812, source: 'declared' };
const created: RunPullRequest = { number: 812, source: 'created', url: `${repo}/pull/812` };

describe('complete PR collection', () => {
  it('merges replayed scoped identities without reordering', () => {
    const current = [local, { number: 813, source: 'declared' as const }];
    const incoming = [created, { ...created, url: 'http://GITHUB.COM/O/R/pull/812/?x=1#diff' }];
    expect(mergePullRequests(current, incoming, repo)).toEqual([created, current[1]]);
    expect(current).toEqual([local, { number: 813, source: 'declared' }]);
    expect(mergePullRequests([created], [local], repo)).toEqual([created]);
  });
  it('keeps foreign same-number and unknown-scope references separate', () => {
    const foreign: RunPullRequest = { number: 812, source: 'created', url: 'https://github.com/other/repo/pull/812' };
    expect(mergePullRequests([local], [foreign], repo)).toEqual([local, foreign]);
    expect(mergePullRequests([local], [created])).toEqual([local, created]);
    expect(mergePullRequests([created], [foreign], repo)).toEqual([created, foreign]);
  });
  it('retains more than eight authoritative identities', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ number: 812 + i, source: 'declared' as const }));
    expect(mergePullRequests(entries, entries, repo)).toEqual(entries);
  });
  it.each([
    { number: 0, source: 'declared' }, { number: 10_000_000, source: 'declared' },
    { number: 1.1, source: 'declared' }, { number: 812, source: 'candidate' },
    { number: 812, source: 'created', url: 'https://github.com/o/r/pull/813' },
    { number: 812, source: 'created', url: 'https://user:password@github.com/o/r/pull/812' },
    { number: 812, source: 'created', url: 'javascript:alert(812)' },
    { number: 812, source: 'created', url: 'https://github.com.evil/o/r/pull/812' },
    { number: 812, source: 'created', url: 'https://github.com/o/r/issues/812' },
  ])('rejects invalid authoritative evidence %j', (entry) => {
    expect(runPullRequestSchema.safeParse(entry).success).toBe(false);
  });
});

it('invalidates every own-repo PR while excluding foreign same-number references', () => {
  expect(ownPullRequestNumbers({ pullRequests: [
    { number: 812, source: 'created', url: 'https://github.com/o/r/pull/812' },
    { number: 813, source: 'declared' },
    { number: 999, source: 'created', url: 'https://github.com/foreign/repo/pull/999' },
  ] }, repo)).toEqual([812, 813]);
  expect(ownPullRequestNumbers({ prNumber: 999, pullRequestUrl: 'https://github.com/foreign/repo/pull/999' }, repo)).toEqual([]);
});
