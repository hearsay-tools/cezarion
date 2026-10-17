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

it.each(['response', 'gh-exit'] as const)('rechecks valid siblings after alias-scoped NOT_FOUND (%s)', async transport => {
  const partial = JSON.parse(answer({ mergedAt: '2026-01-01T00:00:00Z' }));
  partial.data.repository.pr43 = null;
  partial.errors = [{ type: 'NOT_FOUND', path: ['repository', 'pr43'], message: 'Could not resolve to a PullRequest with the number of 43.' }];
  const queries: string[] = [];
  const run = async (query: string) => {
    queries.push(query);
    if (queries.length === 1) {
      if (transport === 'gh-exit') throw Object.assign(new Error('gh: Could not resolve'), { code: 1, stdout: JSON.stringify(partial) });
      return JSON.stringify(partial);
    }
    return answer();
  };
  expect(await fetchMergedPullRequests(run, [identity, { ...identity, number: 43 }])).toEqual([
    { ...identity, mergedAt: '2026-01-02T00:00:00Z' },
  ]);
  expect(queries).toHaveLength(2);
  expect(queries[1]).not.toContain('pr43:');
});

it.each([
  [{ type: 'NOT_FOUND', path: ['repository'] }],
  [{ type: 'FORBIDDEN', path: ['repository', 'pr43'] }],
  [{ type: 'NOT_FOUND', path: ['repository', 'pr999'] }],
  [{ type: 'NOT_FOUND', path: ['repository', 'pr43', 'mergedAt'] }],
  [{ type: 'NOT_FOUND', path: ['repository', 'pr43'] }, { type: 'RATE_LIMITED' }],
].map(errors => ({ errors })))('does not salvage unscoped or mixed errors: $errors', async ({ errors }) => {
  const partial = JSON.parse(answer()); partial.errors = errors;
  const run = vi.fn(async () => JSON.stringify(partial));
  expect(await fetchMergedPullRequests(run, [identity, { ...identity, number: 43 }])).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});

it('does not trust a second partial response or retry it again', async () => {
  const partial = JSON.parse(answer());
  partial.errors = [{ type: 'NOT_FOUND', path: ['repository', 'pr43'] }];
  const run = vi.fn(async () => JSON.stringify(partial));
  expect(await fetchMergedPullRequests(run, [identity, { ...identity, number: 43 }])).toEqual([]);
  expect(run).toHaveBeenCalledTimes(2);
});

it('propagates transport failures even when stdout contains merged data', async () => {
  const error = Object.assign(new Error('connection lost'), { code: 1, stdout: answer() });
  await expect(fetchMergedPullRequests(async () => { throw error; }, [identity])).rejects.toBe(error);
});

it('leaves a completely missing set unresolved without an empty retry', async () => {
  const run = vi.fn(async () => JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', pr42: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pr42'] }] }));
  expect(await fetchMergedPullRequests(run, [identity])).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});
