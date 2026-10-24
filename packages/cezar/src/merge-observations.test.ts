import { beforeEach, expect, it } from 'vitest';
import { MergedPullRequestObservations, mergedPullRequestObservations } from './merge-observations.ts';

const identity = { owner: 'org', repo: 'repo', number: 42 };
const observation = { number: 42, url: 'https://github.com/org/repo/pull/42', state: 'MERGED', mergedAt: '2026-01-02T00:00:00Z' };
beforeEach(() => mergedPullRequestObservations.clear());

it('retains repo-qualified immutable facts across repeated observations', () => {
  const cache = new MergedPullRequestObservations();
  const fact = cache.observe(identity, observation);
  expect(fact).toEqual({ ...identity, mergedAt: observation.mergedAt });
  expect(Object.isFrozen(fact)).toBe(true);
  expect(cache.observe({ ...identity, owner: 'ORG' }, { ...observation, mergedAt: '2026-01-03T00:00:00Z' })).toBe(fact);
  expect(cache.get(identity)).toBe(fact);
  expect(cache.get({ ...identity, repo: 'other' })).toBeUndefined();
});

it.each([
  { url: 'https://github.com/foreign/repo/pull/42' },
  { url: 'https://github.com/org/foreign/pull/42' },
  { url: 'https://git.example/org/repo/pull/42' },
  { url: 'https://github.com/org/repo/pull/43' },
  { url: 'https://user@github.com/org/repo/pull/42' },
  { number: 43 }, { mergedAt: undefined }, { mergedAt: null },
  { mergedAt: 'yesterday' }, { mergedAt: '2026-02-30T00:00:00Z' },
  { mergedAt: '2999-01-01T00:00:00Z' }, { state: 'CLOSED' }, { state: 'OPEN' },
])('rejects unproven merge evidence %j', patch => {
  const cache = new MergedPullRequestObservations();
  expect(cache.observe(identity, { ...observation, ...patch })).toBeUndefined();
  expect(cache.get(identity)).toBeUndefined();
});

it('bounds retention and evicts the least recently used fact', () => {
  const cache = new MergedPullRequestObservations(2);
  for (const number of [1, 2]) cache.observe({ ...identity, number }, { ...observation, number, url: `https://github.com/org/repo/pull/${number}` });
  cache.get({ ...identity, number: 1 });
  cache.observe(identity, observation);
  expect(cache.get({ ...identity, number: 1 })).toBeDefined();
  expect(cache.get({ ...identity, number: 2 })).toBeUndefined();
  expect(cache.get(identity)).toBeDefined();
});
