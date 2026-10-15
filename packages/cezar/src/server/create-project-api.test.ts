import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckoutProgressResponse, CreateProjectResponse, GithubOwnersResponse } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache } from '../workspace/projects.ts';
import { dryRunCommandRunner, type CommandRunner } from './create-project.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { WorkspaceEventBus, createApp, type ServerDeps } from './server.ts';

/**
 * The new-project routes (spec 2026-10-15-create-new-project): `POST /api/v1/projects/create`
 * and `GET /api/v1/projects/github-owners`, through the real app — validation middleware, the
 * single-project and hosted gates, the progress cache, and registration.
 */

describe('new-project routes', () => {
  const saved = {
    home: process.env.CEZ_HOME,
    remote: process.env.CEZ_REMOTE,
    single: process.env.CEZ_SINGLE_PROJECT,
    dryRun: process.env.CEZ_DRY_RUN,
  };
  let home: string;
  let repoRoot: string;
  let projectsDir: string;
  let store: RunStore;
  let calls: string[][];

  /** The dry-run runner (real git with a lent identity, fake gh), recording every argv. */
  const recording = (fail?: (args: string[]) => string | undefined): CommandRunner => async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    const error = fail?.([cmd, ...args]);
    if (error) return { ok: false, error };
    return dryRunCommandRunner(cmd, args, opts);
  };

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-api-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-boot-'));
    projectsDir = join(home, 'projects');
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_SINGLE_PROJECT;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    calls = [];
    clearProjectProbeCache();
    await mergeWriteWorkspaceConfig((config) => {
      config.projectsDir = projectsDir;
    });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('CEZ_HOME', saved.home);
    restore('CEZ_REMOTE', saved.remote);
    restore('CEZ_SINGLE_PROJECT', saved.single);
    restore('CEZ_DRY_RUN', saved.dryRun);
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', projectCommandRunner: recording(), ...over });

  const create = async (body: unknown, over: Partial<ServerDeps> = {}) => {
    const res = await apiRequest(makeApp(over), '/api/v1/projects/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as CreateProjectResponse & { error?: string; reason?: string } };
  };

  const owners = async (over: Partial<ServerDeps> = {}) => {
    const res = await apiRequest(makeApp(over), '/api/v1/projects/github-owners');
    return { status: res.status, body: (await res.json()) as GithubOwnersResponse };
  };

  it('creates a local project with one commit and registers it as local', async () => {
    const { status, body } = await create({ name: 'fresh' });
    expect(status).toBe(200);
    const target = join(projectsDir, 'fresh');
    expect(body.project).toMatchObject({ name: 'fresh', root: realpathSync(target), source: 'local' });
    expect(body.warning).toBeUndefined();
    expect('warning' in body).toBe(false);
    expect(execFileSync('git', ['-C', target, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).trim()).toBe('1');
    expect((await loadWorkspaceConfig()).projects.map((p) => p.root)).toContain(realpathSync(target));
  });

  it('a GitHub-backed project registers as checkout', async () => {
    const { status, body } = await create({ name: 'fresh', github: { owner: 'acme' } });
    expect(status).toBe(200);
    expect(body.project.source).toBe('checkout');
    expect(calls).toContainEqual(['gh', 'repo', 'create', 'acme/fresh', '--private']);
  });

  it('400s a malformed body or an invalid name in the middleware, before anything runs', async () => {
    for (const body of [{ name: 'my project' }, { name: '..' }, { totalNonsense: 1 }, { name: 'ok', github: { owner: '' } }]) {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
    expect(calls).toEqual([]);
    expect(existsSync(projectsDir)).toBe(false);
  });

  it('single-project mode refuses before anything is created', async () => {
    process.env.CEZ_SINGLE_PROJECT = '1';
    const res = await create({ name: 'fresh' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'single-project mode is enabled; adding projects is disabled' });
    expect(calls).toEqual([]);
    expect(existsSync(join(projectsDir, 'fresh'))).toBe(false);
  });

  it('hosted mode refuses GitHub creation before anything runs, and owners never call gh', async () => {
    process.env.CEZ_REMOTE = '1';
    await mergeWriteWorkspaceConfig((config) => {
      config.browseRoot = home;
    });
    const refused = await create({ name: 'fresh', github: { owner: 'acme' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('Creating GitHub repositories is available from a local cockpit only');
    const listed = await owners();
    expect(listed).toEqual({
      status: 200,
      body: { available: false, reason: 'GitHub repositories can be created from a local cockpit only' },
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(projectsDir, 'fresh'))).toBe(false);
  });

  it('hosted mode still creates a local project inside the browse root', async () => {
    process.env.CEZ_REMOTE = '1';
    await mergeWriteWorkspaceConfig((config) => {
      config.browseRoot = home;
    });
    const { status, body } = await create({ name: 'fresh' });
    expect(status).toBe(200);
    expect(body.project.source).toBe('local');
  });

  it('hosted mode refuses a checkout root outside the browse root before anything is created', async () => {
    process.env.CEZ_REMOTE = '1';
    const browseRoot = join(home, 'browse');
    mkdirSync(browseRoot);
    await mergeWriteWorkspaceConfig((config) => {
      config.browseRoot = browseRoot;
    });
    const res = await create({ name: 'fresh' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'folder is outside the browsable root' });
    expect(calls).toEqual([]);
    expect(existsSync(projectsDir)).toBe(false);
  });

  it('hosted mode refuses a checkout root that escapes the browse root through a symlink', async () => {
    process.env.CEZ_REMOTE = '1';
    const browseRoot = join(home, 'browse');
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-create-outside-'));
    mkdirSync(browseRoot);
    symlinkSync(outside, join(browseRoot, 'link'));
    await mergeWriteWorkspaceConfig((config) => {
      config.browseRoot = browseRoot;
      config.projectsDir = join(browseRoot, 'link', 'projects');
    });
    try {
      const res = await create({ name: 'fresh' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'folder is outside the browsable root' });
      expect(existsSync(join(outside, 'projects'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a push failure after the repository exists keeps and registers the project with a warning, also on the progress route', async () => {
    const workspaceEvents = new WorkspaceEventBus();
    const app = makeApp({
      workspaceEvents,
      projectCommandRunner: recording((argv) => (argv[1] === 'push' ? 'fatal: unable to access' : undefined)),
    });
    const res = await apiRequest(app, '/api/v1/projects/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fresh', github: { owner: 'acme' }, checkoutId: 'np-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateProjectResponse;
    expect(body.project.source).toBe('checkout');
    expect(body.warning).toContain('https://github.com/acme/fresh was created, but pushing main failed: fatal: unable to access');
    const progress = (await (await apiRequest(app, '/api/v1/projects/checkout/np-1/progress')).json()) as CheckoutProgressResponse;
    expect(progress.progress).toMatchObject({ checkoutId: 'np-1', phase: 'done', warning: body.warning });
  });

  it('a GitHub name collision answers 409 and creates nothing', async () => {
    const runner = recording();
    const collide: CommandRunner = async (cmd, args, opts) =>
      cmd === 'gh' && args[1] === 'repos/acme/fresh' ? { ok: true, stdout: 'acme/fresh\n' } : runner(cmd, args, opts);
    const res = await create({ name: 'fresh', github: { owner: 'acme' } }, { projectCommandRunner: collide });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('a repository named acme/fresh already exists on GitHub');
    expect(existsSync(join(projectsDir, 'fresh'))).toBe(false);
  });

  it('gh missing answers 503 with { error, reason }', async () => {
    const missing: CommandRunner = async () => ({ ok: false, error: 'spawn gh ENOENT', notFound: true });
    const res = await create({ name: 'fresh', github: { owner: 'acme' } }, { projectCommandRunner: missing });
    expect(res.status).toBe(503);
    expect(res.body.reason).toContain('gh CLI not found');
  });

  it('owners answers 200 — the injected runner locally, available:false when gh is missing', async () => {
    const listed = await owners({
      projectCommandRunner: async (_cmd, args) =>
        args[1] === 'user' ? { ok: true, stdout: 'octo\thttps://a/1\n' } : { ok: true, stdout: '' },
    });
    expect(listed).toEqual({ status: 200, body: { available: true, owners: [{ login: 'octo', personal: true, avatarUrl: 'https://a/1' }] } });
    const missing = await owners({ projectCommandRunner: async () => ({ ok: false, error: 'ENOENT', notFound: true }) });
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ available: false, reason: expect.stringContaining('gh CLI not found') });
  });
});
