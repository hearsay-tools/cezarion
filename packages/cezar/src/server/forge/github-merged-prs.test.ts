import { expect, it, vi } from 'vitest';
import { fetchMergedPullRequests } from './github.ts';
const identity = { owner: 'o', repo: 'r', number: 42 };
const answer = (patch = {}) => JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', pr42: { number: 42, url: 'https://github.com/o/r/pull/42', state: 'MERGED', mergedAt: '2026-01-02T00:00:00Z', ...patch } } } });
it('checks identity, state and timestamp and deduplicates lookups', async () => {
  const run = vi.fn(async () => answer());
  expect(await fetchMergedPullRequests(run, [identity, identity])).toEqual([{ ...identity, mergedAt: '2026-01-02T00:00:00Z' }]);
  expect(run).toHaveBeenCalledTimes(1);
  for (const patch of [{ number: 43 }, { url: 'https://github.com/foreign/r/pull/42' }, { state: 'OPEN' }, { state: 'CLOSED' }, { mergedAt: null }, { mergedAt: 'yesterday' }]) {
    expect(await fetchMergedPullRequests(async () => answer(patch), [identity])).toEqual([]);
  }
});
it('never trusts partial GraphQL errors or repository redirects', async () => {
  const redirected = JSON.parse(answer()); redirected.data.repository.nameWithOwner = 'foreign/r';
  expect(await fetchMergedPullRequests(async () => JSON.stringify(redirected), [identity])).toEqual([]);
  const errored = JSON.parse(answer()); errored.errors = [{ message: 'unavailable' }];
  expect(await fetchMergedPullRequests(async () => JSON.stringify(errored), [identity])).toEqual([]);
});
