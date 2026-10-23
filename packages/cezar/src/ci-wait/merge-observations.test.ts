import { beforeEach, expect, it } from 'vitest';
import { GithubCiClient } from './github.ts';
import { mergedPullRequestObservations } from '../merge-observations.ts';

const identity = { owner: 'org', repo: 'repo', number: 42 };
const pr = { prUrl: 'https://github.com/org/repo/pull/42', repository: 'org/repo', prNumber: 42, headSha: 'a'.repeat(40) };
const body = { number: 42, url: pr.prUrl, state: 'MERGED', mergedAt: '2026-01-02T00:00:00Z', headRefOid: pr.headSha };
function client(patch = {}) {
  return new GithubCiClient({ command: { file: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ ...body, ...patch }))})`] } });
}
beforeEach(() => mergedPullRequestObservations.clear());

it('publishes the verified merge observation while retaining fresh head metadata', async () => {
  expect(await client().mergeState(pr, new AbortController().signal)).toMatchObject({ state: 'MERGED', headSha: pr.headSha });
  expect(mergedPullRequestObservations.get(identity)).toEqual({ ...identity, mergedAt: body.mergedAt });
});

it.each([
  { url: 'https://github.com/foreign/repo/pull/42' },
  { url: 'https://github.com/org/foreign/pull/42' },
  { url: 'https://github.com/org/repo/pull/43' },
])('rejects a same-number response from a different repository: %j', async patch => {
  await expect(client(patch).mergeState(pr, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_data' });
  expect(mergedPullRequestObservations.get(identity)).toBeUndefined();
});

it.each([{ mergedAt: null }, { mergedAt: '2999-01-01T00:00:00Z' }, { state: 'CLOSED' }])('does not share incomplete or invalid archive evidence: %j', async patch => {
  await client(patch).mergeState(pr, new AbortController().signal);
  expect(mergedPullRequestObservations.get(identity)).toBeUndefined();
});

it('rejects malformed merge timestamps without publishing them', async () => {
  await expect(client({ mergedAt: 'yesterday' }).mergeState(pr, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_data' });
  expect(mergedPullRequestObservations.get(identity)).toBeUndefined();
});

it('does not publish the synthetic merge time from a dry-run client', async () => {
  const dry = new GithubCiClient({ env: { ...process.env, CEZ_DRY_RUN: '1' } });
  expect(await dry.mergeState(pr, new AbortController().signal)).toMatchObject({ state: 'MERGED' });
  expect(mergedPullRequestObservations.get(identity)).toBeUndefined();
});
