import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
import { __clearRepoHandleCacheForTests, __clearRefStatusCacheForTests, discoverRepoHandle,
  resolveRepoHandle, fetchGithub, fetchGithubRefStatus, forgetRefStatus } from './github.ts';

type Call = { args: string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; reply: (error: Error | null, result: { stdout: string; stderr: string }) => void };
let calls: Call[];
const answer = (call: Call, stdout = 'owner/repo', error: Error | null = null) => call.reply(error, { stdout, stderr: '' });
const discoveries = () => calls.filter(c => c.args[0] === 'repo');
const queries = () => calls.filter(c => c.args.some(a => a.includes('issueOrPullRequest')));
function statuses(call: Call) {
  const query = call.args.find(a => a.startsWith('query='))!;
  const repository = Object.fromEntries([...query.matchAll(/(r\d+): issueOrPullRequest\(number: (\d+)\)/g)].map(m => [m[1], { __typename: 'Issue', state: 'OPEN' }]));
  answer(call, JSON.stringify({ data: { repository } }));
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '');
  __clearRepoHandleCacheForTests(); __clearRefStatusCacheForTests();
  calls = [];
  execFileMock.mockReset().mockImplementation((_file, args, opts, reply) => calls.push({ args, ...opts, reply }));
});
afterEach(() => vi.unstubAllEnvs());

describe('shared GitHub discovery and status misses', () => {
  it('shares list discovery with status and skips discovery on a fresh list refresh', async () => {
    const list = fetchGithub('/shared', true);
    const status = fetchGithubRefStatus('/shared', { issues: [1] });
    expect(discoveries()).toHaveLength(1);
    answer(discoveries()[0]!); await tick();
    for (const c of calls.filter(c => c.args[0] !== 'repo')) {
      if (queries().includes(c)) statuses(c);
      else answer(c, c.args[1] === 'list' ? '[]' : '{"data":{}}');
    }
    expect((await list).available).toBe(true);
    expect(await status).toMatchObject({ available: true, issues: { 1: 'open' } });
    const count = calls.length;
    const refresh = fetchGithub('/shared', true); await tick();
    for (const c of calls.slice(count)) answer(c, c.args[1] === 'list' ? '[]' : '{"data":{}}');
    expect((await refresh).available).toBe(true);
    expect(discoveries()).toHaveLength(1);
    expect(calls.filter(c => c.args[0] === 'issue')).toHaveLength(2);
  });

  it('coalesces identical and overlapping references while returning only requested numbers', async () => {
    const a = fetchGithubRefStatus('/overlap', { issues: [1, 2] });
    const b = fetchGithubRefStatus('/overlap', { prs: [2], issues: [3] });
    const c = fetchGithubRefStatus('/overlap', { issues: [1, 2] });
    expect(discoveries()).toHaveLength(1);
    answer(discoveries()[0]!); await tick();
    expect(queries()).toHaveLength(2);
    expect(queries().flatMap(c => [...c.args.join(' ').matchAll(/issueOrPullRequest\(number: (\d+)\)/g)].map(m => Number(m[1]))).sort()).toEqual([1, 2, 3]);
    queries().forEach(statuses);
    expect(await a).toMatchObject({ available: true, issues: { 1: 'open', 2: 'open' } });
    expect(await b).toMatchObject({ available: true, prs: {}, issues: { 2: 'open', 3: 'open' } });
    expect(await c).toEqual(await a);
  });

  it.each(['discovery', 'query'])('preserves concurrent %s failures and allows retry', async (stage) => {
    const a = fetchGithubRefStatus('/failure', { issues: [1] });
    const b = fetchGithubRefStatus('/failure', { issues: [1] });
    expect(discoveries()).toHaveLength(1);
    answer(discoveries()[0]!, 'owner/repo', stage === 'discovery' ? new Error('HTTP 401: Bad credentials') : null);
    await tick();
    if (stage === 'query') { expect(queries()).toHaveLength(1); answer(queries()[0]!, '', new Error('HTTP 401: Bad credentials')); }
    expect(await a).toMatchObject({ available: false, reason: 'HTTP 401: Bad credentials' });
    expect(await b).toEqual(await a);
    const retry = fetchGithubRefStatus('/failure', { issues: [1] }); await tick();
    if (stage === 'discovery') { answer(discoveries()[1]!); await tick(); }
    statuses(queries().at(-1)!);
    expect(await retry).toMatchObject({ available: true, issues: { 1: 'open' } });
  });

  it('cancels one discovery subscriber without cancelling another owner', async () => {
    const controller = new AbortController();
    const a = discoverRepoHandle('/cancel', controller.signal);
    const b = resolveRepoHandle('/cancel');
    expect(discoveries()).toHaveLength(1);
    controller.abort();
    expect(await a).toEqual({ status: 'cancelled' });
    expect(discoveries()[0]!.signal?.aborted).toBe(false);
    answer(discoveries()[0]!);
    expect(await b).toEqual({ owner: 'owner', name: 'repo' });
  });

  it('aborts an unowned discovery and prevents late publication over a replacement', async () => {
    const controller = new AbortController();
    const a = discoverRepoHandle('/abandon', controller.signal);
    controller.abort();
    expect(await a).toEqual({ status: 'cancelled' });
    expect(discoveries()[0]!.signal?.aborted).toBe(true);
    const b = resolveRepoHandle('/abandon');
    answer(discoveries()[1]!, 'new/repo');
    expect(await b).toEqual({ owner: 'new', name: 'repo' });
    answer(discoveries()[0]!, 'old/repo'); await tick();
    expect(await resolveRepoHandle('/abandon')).toEqual({ owner: 'new', name: 'repo' });
  });

  it('keeps repository roots isolated even when their handles match', async () => {
    const a = fetchGithubRefStatus('/a', { issues: [1] });
    const b = fetchGithubRefStatus('/b', { issues: [1] });
    expect(discoveries()).toHaveLength(2);
    discoveries().forEach(c => answer(c)); await tick();
    expect(queries()).toHaveLength(2);
    queries().forEach(statuses);
    expect((await a).available).toBe(true); expect((await b).available).toBe(true);
  });
  it('keeps successful overlapping references when another batch fails', async () => {
    const a = fetchGithubRefStatus('/partial', { issues: [1] });
    const b = fetchGithubRefStatus('/partial', { issues: [1, 2] });
    answer(discoveries()[0]!); await tick();
    statuses(queries()[0]!); answer(queries()[1]!, '', new Error('HTTP 503'));
    expect(await a).toMatchObject({ available: true, issues: { 1: 'open' } });
    expect(await b).toMatchObject({ available: false, reason: 'HTTP 503' });
    const retry = fetchGithubRefStatus('/partial', { issues: [1, 2] }); await tick();
    expect(queries().at(-1)!.args.join(' ')).not.toContain('number: 1)');
    statuses(queries().at(-1)!);
    expect(await retry).toMatchObject({ available: true, issues: { 1: 'open', 2: 'open' } });
  });

  it('keeps strict diagnostics when discovery is also owned by a fail-open caller', async () => {
    const a = discoverRepoHandle('/missing');
    const b = fetchGithubRefStatus('/missing', { issues: [1] });
    expect(discoveries()).toHaveLength(1);
    answer(discoveries()[0]!, '', Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(await a).toEqual({ status: 'unknown' });
    expect(await b).toMatchObject({ available: false, reason: 'gh CLI not found — install it and run `gh auth login`' });
    const retry = resolveRepoHandle('/missing');
    answer(discoveries()[1]!);
    expect(await retry).toEqual({ owner: 'owner', name: 'repo' });
  });

  it('detaches invalidated reference ownership so an old query cannot warm the cache', async () => {
    const old = fetchGithubRefStatus('/invalidate', { issues: [1] });
    answer(discoveries()[0]!); await tick();
    forgetRefStatus('/invalidate', 1);
    const fresh = fetchGithubRefStatus('/invalidate', { issues: [1] }); await tick();
    expect(queries()).toHaveLength(2);
    answer(queries()[1]!, '{"data":{"repository":{"r0":{"__typename":"Issue","state":"CLOSED","stateReason":"COMPLETED"}}}}');
    expect(await fresh).toMatchObject({ available: true, issues: { 1: 'completed' } });
    statuses(queries()[0]!); await old;
    expect(await fetchGithubRefStatus('/invalidate', { issues: [1] })).toMatchObject({ available: true, issues: { 1: 'completed' } });
  });

  it('bounds retained reference ownership and completes overflow without evicting live owners', async () => {
    const requests = Array.from({ length: 6 }, (_, batch) => fetchGithubRefStatus('/bounded', {
      issues: Array.from({ length: 100 }, (_, n) => batch * 100 + n + 1),
    }));
    answer(discoveries()[0]!); await tick();
    expect(queries()).toHaveLength(6);
    const first = fetchGithubRefStatus('/bounded', { issues: [1] });
    const overflow = fetchGithubRefStatus('/bounded', { issues: [600] }); await tick();
    expect(queries()).toHaveLength(7); // #1 still joins; #600 exceeds the ownership bound
    queries().forEach(statuses);
    expect((await Promise.all([...requests, first, overflow])).every(r => r.available)).toBe(true);
  });

  it.each(['GH_CONFIG_DIR', 'GH_HOST'])('isolates discovery and status ownership across %s contexts', async (setting) => {
    vi.stubEnv(setting, 'first');
    const a = fetchGithubRefStatus('/account', { issues: [1] });
    vi.stubEnv(setting, 'second');
    const b = fetchGithubRefStatus('/account', { issues: [1] });
    expect(discoveries()).toHaveLength(2);
    discoveries().forEach(c => answer(c)); await tick();
    expect(queries()).toHaveLength(2);
    expect(queries().map(c => c.env?.[setting])).toEqual(['first', 'second']);
    queries().forEach(statuses);
    expect((await a).available).toBe(true); expect((await b).available).toBe(true);
    vi.stubEnv(setting, 'third');
    const c = fetchGithubRefStatus('/account', { issues: [1] });
    expect(discoveries()).toHaveLength(3);
    answer(discoveries()[2]!); await tick(); statuses(queries()[2]!);
    expect((await c).available).toBe(true);
  });

  it('does not publish a late overflow result over a newer cached reference', async () => {
    const holders = Array.from({ length: 5 }, (_, batch) => fetchGithubRefStatus('/overflow', {
      issues: Array.from({ length: 100 }, (_, n) => batch * 100 + n + 1),
    }));
    answer(discoveries()[0]!); await tick();
    const old = fetchGithubRefStatus('/overflow', { issues: [600] }); await tick();
    const oldQuery = queries()[5]!;
    queries().slice(0, 5).forEach(statuses);
    await Promise.all(holders);
    forgetRefStatus('/overflow', 600);
    const fresh = fetchGithubRefStatus('/overflow', { issues: [600] }); await tick();
    answer(queries()[6]!, '{"data":{"repository":{"r0":{"__typename":"Issue","state":"CLOSED","stateReason":"COMPLETED"}}}}');
    expect(await fresh).toMatchObject({ available: true, issues: { 600: 'completed' } });
    statuses(oldQuery);
    expect(await old).toMatchObject({ available: true, issues: { 600: 'open' } });
    expect(await fetchGithubRefStatus('/overflow', { issues: [600] })).toMatchObject({ available: true, issues: { 600: 'completed' } });
  });

});
