import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutRoot, discoverCockpit } from './discovery.ts';
import { TaskCliError } from './http.ts';

/** `cez task` discovery (#504): find the cockpit whose registry holds THIS checkout. */
function health(repoRoot: string) {
  return {
    version: '0.0.0-test', repoRoot, repo: null, checks: [], defaultRunner: 'claude', forge: null,
    capabilities: { localHandoff: true, followups: false, singleProject: false, automations: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true },
    projects: [], bootProject: 'boot',
  };
}
function project(id: string, root: string, webhook?: { url: string; tokenSet: boolean }) {
  return { id, name: id, root, addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', source: 'local', status: 'ok', ...(webhook ? { webhook } : {}) };
}

describe('discoverCockpit', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  const tmp = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };
  const gitRepo = () => {
    const dir = tmp('cez-discovery-repo-');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    return dir;
  };
  /** A fake cockpit serving health + the registry; resolves to its port. */
  const cockpit = async (projects: Array<ReturnType<typeof project>>, bootProject = projects[0]?.id ?? 'boot') => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/health') res.end(JSON.stringify(health(projects[0]?.root ?? '/')));
      else if (req.url === '/api/v1/projects') res.end(JSON.stringify({ projects, bootProject, projectsDir: '/tmp' }));
      else { res.statusCode = 404; res.end('{"error":"not found"}'); }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeEach(() => { servers.length = 0; dirs.length = 0; });
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('picks the project whose root is this checkout', async () => {
    const repo = gitRepo();
    const port = await cockpit([project('other', '/nowhere'), project('mine', repo)]);
    const found = await discoverCockpit({ repoDir: repo, ports: [port] });
    expect(found).toEqual({ origin: `http://127.0.0.1:${port}`, projectId: 'mine', api: `http://127.0.0.1:${port}/api/v1/p/mine`, hasWebhook: false });
  });

  it('carries whether the matched project has a task webhook (#589)', async () => {
    const repo = gitRepo();
    const port = await cockpit([project('mine', repo, { url: 'https://bot.example/hook', tokenSet: true })]);
    expect((await discoverCockpit({ repoDir: repo, ports: [port] })).hasWebhook).toBe(true);
  });

  it('skips a cockpit that serves a different repo', async () => {
    const repo = gitRepo();
    const elsewhere = await cockpit([project('stranger', tmp('cez-discovery-other-'))]);
    const mine = await cockpit([project('mine', repo)]);
    const found = await discoverCockpit({ repoDir: repo, ports: [elsewhere, mine] });
    expect(found.projectId).toBe('mine');
    expect(found.origin).toBe(`http://127.0.0.1:${mine}`);
  });

  it('resolves a task worktree to its parent project', async () => {
    const repo = gitRepo();
    const worktree = join(repo, '.ai/cezar/worktrees/abc');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'cez/abc', worktree]);
    expect(await checkoutRoot(worktree)).toBe(repo);
    const port = await cockpit([project('mine', repo)]);
    expect((await discoverCockpit({ repoDir: join(worktree), ports: [port] })).projectId).toBe('mine');
  });

  it('discovers the submodule project from its task worktree, not the superproject', async () => {
    const source = gitRepo();
    const superproject = gitRepo();
    execFileSync('git', ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'nested module']);
    const module = join(superproject, 'nested module');
    const worktree = join(module, '.ai/cezar/worktrees/abc');
    execFileSync('git', ['-C', module, 'worktree', 'add', '-q', '-b', 'cez/abc', worktree]);
    expect(await checkoutRoot(module)).toBe(module);
    expect(await checkoutRoot(worktree)).toBe(module);
    const port = await cockpit([project('superproject', superproject), project('module', module)]);
    expect((await discoverCockpit({ repoDir: worktree, ports: [port] })).projectId).toBe('module');
  });

  it('fails with no-cockpit (exit 2) when nothing serves this checkout', async () => {
    const repo = gitRepo();
    const port = await cockpit([project('stranger', '/nowhere')]);
    const error = await discoverCockpit({ repoDir: repo, ports: [port, 1] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskCliError);
    expect((error as TaskCliError).exitCode).toBe(2);
    expect((error as TaskCliError).body).toMatchObject({ code: 'no-cockpit', hint: `start the cockpit in ${repo} with: cez` });
  });

  it('with --url and no root match, uses the boot project', async () => {
    const repo = gitRepo();
    const port = await cockpit([project('remote-a', '/srv/a'), project('remote-b', '/srv/b')], 'remote-b');
    const found = await discoverCockpit({ url: `http://127.0.0.1:${port}/`, repoDir: repo });
    expect(found).toEqual({ origin: `http://127.0.0.1:${port}`, projectId: 'remote-b', api: `http://127.0.0.1:${port}/api/v1/p/remote-b`, hasWebhook: false });
  });

  it('with --url pointing at nothing, reports the url as unreachable (exit 2)', async () => {
    const repo = gitRepo();
    const error = await discoverCockpit({ url: 'http://127.0.0.1:1', repoDir: repo }).catch((e: unknown) => e);
    expect((error as TaskCliError).exitCode).toBe(2);
    expect((error as TaskCliError).body).toMatchObject({ code: 'no-cockpit' });
  });
});
