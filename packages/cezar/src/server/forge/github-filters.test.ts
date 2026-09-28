import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => run(...args),
}));
import { fetchGithub, fetchGithubProjects } from './github.ts';
import { githubDataSchema } from '@open-mercato/cezar-contract';
const pageInfo = { hasNextPage: false, endCursor: null };
const board = { id: 'P1', title: 'Delivery', url: 'https://github.com/users/o/projects/1' };
function mockGh(projectsFail = false, viewerFail = false) {
  run.mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const cb = args.at(-1) as (err: unknown, result: unknown) => void;
    const ok = (v: unknown) => cb(null, { stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    if (argv[0] === 'repo') return ok('o/r');
    if (argv[0] === 'issue') return ok([{ number: 1, title: 'Task', author: { login: 'o' }, createdAt: '', labels: [], body: '', url: 'https://github.com/o/r/issues/1', assignees: [{ login: 'alice' }] }]);
    if (argv[0] === 'pr') return ok([]);
    const query = argv.find(a => a.startsWith('query=')) ?? '';
    if (query.includes('viewer')) return viewerFail ? cb(new Error('offline'), null) : ok({ data: { viewer: { login: 'alice' } } });
    if (query.includes('projectsV2')) return projectsFail ? cb(new Error('scope missing'), null) : ok({ data: { repository: { projectsV2: { nodes: [board], pageInfo } } } });
    if (query.includes('projectItems')) return ok({ data: { repository: { i1: { projectItems: { nodes: [{ project: { id: 'P1' } }], pageInfo } } } } });
    return cb(new Error('counts unavailable'), null);
  });
}
beforeEach(() => { vi.stubEnv('CEZ_DRY_RUN', ''); run.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it('delivers assignees, viewer and linked project membership through the list contract', async () => {
  mockGh();
  const first = await fetchGithub('/filters-test', true);
  await fetchGithubProjects('/filters-test', first.projectsGeneration!);
  const data = githubDataSchema.parse(await fetchGithub('/filters-test'));
  expect(data.available).toBe(true);
  expect(data.issues[0]).toMatchObject({ assignees: ['alice'], projectIds: ['P1'] });
  expect(data.viewerLogin).toBe('alice');
  expect(data.projects).toEqual([board]);
});
it('project access failure preserves the issue list, assignees and independent viewer', async () => {
  mockGh(true);
  const first = await fetchGithub('/filters-fail', true);
  await fetchGithubProjects('/filters-fail', first.projectsGeneration!);
  const data = await fetchGithub('/filters-fail');
  expect(data.available).toBe(true);
  expect(data.issues[0]?.assignees).toEqual(['alice']);
  expect(data.viewerLogin).toBe('alice');
  expect(data.projects).toBeUndefined();
  expect(data.projectsReason).toBeTruthy();
});
it('viewer failure leaves project filtering usable', async () => {
  mockGh(false, true);
  const first = await fetchGithub('/filters-viewer-fail', true);
  await fetchGithubProjects('/filters-viewer-fail', first.projectsGeneration!);
  const data = await fetchGithub('/filters-viewer-fail');
  expect(data.projects).toEqual([board]);
  expect(data.viewerLogin).toBeUndefined();
});
it('dry run includes usable assignment and board fixtures without a subprocess', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  const data = githubDataSchema.parse(await fetchGithub('/dry-filters'));
  expect(data.viewerLogin).toBeTruthy();
  expect(data.issues.some(i => i.assignees?.includes(data.viewerLogin!))).toBe(true);
  expect(data.projects?.length).toBeGreaterThan(0);
  expect(data.issues.some(i => i.projectIds?.includes(data.projects![0]!.id))).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

import { fetchIssueProjects } from './github-filters.ts';
it('discovers later pages and filters memberships by ID, not duplicate board titles', async () => {
  const graphql = vi.fn(async (query: string, variables: Record<string, string>) => {
    if (query.includes('projectsV2')) return JSON.stringify({ data: { repository: { projectsV2: {
      nodes: [variables.cursor ? { ...board, id: 'P2' } : board],
      pageInfo: variables.cursor ? pageInfo : { hasNextPage: true, endCursor: 'next' },
    } } } });
    return JSON.stringify({ data: { repository: { i1: { projectItems: {
      nodes: [{ project: { id: 'P2' } }, { project: { id: 'unlinked' } }], pageInfo,
    } } } } });
  });
  expect(await fetchIssueProjects(graphql, 'o', 'r', [1])).toEqual({
    projects: [board, { ...board, id: 'P2' }], membership: { 1: ['P2'] },
  });
});
it('returns an empty board list without requesting memberships when no projects are linked', async () => {
  const graphql = vi.fn(async () => JSON.stringify({ data: { repository: { projectsV2: { nodes: [], pageInfo } } } }));
  expect(await fetchIssueProjects(graphql, 'o', 'r', [1])).toEqual({ projects: [], membership: {} });
  expect(graphql).toHaveBeenCalledTimes(1);
});
it.each(['partial', 'malformed', 'missing-issue', 'membership-cap', 'repeated-cursor'])(
  'disables board filtering instead of returning false negatives on %s metadata', async failure => {
    const graphql = vi.fn(async (query: string) => {
      if (failure === 'malformed') return '{}';
      if (query.includes('projectsV2')) return JSON.stringify({
        ...(failure === 'partial' ? { errors: [{ message: 'Forbidden' }] } : {}),
        data: { repository: { projectsV2: { nodes: [board], pageInfo: failure === 'repeated-cursor' ? { hasNextPage: true, endCursor: 'same' } : pageInfo } } },
      });
      return JSON.stringify({ data: { repository: failure === 'missing-issue' ? {} : {
        i1: { projectItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'more' } } },
      } } });
    });
    expect(await fetchIssueProjects(graphql, 'o', 'r', [1])).toEqual({ projectsReason: expect.any(String) });
    expect(graphql.mock.calls.length).toBeLessThanOrEqual(3);
  },
);
it('caps discovery even when every cursor advances', async () => {
  let page = 0;
  const graphql = vi.fn(async () => JSON.stringify({ data: { repository: { projectsV2: {
    nodes: [board], pageInfo: { hasNextPage: true, endCursor: String(++page) },
  } } } }));
  expect(await fetchIssueProjects(graphql, 'o', 'r', [1])).toHaveProperty('projectsReason');
  expect(graphql).toHaveBeenCalledTimes(10);
});
it('starts discovery while the issue list is still loading', async () => {
  let resolveNumbers!: (n: number[]) => void;
  const numbers = new Promise<number[]>(resolve => { resolveNumbers = resolve; });
  const graphql = vi.fn(async (query: string) => JSON.stringify({ data: { repository: query.includes('projectsV2')
    ? { projectsV2: { nodes: [board], pageInfo } }
    : { i1: { projectItems: { nodes: [{ project: { id: 'P1' } }], pageInfo } } },
  } }));
  const pending = fetchIssueProjects(graphql, 'o', 'r', () => numbers);
  await Promise.resolve();
  expect(graphql).toHaveBeenCalledTimes(1);
  resolveNumbers([1]);
  expect(await pending).toEqual({ projects: [board], membership: { 1: ['P1'] } });
});
it.each(['rejected-command', 'graphql-errors'])(
  'explains missing project scope from %s instead of suggesting repeated refreshes', async kind => {
    const message = "Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project'].";
    const graphql = async () => {
      if (kind === 'rejected-command') throw new Error(`gh: ${message}`);
      return JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message }] });
    };
    const result = await fetchIssueProjects(graphql, 'o', 'r', [1]);
    expect(result).toEqual({ projectsReason: expect.stringContaining('gh auth refresh -s read:project') });
  },
);
it('explains timeout separately from missing permissions', async () => {
  const result = await fetchIssueProjects(async () => { throw Object.assign(new Error('Command failed'), { killed: true }); }, 'o', 'r', [1]);
  expect(result).toEqual({ projectsReason: expect.stringContaining('timed out') });
});
it('does not expose arbitrary command error text in the cockpit', async () => {
  const result = await fetchIssueProjects(async () => { throw new Error('unexpected private output'); }, 'o', 'r', [1]);
  expect(result).toEqual({ projectsReason: 'Project boards unavailable. Refresh to try again.' });
});
it('explains denied project access without exposing the raw provider error', async () => {
  const result = await fetchIssueProjects(async () => { throw new Error('gh: Resource not accessible by integration (HTTP 403)'); }, 'o', 'r', [1]);
  expect(result).toEqual({ projectsReason: expect.stringContaining('Grant project read access') });
});
it('identifies incomplete provider data rather than suggesting a permission change', async () => {
  const result = await fetchIssueProjects(async () => '{}', 'o', 'r', [1]);
  expect(result).toEqual({ projectsReason: 'Project board data is incomplete. Refresh to try again.' });
});
it.each(['API rate limit exceeded (HTTP 403)', 'Too Many Requests (HTTP 429)'])(
  'does not suggest permission changes when GitHub returns %s', async message => {
    const result = await fetchIssueProjects(async () => { throw new Error(message); }, 'o', 'r', [1]);
    expect(result).toEqual({ projectsReason: expect.stringContaining('rate-limiting') });
  },
);

it('preserves verified memberships on failure and recovers on the next refresh', async () => {
  mockGh();
  const first = await fetchGithub('/filters-recovery', true);
  await fetchGithubProjects('/filters-recovery', first.projectsGeneration!);
  mockGh(true);
  const refreshing = await fetchGithub('/filters-recovery', true);
  expect(refreshing).toMatchObject({ projectsState: 'refreshing', projects: [board], issues: [{ projectIds: ['P1'] }] });
  const failure = await fetchGithubProjects('/filters-recovery', refreshing.projectsGeneration!);
  expect(failure).toMatchObject({ state: 'unavailable', reason: expect.any(String) });
  expect(await fetchGithub('/filters-recovery')).toMatchObject({ projectsState: 'unavailable', projects: [board], issues: [{ projectIds: ['P1'] }] });
  mockGh();
  const next = await fetchGithub('/filters-recovery', true);
  expect(await fetchGithubProjects('/filters-recovery', next.projectsGeneration!)).toMatchObject({ state: 'ready', membership: { 1: ['P1'] } });
});

it('isolates generations and repositories, so an older completion cannot replace newer metadata', async () => {
  mockGh();
  const immediate = run.getMockImplementation()!;
  let finish!: () => void;
  run.mockImplementation((...args: unknown[]) => {
    if ((args[1] as string[]).join(' ').includes('projectItems')) {
      finish = () => immediate(...args);
      return;
    }
    return immediate(...args);
  });
  const first = await fetchGithub('/filters-generation', true);
  const waiting = fetchGithubProjects('/filters-generation', first.projectsGeneration!);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  mockGh(true);
  const next = await fetchGithub('/filters-generation', true);
  await fetchGithubProjects('/filters-generation', next.projectsGeneration!);
  finish();
  expect(await waiting).toMatchObject({ generation: first.projectsGeneration, state: 'ready' });
  expect(await fetchGithub('/filters-generation')).toMatchObject({ projectsGeneration: next.projectsGeneration, projectsState: 'unavailable' });
  expect(await fetchGithubProjects('/filters-generation', first.projectsGeneration!)).toMatchObject({ state: 'unavailable' });
  expect(await fetchGithubProjects('/another-repository', next.projectsGeneration!)).toMatchObject({ state: 'unavailable' });
});

it('does not install an older list after a newer list has already completed', async () => {
  mockGh();
  const immediate = run.getMockImplementation()!;
  let finishList!: () => void;
  run.mockImplementation((...args: unknown[]) => {
    if ((args[1] as string[])[0] === 'issue') {
      finishList = () => immediate(...args);
      return;
    }
    return immediate(...args);
  });
  const older = fetchGithub('/filters-list-order', true);
  await vi.waitFor(() => expect(finishList).toBeTypeOf('function'));
  mockGh(true);
  const newer = await fetchGithub('/filters-list-order', true);
  await fetchGithubProjects('/filters-list-order', newer.projectsGeneration!);
  finishList();
  await older;
  const cached = await fetchGithub('/filters-list-order');
  expect(cached.projectsGeneration).toBe(newer.projectsGeneration);
  expect(cached.projectsState).toBe('unavailable');
});

it.each(['GH_HOST', 'GH_CONFIG_DIR'] as const)('isolates deferred hydration by %s and retains its original context', async variable => {
  const root = `/filters-context-${variable}`;
  vi.stubEnv(variable, 'context-a');
  mockGh();
  const immediate = run.getMockImplementation()!;
  let finish!: () => void;
  run.mockImplementation((...args: unknown[]) => {
    if ((args[1] as string[]).join(' ').includes('projectItems')) {
      finish = () => immediate(...args);
      return;
    }
    return immediate(...args);
  });
  const first = await fetchGithub(root, true);
  expect(first).toMatchObject({ available: true, projectsState: 'refreshing' });
  expect(first.issues[0]?.projectIds).toBeUndefined();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  vi.stubEnv(variable, 'context-b');
  const foreign = fetchGithubProjects(root, first.projectsGeneration!);
  finish();
  expect(await foreign).toMatchObject({ state: 'unavailable' });
  mockGh(true);
  const second = await fetchGithub(root, true);
  expect(second.issues[0]?.projectIds).toBeUndefined();
  await fetchGithubProjects(root, second.projectsGeneration!);
  finish();
  vi.stubEnv(variable, 'context-a');
  expect(await fetchGithubProjects(root, first.projectsGeneration!)).toMatchObject({ state: 'ready', membership: { 1: ['P1'] } });
  expect(await fetchGithub(root)).toMatchObject({ projectsGeneration: first.projectsGeneration, projectsState: 'ready', issues: [{ projectIds: ['P1'] }] });
  vi.stubEnv(variable, 'context-b');
  expect(await fetchGithub(root)).toMatchObject({ projectsGeneration: second.projectsGeneration, projectsState: 'unavailable' });
});
