import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
import { __clearRepoHandleCacheForTests, createGithubDriver, evictGithubProjectCaches, fetchMergedPullRequests, fetchRefStatuses, lookupMergedPullRequests, viewGithubItem } from './github.ts';
import { mergedPullRequestObservations } from '../../merge-observations.ts';

const identity = { owner: 'org', repo: 'repo', number: 42 };
const other = { ...identity, repo: 'other' };
const mergedAt = '2026-01-02T00:00:00Z';
const node = { number: 42, url: 'https://github.com/org/repo/pull/42', state: 'MERGED', mergedAt };
const signal = () => new AbortController().signal;
const batch = (patch = {}, repository = 'org/repo', errors?: unknown[]) => JSON.stringify({
  data: { repository: { nameWithOwner: repository, r0: { __typename: 'PullRequest', ...node, ...patch } } },
  ...(errors ? { errors } : {}),
});

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  mergedPullRequestObservations.clear();
  __clearRepoHandleCacheForTests();
  evictGithubProjectCaches('/merge-observations');
  execFileMock.mockReset().mockImplementation((_file, _args, _opts, reply) => reply(null, {
    stdout: JSON.stringify({ data: { repository: { nameWithOwner: 'org/repo', pr42: node } } }), stderr: '',
  }));
});
afterEach(() => vi.unstubAllEnvs());

it('reuses a sidebar merged observation without another archive query', async () => {
  let query = '';
  expect(await fetchRefStatuses(async text => { query = text; return batch(); }, 'org', 'repo', [42])).toMatchObject({ resolved: { 42: { status: 'merged' } } });
  expect(await lookupMergedPullRequests('/merge-observations', [identity, identity], signal())).toEqual([{ ...identity, mergedAt }]);
  expect(execFileMock.mock.calls.length).toBe(0);
  expect(query).toContain('url mergedAt');
  expect(query).toContain('nameWithOwner');
});

it.each([
  [{ mergedAt: undefined }], [{ mergedAt: null }], [{ mergedAt: 'yesterday' }], [{ mergedAt: '2999-01-01T00:00:00Z' }],
  [{ url: 'https://github.com/org/other/pull/42' }],
  [{}, 'foreign/repo'], [{}, 'org/repo', [{ type: 'FORBIDDEN' }]],
])('keeps sidebar glyphs separate from archive authority: %j', async (patch, repository?: string, errors?: unknown[]) => {
  expect(await fetchRefStatuses(async () => batch(patch, repository, errors), 'org', 'repo', [42])).toMatchObject({ resolved: { 42: { status: 'merged' } } });
  expect(mergedPullRequestObservations.get(identity)).toBeUndefined();
  await lookupMergedPullRequests('/merge-observations', [identity], signal());
  expect(execFileMock.mock.calls.length).toBe(1);
});

it('never reuses an own-repository observation for the same number in another repository', async () => {
  await fetchRefStatuses(async () => batch(), 'org', 'repo', [42]);
  expect(await lookupMergedPullRequests('/merge-observations', [other], signal())).toEqual([]);
  expect(execFileMock.mock.calls.length).toBe(1);
});

it('reuses archive query observations and queries only still unknown identities', async () => {
  await lookupMergedPullRequests('/merge-observations', [identity], signal());
  expect(await lookupMergedPullRequests('/merge-observations', [identity], signal())).toEqual([{ ...identity, mergedAt }]);
  expect(execFileMock.mock.calls.length).toBe(1);
  await lookupMergedPullRequests('/merge-observations', [identity, { ...identity, number: 43 }], signal());
  const args = execFileMock.mock.calls[1]![1] as string[];
  expect(args.join(' ')).toContain('pr43:');
  expect(args.join(' ')).not.toContain('pr42:');
});

it('rejects future timestamps from the archive lookup itself', async () => {
  expect(await fetchMergedPullRequests(async () => JSON.stringify({ data: { repository: { nameWithOwner: 'org/repo', pr42: { ...node, mergedAt: '2999-01-01T00:00:00Z' } } } }), [identity])).toEqual([]);
});

it('does not overwrite a merge time on repeated authoritative observations', async () => {
  await fetchRefStatuses(async () => batch(), 'org', 'repo', [42]);
  await fetchRefStatuses(async () => batch({ mergedAt: '2026-01-03T00:00:00Z' }), 'org', 'repo', [42]);
  expect(await lookupMergedPullRequests('/merge-observations', [identity], signal())).toEqual([{ ...identity, mergedAt }]);
  expect(execFileMock.mock.calls.length).toBe(0);
});

it.each(['detail', 'branch', 'merge-state'] as const)('publishes an authoritative %s observation', async source => {
  const pr = { ...node, title: 'Merged', author: { login: 'author' }, createdAt: '2025-01-01T00:00:00Z',
    labels: [], isDraft: false, headRefName: 'cez/task', baseRefName: 'main', headRefOid: 'a'.repeat(40) };
  execFileMock.mockImplementation((_file, args: string[], _opts, reply) => {
    const out = args[0] === 'pr' ? pr : args[0] === 'repo' ? { nameWithOwner: 'org/repo' }
      : args[1] === 'repos/org/repo' ? { allow_squash_merge: true }
      : args[1]?.includes('/rules/branches/') ? [[]]
      : args[1]?.includes('/branches/') ? { protected: false } : 0;
    // Repository discovery uses gh's jq projection (plain text).
    reply(null, { stdout: args[0] === 'repo' ? 'org/repo' : JSON.stringify(out), stderr: '' });
  });
  const driver = createGithubDriver('/merge-observations', { owner: 'org', repo: 'repo' });
  if (source === 'detail') expect(await viewGithubItem('/merge-observations', 'pr', 42)).toMatchObject({ number: 42 });
  if (source === 'branch') expect(await driver.prStatus('cez/task')).toMatchObject({ state: 'merged' });
  if (source === 'merge-state') expect(await driver.prMergeState!(42)).toMatchObject({ available: true, mergeState: { state: 'merged' } });
  execFileMock.mockClear();
  expect(await lookupMergedPullRequests('/merge-observations', [identity], signal())).toEqual([{ ...identity, mergedAt }]);
  expect(execFileMock.mock.calls.length).toBe(0);
});

it('honors cancellation even for a cache hit and does not use real facts in dry-run mode', async () => {
  mergedPullRequestObservations.observe(identity, node);
  const controller = new AbortController(); controller.abort();
  await expect(lookupMergedPullRequests('/merge-observations', [identity], controller.signal)).rejects.toBeDefined();
  vi.stubEnv('CEZ_DRY_RUN', '1');
  expect(await lookupMergedPullRequests('/merge-observations', [identity], signal())).toEqual([]);
  expect(execFileMock.mock.calls.length).toBe(0);
});
