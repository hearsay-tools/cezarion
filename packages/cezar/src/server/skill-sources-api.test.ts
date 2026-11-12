import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKILLS_REPO_FORMATS, type TeamSkillSourcesResponse } from '@open-mercato/cezar-contract/skill-sources';
import { RunStore } from '../runs/store.ts';
import { __holdFetchForTests, bareDirFor, getTeamSourceStatuses, refreshTeamSources, sourceKey, waitForTeamSkills } from '../skills-remote.ts';
import type { Skill } from '../skills.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { SKILL_SOURCES_HOSTED_ERROR } from './skill-sources.ts';

/**
 * Team skill sources on the Skills page (hearsay-tools/cezarion#279): `/skills/sources` edits
 * `skillsRepos` in `.ai/cezar/config.json`, keeps every other key, never writes a file it cannot
 * read, and reports each source's own state. Sources are local git repos, so nothing leaves the
 * machine; `$HOME` is a temp dir, so the bare clones land there.
 */
describe('the team skill sources API', () => {
  let repoRoot: string;
  let homeRoot: string;
  let store: RunStore;
  let app: Hono;
  const saved = { HOME: process.env.HOME, CEZ_HOME: process.env.CEZ_HOME, CEZ_REMOTE: process.env.CEZ_REMOTE };
  const dirs: string[] = [];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-sources-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'cez-sources-home-'));
    process.env.HOME = homeRoot;
    useTestHome(join(homeRoot, 'cezar-sandbox') ? Home.sandbox(join(homeRoot, 'cezar-sandbox')) : undefined);
    delete process.env.CEZ_REMOTE;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    mkdirSync(join(homeRoot, 'cezar-sandbox'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ home: testHome(), repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', squawkPort: () => 4321 });
  });

  afterEach(() => {
    store.close();
    for (const dir of [repoRoot, homeRoot, ...dirs.splice(0)]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A local skills repo with one `commands/<name>.md` per name, on `main`. */
  function sourceRepo(...names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-sources-src-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'commands'));
    for (const name of names) writeFileSync(join(dir, 'commands', `${name}.md`), `${name} body`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd: dir });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'skills');
    return dir;
  }

  const configPath = () => join(repoRoot, '.ai/cezar', 'config.json');
  const rawFile = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  const send = (method: string, path: string, body?: unknown) =>
    apiRequest(app, `/api/v1${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const sources = async () => {
    return (await (await send('GET', '/skills/sources')).json()) as TeamSkillSourcesResponse;
  };
  const teamNames = async (path = '/skills') => {
    const skills = (await (await send('GET', path)).json()) as Skill[];
    return skills.filter((skill) => skill.source === 'team').map((skill) => skill.name);
  };
  // The route answers before its background fetch ends; the team load it started is the signal.
  const add = async (body: { repo: string; ref?: string }) => {
    const res = await send('POST', '/skills/sources', body);
    await waitForTeamSkills(repoRoot, testHome());
    return res;
  };

  it('lists no sources on a project without skillsRepos', async () => {
    expect(await sources()).toEqual({ sources: [], editable: true, configIssue: null });
  });

  it('adds a source to skillsRepos, keeps other keys, and lists its skills once fetched', async () => {
    writeFileSync(configPath(), JSON.stringify({ reviewGate: true }));
    const repo = sourceRepo('greet');
    const res = await send('POST', '/skills/sources', { repo });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TeamSkillSourcesResponse).sources).toEqual([
      { repo, ref: 'main', enabled: true, status: { state: 'loading' } },
    ]);
    await waitForTeamSkills(repoRoot, testHome());
    expect(rawFile()).toEqual({ reviewGate: true, skillsRepos: [{ repo }] });
    expect((await sources()).sources[0]?.status).toEqual({ state: 'ok', skillCount: 1 });
    expect(await teamNames()).toEqual(['greet']);
  });

  it('refuses a source that is already listed and writes nothing', async () => {
    const repo = sourceRepo('greet');
    await add({ repo });
    const before = readFileSync(configPath(), 'utf8');
    const res = await send('POST', '/skills/sources', { repo, ref: 'main' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `${repo} at main is already listed.` });
    expect(readFileSync(configPath(), 'utf8')).toBe(before);
  });

  it('refuses a repo in a refused format and names the accepted formats', async () => {
    const res = await send('POST', '/skills/sources', { repo: 'ext::sh -c evil' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(SKILLS_REPO_FORMATS);
    expect(() => readFileSync(configPath(), 'utf8')).toThrow();
  });

  it('disabling hides the source everywhere and enabling restores its per-skill switches', async () => {
    const repo = sourceRepo('a', 'b');
    await add({ repo });
    writeFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify({ disabledTeamSkills: [{ repo, name: 'a' }] }));
    expect(await teamNames()).toEqual(['b']);

    const off = await send('PATCH', '/skills/sources', { repo, ref: 'main', enabled: false });
    expect(off.status).toBe(200);
    expect(rawFile()).toEqual({ skillsRepos: [{ repo, enabled: false }] });
    expect(((await off.json()) as TeamSkillSourcesResponse).sources).toEqual([
      { repo, ref: 'main', enabled: false, status: { state: 'idle' } },
    ]);
    expect(await teamNames()).toEqual([]);
    expect(await teamNames('/skills/importable')).toEqual([]);

    expect((await send('PATCH', '/skills/sources', { repo, ref: 'main', enabled: true })).status).toBe(200);
    expect(rawFile()).toEqual({ skillsRepos: [{ repo }] });
    expect(await teamNames()).toEqual(['b']);
  });

  it('removing a source keeps its switches, so adding it again restores them', async () => {
    const repo = sourceRepo('a', 'b');
    await add({ repo });
    writeFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify({ disabledTeamSkills: [{ repo, name: 'a' }] }));

    expect((await send('DELETE', '/skills/sources', { repo, ref: 'main' })).status).toBe(200);
    expect(rawFile()).toEqual({ skillsRepos: [] });
    expect(await teamNames()).toEqual([]);
    expect((await send('DELETE', '/skills/sources', { repo, ref: 'main' })).status).toBe(404);

    await add({ repo });
    expect(await teamNames()).toEqual(['b']);
  });

  it('never writes a config.json it cannot read', async () => {
    writeFileSync(configPath(), '{ nope');
    const view = await sources();
    expect(view.sources).toEqual([]);
    expect(view.configIssue).toMatch(/^\.ai\/cezar\/config\.json cannot be read: /);
    const res = await send('POST', '/skills/sources', { repo: sourceRepo('a') });
    expect(res.status).toBe(409);
    expect(readFileSync(configPath(), 'utf8')).toBe('{ nope');
  });

  it('a bad value in another key is kept, and the source write goes through', async () => {
    writeFileSync(configPath(), JSON.stringify({ maxParallel: 99 }));
    const repo = sourceRepo('a');
    expect((await sources()).configIssue).toBeNull();
    expect((await add({ repo })).status).toBe(200);
    expect(rawFile()).toEqual({ maxParallel: 99, skillsRepos: [{ repo }] });
    expect(await teamNames()).toEqual(['a']);
  });

  it('a skillsRepos entry the page cannot show blocks its writes', async () => {
    const text = JSON.stringify({ skillsRepos: [{ repo: '' }] });
    writeFileSync(configPath(), text);
    expect((await sources()).configIssue).toContain('skillsRepos.0.repo');
    expect((await send('POST', '/skills/sources', { repo: sourceRepo('a') })).status).toBe(409);
    expect(readFileSync(configPath(), 'utf8')).toBe(text);
  });

  it('is read-only on a remote cockpit', async () => {
    process.env.CEZ_REMOTE = '1';
    expect((await sources()).editable).toBe(false);
    const res = await send('POST', '/skills/sources', { repo: sourceRepo('a') });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: SKILL_SOURCES_HOSTED_ERROR });
  });

  it('a failing source shows its cause while a working one still lists its skills', async () => {
    const good = sourceRepo('greet');
    const missing = join(homeRoot, 'no-such-repo');
    writeFileSync(configPath(), JSON.stringify({ skillsRepos: [{ repo: good }, { repo: missing }] }));
    await send('POST', '/skills/refresh');
    const [first, second] = (await sources()).sources;
    expect(first?.status).toEqual({ state: 'ok', skillCount: 1 });
    expect(second?.status).toMatchObject({ state: 'error', cause: 'fetch-failed', skillCount: 0 });
    expect(await teamNames()).toEqual(['greet']);

    const retry = await send('POST', '/skills/sources/retry', { repo: missing, ref: 'main' });
    expect(retry.status).toBe(200);
    await waitForTeamSkills(repoRoot, testHome());
    expect((await sources()).sources[1]?.status).toMatchObject({ state: 'error', cause: 'fetch-failed' });
  });

  it('names a branch the repo does not have, instead of serving the default branch', async () => {
    const repo = sourceRepo('greet');
    await add({ repo, ref: 'nope' });
    expect((await sources()).sources[0]?.status).toEqual({
      state: 'error',
      cause: 'ref-not-found',
      detail: `The ref "nope" was not found in ${repo}.`,
      skillCount: 0,
    });
    expect(await teamNames()).toEqual([]);
  });

  it('the default ref still reads a repo whose default branch is not main', async () => {
    const repo = sourceRepo('greet');
    execFileSync('git', ['branch', '-m', 'main', 'trunk'], { cwd: repo });
    await add({ repo });
    expect((await sources()).sources[0]?.status).toEqual({ state: 'ok', skillCount: 1 });
  });

  it('names a pinned commit the repo does not have', async () => {
    const repo = sourceRepo('greet');
    const sha = 'f'.repeat(40);
    await add({ repo, ref: sha });
    expect((await sources()).sources[0]?.status).toEqual({
      state: 'error',
      cause: 'ref-not-found',
      detail: `The ref "${sha}" was not found in ${repo}.`,
      skillCount: 0,
    });
  });

  it('a tree listing git cannot read is a failure with Retry, not an empty ok source', async () => {
    const repo = sourceRepo('greet');
    await add({ repo });
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
    rmSync(join(bareDirFor(repo, testHome()), 'objects', tree.slice(0, 2), tree.slice(2)));
    expect((await send('PATCH', '/skills/sources', { repo, ref: 'main', enabled: false })).status).toBe(200);
    expect((await send('PATCH', '/skills/sources', { repo, ref: 'main', enabled: true })).status).toBe(200);
    expect((await sources()).sources[0]?.status).toEqual({
      state: 'error',
      cause: 'fetch-failed',
      detail: `git could not list the skills of ${repo} at main.`,
      skillCount: 0,
    });
  });

  it('a fetch that ends after its source was removed does not bring the source back', async () => {
    const kept = sourceRepo('kept');
    const removed = sourceRepo('gone');
    await add({ repo: kept });
    await add({ repo: removed });
    let releaseFetch!: () => void;
    const fetch = new Promise<void>((resolve) => { releaseFetch = resolve; });
    __holdFetchForTests(removed, fetch, testHome());
    const load = refreshTeamSources(repoRoot, [{ repo: kept, ref: 'main' }, { repo: removed, ref: 'main' }], testHome());
    try {
      // The kept source settling proves the load read both entries. The removed fetch stays held.
      // bound: a hang guard for the kept source's local fetch and listing
      await vi.waitFor(() => expect(getTeamSourceStatuses(repoRoot, testHome()).get(sourceKey({ repo: kept, ref: 'main' }))?.state).toBe('ok'), { timeout: 10_000 });
      writeFileSync(configPath(), JSON.stringify({ skillsRepos: [{ repo: kept }] }));
    } finally {
      releaseFetch();
      await load;
    }
    expect(await teamNames('/skills/importable')).toEqual(['kept']);
    expect((await sources()).sources.map((source) => source.repo)).toEqual([kept]);
  });

  it('names a configured source in a refused format', async () => {
    writeFileSync(configPath(), JSON.stringify({ skillsRepos: [{ repo: 'ext::evil' }] }));
    await send('POST', '/skills/refresh');
    expect((await sources()).sources[0]?.status).toMatchObject({ state: 'error', cause: 'refused-format' });
    expect((await send('DELETE', '/skills/sources', { repo: 'ext::evil', ref: 'main' })).status).toBe(200);
  });
});
