import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
import { __clearRepoHandleCacheForTests, createGithubDriver, evictGithubProjectCaches } from './github.ts';
import { canonicalRepoRef, forgetRepoHandle, forgettingNameOnMiss, resolveRepoHandle } from './github-repo-handle.ts';

const root = '/renamed-repo';
let current = 'acme/squawk';
let calls: string[][];

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  __clearRepoHandleCacheForTests();
  evictGithubProjectCaches(root);
  current = 'acme/squawk';
  calls = [];
  execFileMock.mockReset().mockImplementation((_file, args: string[], _opts, reply) => {
    calls.push(args);
    // `gh repo view <origin>` follows a rename: origin still says acme/cezarion, GitHub answers the
    // new name. Unqualified, gh picks its default repository, here a fork's upstream.
    if (args[0] === 'repo') return reply(null, { stdout: `${args[2] === 'github.com/acme/cezarion' || args[2] === '--json' ? current : 'cli/cli'}\n`, stderr: '' });
    if (args[0] === 'pr') {
      return reply(null, { stdout: JSON.stringify({
        number: 42, title: 'Fix', url: 'https://github.com/acme/squawk/pull/42', state: 'OPEN', isDraft: false,
        headRefName: 'fix/x', baseRefName: 'main', headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [], mergedAt: null,
      }), stderr: '' });
    }
    const path = args[1] ?? '';
    if (path === 'repos/acme/squawk') return reply(null, { stdout: JSON.stringify({ allow_squash_merge: true }), stderr: '' });
    if (path.includes('/rules/branches/')) return reply(null, { stdout: '[[]]', stderr: '' });
    if (path.includes('/branches/')) return reply(null, { stdout: JSON.stringify({ protected: false }), stderr: '' });
    return reply(Object.assign(new Error(`unexpected gh ${args.join(' ')}`), { stderr: 'gh: Not Found (HTTP 404)' }), { stdout: '', stderr: '' });
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('canonicalRepoRef', () => {
  it('answers the name GitHub reports, the remote without one, and null without a remote', async () => {
    expect(await canonicalRepoRef(root, { owner: 'acme', repo: 'cezarion' })).toEqual({ owner: 'acme', repo: 'squawk' });
    expect(await canonicalRepoRef(root, null)).toBeNull();
    __clearRepoHandleCacheForTests();
    current = 'not a slug';
    expect(await canonicalRepoRef(root, { owner: 'acme', repo: 'cezarion' })).toEqual({ owner: 'acme', repo: 'cezarion' });
  });

  it('asks GitHub about the remote itself, not gh\'s default repository', async () => {
    expect(await canonicalRepoRef(root, { owner: 'acme', repo: 'cezarion' })).toEqual({ owner: 'acme', repo: 'squawk' });
    expect(calls).toEqual([['repo', 'view', 'github.com/acme/cezarion', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']]);
    expect(await canonicalRepoRef(root, { owner: 'acme', repo: 'other' })).toEqual({ owner: 'cli', repo: 'cli' });
  });

  it('keeps the remote name in dry-run mode without asking gh', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    expect(await canonicalRepoRef(root, { owner: 'acme', repo: 'cezarion' })).toEqual({ owner: 'acme', repo: 'cezarion' });
    expect(calls).toEqual([]);
  });

  it('asks GitHub again after the cached name is forgotten', async () => {
    current = 'acme/cezarion';
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'acme', name: 'cezarion' });
    current = 'acme/squawk';
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'acme', name: 'cezarion' });
    forgetRepoHandle(root);
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'acme', name: 'squawk' });
  });

  it('forgets both cached names after a read GitHub refuses by name, and only then', async () => {
    current = 'acme/cezarion';
    const remote = { owner: 'acme', repo: 'cezarion' };
    await resolveRepoHandle(root);
    await canonicalRepoRef(root, remote);
    current = 'acme/squawk';
    await expect(forgettingNameOnMiss(root, async () => { throw new Error('gh: socket hang up'); })).rejects.toThrow('socket hang up');
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'acme', name: 'cezarion' });
    const refused = Object.assign(new Error('Command failed: gh search issues'), { stderr: 'gh: Validation Failed (HTTP 422)' });
    await expect(forgettingNameOnMiss(root, async () => { throw refused; })).rejects.toBe(refused);
    expect(await resolveRepoHandle(root)).toEqual({ owner: 'acme', name: 'squawk' });
    expect(await canonicalRepoRef(root, remote)).toEqual({ owner: 'acme', repo: 'squawk' });
  });
});

describe('the GitHub driver of a renamed repository', () => {
  it('reads merge state under the canonical name while origin keeps the old one', async () => {
    const driver = createGithubDriver(root, { owner: 'acme', repo: 'cezarion' });
    expect(await driver.prMergeState!(42)).toMatchObject({ available: true, mergeState: { number: 42 } });
    expect(calls.some((args) => args[0] !== 'repo' && args.join(' ').includes('cezarion'))).toBe(false);
  });

  it('forgets a stale cached name when GitHub returns the pull request under another name', async () => {
    current = 'acme/cezarion';
    const driver = createGithubDriver(root, { owner: 'acme', repo: 'cezarion' });
    expect(await driver.prMergeState!(42)).toEqual({ available: false, reason: 'GitHub returned a different pull request.' });
    current = 'acme/squawk';
    expect(await driver.prMergeState!(42, { refresh: true })).toMatchObject({ available: true });
  });
});
