import { afterEach, expect, it, vi } from 'vitest';
import { resolveCockpit } from '../task-cli/discovery.ts';
import { TaskCliError } from '../task-cli/http.ts';
import type { DraftPrInput } from '../server/forge/types.ts';

const tools = vi.hoisted(() => ({ output: vi.fn<(bin: string, args: string[]) => string>() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = vi.fn((bin: string, args: string[], _options: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
    callback(null, tools.output(bin, args), '');
  });
  Object.defineProperty(execFile, promisify.custom, { value: async (bin: string, args: string[]) => ({ stdout: tools.output(bin, args), stderr: '' }) });
  return { ...actual, execFile };
});
vi.mock('../autosave-commit.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../autosave-commit.ts')>(), autosaveCommit: async () => 'clean',
}));
vi.mock('../task-branch-head.ts', () => ({ headLeftTaskBranch: async () => undefined }));

import { createDraftPr } from '../server/forge/draft-pr.ts';
import { fetchGithubPrDiff, fetchGithubChecks } from '../server/forge/github.ts';

afterEach(() => { vi.unstubAllEnvs(); tools.output.mockReset(); });

it('preferred dry-run generates GitHub results without running gh or pushing', async () => {
  vi.stubEnv('HSQ_DRY_RUN', '1'); vi.stubEnv('CEZ_DRY_RUN', '0');
  expect((await fetchGithubPrDiff('/repo/preferred-dry', 128)).available).toBe(true);
  expect((await fetchGithubChecks('/repo/preferred-dry', [128])).available).toBe(true);
  const result = await createDraftPr({ run: { worktreePath: '/repo', branch: 'cez/env' } } as DraftPrInput);
  expect(result).toMatchObject({ ok: true, dryRun: true });
  expect(tools.output).not.toHaveBeenCalled();
});

it('an empty preferred dry-run permits actual diff and checks queries over a legacy opt-in', async () => {
  vi.stubEnv('HSQ_DRY_RUN', ''); vi.stubEnv('CEZ_DRY_RUN', '1');
  tools.output.mockImplementation((_bin, args) => {
    if (args[0] === 'pr') return JSON.stringify({ headRefOid: 'a'.repeat(40) });
    if (args[0] === 'repo') return 'owner/repo';
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pr0: null } } });
    return JSON.stringify([{ filename: 'changed.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }]);
  });
  const diff = await fetchGithubPrDiff('/repo/preferred-live', 71);
  expect(diff).toMatchObject({ available: true, files: [{ path: 'changed.ts' }], additions: 1 });
  expect(await fetchGithubChecks('/repo/preferred-live', [71, -1, 71])).toEqual({ available: true, checks: { 71: null } });
  const calls = tools.output.mock.calls.length;
  expect(await fetchGithubChecks('/repo/preferred-live', [71])).toEqual({ available: true, checks: { 71: null } });
  expect(tools.output).toHaveBeenCalledTimes(calls);
});

it('an empty preferred dry-run publishes through git and gh over the legacy dry-run setting', async () => {
  vi.stubEnv('HSQ_DRY_RUN', ''); vi.stubEnv('CEZ_DRY_RUN', '1');
  tools.output.mockImplementation((bin, args) => bin === 'git' ? 'origin' : args[0] === 'pr' ? 'https://github.com/owner/repo/pull/71' : '');
  expect(await createDraftPr({ run: { worktreePath: '/repo', branch: 'cez/env', task: 'test', title: 'test', baseBranch: 'origin/main' }, handoffText: '' } as DraftPrInput))
    .toEqual({ ok: true, url: 'https://github.com/owner/repo/pull/71', dryRun: false });
  expect(tools.output.mock.calls.map(([bin, args]) => [bin, ...args.slice(0, 2)])).toEqual([
    ['git', 'remote', 'get-url'], ['git', 'push', '-u'], ['gh', 'pr', 'create'],
  ]);
});

it('cockpit address aliases keep preferred values, clears, discovery and error hints', async () => {
  const found = { origin: 'http://found', projectId: 'found', api: 'http://found/api/v1/p/found' };
  const discover = vi.fn(async () => found);
  expect(await resolveCockpit({ HSQ_COCKPIT_URL: 'http://preferred/path', CEZ_COCKPIT_URL: 'http://legacy', HSQ_PROJECT_ID: 'preferred' }, {}, discover, 'missing'))
    .toMatchObject({ origin: 'http://preferred', projectId: 'preferred' });
  await expect(resolveCockpit({ HSQ_COCKPIT_URL: 'invalid', HSQ_PROJECT_ID: 'p' }, {}, discover, 'missing')).rejects.toMatchObject({ exitCode: 2 });
  expect(await resolveCockpit({ HSQ_URL: '', CEZ_URL: 'http://legacy' }, { repo: '/repo' }, discover, 'missing')).toBe(found);
  expect(discover).toHaveBeenCalledWith({ url: undefined, repoDir: '/repo' });
  const failure = async () => { throw new TaskCliError(2, { code: 'no-cockpit', error: 'absent', hint: 'start a cockpit' }); };
  await expect(resolveCockpit({}, { repo: '/repo' }, failure, 'missing', { removeDiscoveryHint: true })).rejects.toMatchObject({ body: { code: 'no-cockpit', error: 'absent' } });
  await expect(resolveCockpit({}, { repo: '/repo' }, failure, 'missing')).rejects.toMatchObject({ body: { hint: 'start a cockpit' } });
});
