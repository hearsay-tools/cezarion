import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubItemResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';

// Wrap the two item functions so the route's wiring (refresh flag, cache invalidation on merge)
// is observable while the real implementation still answers from the dry-run mock pools.
const spies = vi.hoisted(() => ({ fetch: vi.fn(), forget: vi.fn() }));
vi.mock('./github.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github.ts')>();
  spies.fetch.mockImplementation(actual.fetchGithubItem);
  return {
    ...actual,
    fetchGithubItem: (...args: Parameters<typeof actual.fetchGithubItem>) => spies.fetch(...args),
    forgetGithubItem: (...args: Parameters<typeof actual.forgetGithubItem>) => {
      spies.forget(...args);
      return actual.forgetGithubItem(...args);
    },
  };
});

import { createApp } from './server.ts';

/**
 * `GET /api/v1/github/items/:kind/:number` (#692). Route wiring only: params gate, `refresh`
 * passthrough, in-payload degrade, and cache invalidation on merge. The gh-shelling lives in
 * `forge/github.test.ts`.
 */
describe('the github item API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });
  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  beforeEach(() => {
    spies.fetch.mockClear();
    spies.forget.mockClear();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-ghitem-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns a PR matching the contract schema', async () => {
    const res = await apiRequest(app, '/api/v1/github/items/pr/128');
    expect(res.status).toBe(200);
    const body = githubItemResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ available: true, item: { kind: 'pr', number: 128 } });
    expect(spies.fetch).toHaveBeenCalledWith(expect.any(String), 'pr', 128, false);
  });

  it('answers the project-scoped alias identically', async () => {
    const res = await apiRequest(app, '/api/v1/p/default/github/items/issue/142');
    expect(res.status).toBe(200);
    expect(githubItemResponseSchema.parse(await res.json())).toMatchObject({
      available: true,
      item: { kind: 'issue', number: 142 },
    });
  });

  it('passes refresh=1 through as true', async () => {
    const res = await apiRequest(app, '/api/v1/github/items/issue/7?refresh=1');
    expect(res.status).toBe(200);
    expect(spies.fetch).toHaveBeenCalledWith(expect.any(String), 'issue', 7, true);
  });

  it('answers item null for a number GitHub does not have', async () => {
    const res = await apiRequest(app, '/api/v1/github/items/pr/99999');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, item: null });
  });

  it.each(['/github/items/bogus/1', '/github/items/pr/0', '/github/items/pr/abc', '/github/items/pr/-3'])(
    'rejects malformed params with a 400 { error } (%s)',
    async (path) => {
      const res = await apiRequest(app, `/api/v1${path}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
      expect(spies.fetch).not.toHaveBeenCalled();
    },
  );

  it('degrades to 200 { available: false } when the forge is unavailable', async () => {
    spies.fetch.mockResolvedValueOnce({ available: false, reason: 'gh CLI not found' });
    const res = await apiRequest(app, '/api/v1/github/items/pr/42');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: 'gh CLI not found' });
  });

  it('forgets the item cache entry when a merge succeeds', async () => {
    const state = (await (await apiRequest(app, '/api/v1/github/prs/128/merge-state?refresh=1')).json()) as {
      mergeState: { headSha: string };
    };
    const merge = await apiRequest(app, '/api/v1/github/prs/128/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      body: JSON.stringify({ method: 'squash', expectedHeadSha: state.mergeState.headSha }),
    });
    expect(merge.status).toBe(200);
    expect(spies.forget).toHaveBeenCalledWith(expect.any(String), 'pr', 128);
  });
});
