import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os'; // test-home-read: import for the annotated sandbox and refusal probes
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TAGS_MAX, PROJECT_TAG_MAX_LENGTH } from '@open-mercato/cezar-contract/project-limits';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import {
  allocateProjectSlug,
  clearProjectProbeCache, listProjects,
  normalizeProjectTags,
  probeProjectStatus,
  registerProject,
  removeProject,
  shouldRegisterProject,
  toProjectListEntry,
} from './projects.ts';

it('fresh undefined probe fields clear stale passthrough project metadata on the wire', () => {
  const project = {
    id: 'stale', name: 'Stale', root: '/repo', addedAt: '2026-10-25T00:00:00Z',
    lastOpenedAt: '2026-10-25T00:00:00Z', source: 'local' as const,
    branch: 'old', forge: 'github', repoUrl: 'https://example.test/old',
  };
  const result = toProjectListEntry(project, {
    status: 'ok', branch: undefined, forge: undefined, repoUrl: undefined,
  });
  expect(result.status).toBe('ok');
  for (const key of ['branch', 'forge', 'repoUrl']) expect(Object.hasOwn(result, key)).toBe(false);
  expect(project.branch).toBe('old');
});

/**
 * Project registry ops (spec 2026-07-20-multi-project-workspace, step 1.3):
 * realpath/symlink/trailing-slash dedupe, slug collision suffixes, the
 * reserved-slug skip (`default` → `default-2`), status probing
 * (ok/missing/not-git + branch), and the promise that register/remove never
 * write a byte inside the repo itself.
 */
describe('workspace projects', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;
  let repos: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-workspace-'));
    repos = mkdtempSync(join(realpathSync(tmpdir()), 'cez-repos-'));
    useTestHome(home ? Home.sandbox(home) : undefined); // paths.ts sends all workspace paths here
    clearProjectProbeCache();
  });

  afterEach(() => {
    if (originalHome === undefined) useTestHome(undefined);
    else useTestHome(originalHome ? Home.sandbox(originalHome) : undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(repos, { recursive: true, force: true });
  });

  const makeDir = (...segments: string[]): string => {
    const dir = join(repos, ...segments);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const makeRepo = (...segments: string[]): string => {
    const dir = makeDir(...segments);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd: dir },
    );
    return dir;
  };

  describe('registerProject', () => {
    it('registers a new root with slug, name, timestamps and source', async () => {
      const root = makeDir('cezar');
      const entry = await registerProject(root, undefined, testHome());
      expect(entry).toMatchObject({ id: 'cezar', root, name: 'cezar', source: 'local' });
      expect(entry.addedAt).not.toBe('');
      expect(entry.lastOpenedAt).toBe(entry.addedAt);
      expect((await loadWorkspaceConfig(testHome().workspaceConfig)).projects).toEqual([entry]);
    });

    it('dedupes a trailing-slash spelling to the existing entry and bumps lastOpenedAt', async () => {
      const root = makeDir('api');
      const first = await registerProject(root, undefined, testHome());
      const again = await registerProject(`${root}/`, undefined, testHome());
      expect(again.id).toBe(first.id);
      expect(again.addedAt).toBe(first.addedAt);
      expect(Date.parse(again.lastOpenedAt)).toBeGreaterThanOrEqual(Date.parse(first.lastOpenedAt));
      expect((await loadWorkspaceConfig(testHome().workspaceConfig)).projects).toHaveLength(1);
    });

    it('dedupes a symlinked path to the realpath entry', async () => {
      const root = makeDir('real-repo');
      const link = join(repos, 'linked-repo');
      symlinkSync(root, link);
      const first = await registerProject(root, undefined, testHome());
      const viaLink = await registerProject(link, undefined, testHome());
      expect(viaLink.id).toBe(first.id);
      expect(viaLink.root).toBe(first.root);
      expect((await loadWorkspaceConfig(testHome().workspaceConfig)).projects).toHaveLength(1);
    });

    it('suffixes colliding slugs numerically (web, web-2)', async () => {
      const a = await registerProject(makeDir('one', 'web'), undefined, testHome());
      const b = await registerProject(makeDir('two', 'web'), undefined, testHome());
      const c = await registerProject(makeDir('three', 'web'), undefined, testHome());
      expect(a.id).toBe('web');
      expect(b.id).toBe('web-2');
      expect(c.id).toBe('web-3');
    });

    it('never allocates a reserved slug — a repo named default/ becomes default-2', async () => {
      for (const reserved of ['default', 'new', 'settings', 'api', 'p', 'assets']) {
        const entry = await registerProject(makeDir('reserved', reserved), undefined, testHome());
        expect(entry.id).toBe(`${reserved}-2`);
      }
    });

    it('slugifies ugly basenames and keeps a checkout source', async () => {
      const entry = await registerProject(makeDir('My Repo!.git'), 'checkout', testHome());
      expect(entry.id).toBe('my-repo-git');
      expect(entry.source).toBe('checkout');
    });

    it('never writes any file inside the repo', async () => {
      const root = makeDir('untouched');
      writeFileSync(join(root, 'keep.txt'), 'keep', 'utf8');
      await registerProject(root, undefined, testHome());
      expect(readdirSync(root)).toEqual(['keep.txt']);
    });
  });

  describe('allocateProjectSlug', () => {
    it('falls back to "project" for a degenerate basename', () => {
      expect(allocateProjectSlug('/tmp/日本語', [])).toBe('project');
    });

    it('keeps suffixed slugs within the 64-char id cap', () => {
      const long = 'a'.repeat(80);
      const first = allocateProjectSlug(`/tmp/${long}`, []);
      expect(first).toBe('a'.repeat(64));
      const second = allocateProjectSlug(`/tmp/${long}`, [first]);
      expect(second).toBe(`${'a'.repeat(62)}-2`);
      expect(second).toHaveLength(64);
    });
  });

  describe('listProjects', () => {
    it('lists every registry entry in stored order', async () => {
      const first = await registerProject(makeDir('first'), undefined, testHome());
      const second = await registerProject(makeDir('second'), undefined, testHome());

      expect((await listProjects(testHome())).map((project) => project.id)).toEqual([first.id, second.id]);
    });

    it('reports a git repo as ok with its current branch', async () => {
      const root = makeRepo('gitful');
      await registerProject(root, undefined, testHome());
      const [entry] = await listProjects(testHome());
      expect(entry).toMatchObject({ id: 'gitful', status: 'ok', branch: 'main' });
    });

    it('classifies a github.com remote as the github forge (#698)', async () => {
      const root = makeRepo('forged');
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/forged.git'], { cwd: root });
      await registerProject(root, undefined, testHome());
      const [entry] = await listProjects(testHome());
      expect(entry).toMatchObject({ status: 'ok', forge: 'github' });
    });

    it('omits forge for a non-github remote and for a remote-less repo', async () => {
      const gitlab = makeRepo('lab');
      execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:acme/lab.git'], { cwd: gitlab });
      const bare = makeRepo('loner');
      await registerProject(gitlab, undefined, testHome());
      await registerProject(bare, undefined, testHome());
      const entries = await listProjects(testHome());
      expect(entries.every((entry) => entry.forge === undefined)).toBe(true);
    });

    it('reports a deleted root as missing (after the probe TTL cache is cleared)', async () => {
      const root = makeDir('doomed');
      await registerProject(root, undefined, testHome());
      rmSync(root, { recursive: true, force: true });
      clearProjectProbeCache();
      const [entry] = await listProjects(testHome());
      expect(entry?.status).toBe('missing');
      expect(entry?.branch).toBeUndefined();
    });

    it('reports an existing non-git dir as not-git', async () => {
      await registerProject(makeDir('plain-folder'), undefined, testHome());
      const [entry] = await listProjects(testHome());
      expect(entry?.status).toBe('not-git');
      expect(entry?.branch).toBeUndefined();
    });

    it('serves a repeat render from the TTL cache instead of re-probing', async () => {
      const root = makeDir('cached');
      await registerProject(root, undefined, testHome());
      expect((await listProjects(testHome()))[0]?.status).toBe('not-git');
      rmSync(root, { recursive: true, force: true });
      // Within the TTL the stale probe is served (no fs/git work per render)…
      expect((await listProjects(testHome()))[0]?.status).toBe('not-git');
      // …and a cleared cache sees reality again.
      clearProjectProbeCache();
      expect((await listProjects(testHome()))[0]?.status).toBe('missing');
    });
  });

  it('keeps a Git project usable when Git is absent', async () => {
    const root = makeRepo('no-git-executable');
    const path = process.env.PATH;
    process.env.PATH = makeDir('empty-path');
    try {
      expect(await probeProjectStatus(root)).toEqual({ status: 'ok' });
    } finally { process.env.PATH = path; }
  });

  it('sees a deleted root at the five-second boundary', async () => {
    const root = makeDir('expires');
    let time = 100;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    try {
      expect((await probeProjectStatus(root)).status).toBe('not-git');
      rmSync(root, { recursive: true });
      time += 4999;
      expect((await probeProjectStatus(root)).status).toBe('not-git');
      time++;
      expect((await probeProjectStatus(root)).status).toBe('missing');
    } finally { clock.mockRestore(); }
  });

  it('evicts probes on removal and on new registration', async () => {
    const root = makeDir('evicted');
    const entry = await registerProject(root, undefined, testHome());
    expect((await probeProjectStatus(root)).status).toBe('not-git');
    await removeProject(entry.id, testHome());
    rmSync(root, { recursive: true });
    expect((await probeProjectStatus(root)).status).toBe('missing');
    mkdirSync(root);
    await registerProject(root, undefined, testHome());
    expect((await probeProjectStatus(root)).status).toBe('not-git');
  });

  describe('removeProject', () => {
    it('unregisters by id and leaves every repo file untouched', async () => {
      const root = makeRepo('kept-repo');
      writeFileSync(join(root, 'precious.txt'), 'data', 'utf8');
      const before = readdirSync(root).sort();
      const entry = await registerProject(root, undefined, testHome());
      expect(await removeProject(entry.id, testHome())).toBe(true);
      expect((await loadWorkspaceConfig(testHome().workspaceConfig)).projects).toEqual([]);
      expect(readdirSync(root).sort()).toEqual(before);
      expect(execFileSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' })).toContain('init');
    });

    it('returns false for an unknown id and keeps other entries', async () => {
      const entry = await registerProject(makeDir('survivor'), undefined, testHome());
      expect(await removeProject('no-such-project', testHome())).toBe(false);
      expect((await loadWorkspaceConfig(testHome().workspaceConfig)).projects.map((p) => p.id)).toEqual([entry.id]);
    });
  });

  describe('shouldRegisterProject (boot registration guards)', () => {
    it('allows a normal repo root', async () => {
      expect(await shouldRegisterProject(makeRepo('normal-repo'))).toBe(true);
    });

    it('suppresses a cezar task worktree root', async () => {
      const worktree = makeDir('host-repo', '.ai', 'cezar', 'worktrees', 'abc12345');
      expect(await shouldRegisterProject(worktree)).toBe(false);
    });

    it('suppresses a repo nested deeper inside a task worktree', async () => {
      const nested = join(repos, 'host', '.ai', 'cezar', 'worktrees', 'run-1', 'sub', 'repo');
      // Path need not exist — normalizeRoot degrades to resolve(); the guard
      // must still recognize the worktree marker on the raw spelling.
      expect(await shouldRegisterProject(nested)).toBe(false);
    });

    it('does not suppress a repo merely named like the marker pieces', async () => {
      expect(await shouldRegisterProject(makeDir('cezar-worktrees'))).toBe(true);
    });

    it('suppresses the home directory itself, in any spelling', async () => {
      expect(await shouldRegisterProject(homedir())).toBe(false); // test-home-read: verify the home refusal predicate without registering
      expect(await shouldRegisterProject(`${homedir()}/`)).toBe(false); // test-home-read: verify the home refusal predicate without registering
    });
  });

  it('exposes the remote as a credential-free web root', async () => {
    const root = makeRepo('linked');
    execFileSync('git', ['remote', 'add', 'origin', 'https://tok3n:x@github.com/acme/linked.git'], {
      cwd: root,
    });
    await registerProject(root, undefined, testHome());
    clearProjectProbeCache();

    const listed = (await listProjects(testHome()))[0];
    // Rebuilt from the parsed remote, so the token in it cannot reach the cockpit.
    expect(listed?.repoUrl).toBe('https://github.com/acme/linked');
    expect(listed?.forge).toBe('github');
  });

  it('omits the web root for a repo with no forge remote', async () => {
    const root = makeRepo('local-only');
    execFileSync('git', ['remote', 'add', 'origin', '/srv/git/local-only.git'], { cwd: root });
    await registerProject(root, undefined, testHome());
    clearProjectProbeCache();

    const listed = (await listProjects(testHome()))[0];
    expect(listed?.repoUrl).toBeUndefined();
    expect(listed?.forge).toBeUndefined();
  });

  /**
   * The one spelling rule for grouping tags. Case-insensitive dedupe is the load-bearing part:
   * tags exist to be a GROUPING key on the global Tasks page, and `API` beside `api` splitting
   * one group in two is exactly the failure this prevents.
   */
  describe('normalizeProjectTags', () => {
    it('trims, drops empties, and sorts', () => {
      expect(normalizeProjectTags([' web ', 'api', '', '   '])).toEqual(['api', 'web']);
    });

    it('dedupes case-insensitively, keeping the first spelling', () => {
      expect(normalizeProjectTags(['Storefront', 'storefront', 'STOREFRONT'])).toEqual([
        'Storefront',
      ]);
    });

    it('truncates an over-long tag rather than dropping it', () => {
      const long = 'x'.repeat(PROJECT_TAG_MAX_LENGTH + 10);
      expect(normalizeProjectTags([long])).toEqual(['x'.repeat(PROJECT_TAG_MAX_LENGTH)]);
    });

    it('caps the list', () => {
      const many = Array.from({ length: PROJECT_TAGS_MAX + 5 }, (_, i) => `tag-${i}`);
      expect(normalizeProjectTags(many)).toHaveLength(PROJECT_TAGS_MAX);
    });

    it('answers undefined — never [] — for nothing to store', () => {
      expect(normalizeProjectTags(undefined)).toBeUndefined();
      expect(normalizeProjectTags(null)).toBeUndefined();
      expect(normalizeProjectTags([])).toBeUndefined();
      expect(normalizeProjectTags(['  '])).toBeUndefined();
    });
  });

  it('round-trips tags through the registry', async () => {
    const root = makeDir('tagged');
    const entry = await registerProject(root, undefined, testHome());
    await mergeWriteWorkspaceConfig((config) => {
      const stored = config.projects.find((p) => p.id === entry.id);
      if (stored) stored.tags = ['api', 'storefront'];
    }, testHome());
    clearProjectProbeCache();
    const listed = (await listProjects(testHome())).find((p) => p.id === entry.id);
    expect(listed?.tags).toEqual(['api', 'storefront']);
  });

  it('drops a malformed tag list per key, keeping the rest of the entry', async () => {
    const root = makeDir('bad-tags');
    const entry = await registerProject(root, undefined, testHome());
    await mergeWriteWorkspaceConfig((config) => {
      const stored = config.projects.find((p) => p.id === entry.id);
      // A hand-edited config. The per-key `.catch` must degrade the tags to "untagged"
      // rather than evicting the whole project from the registry.
      if (stored) (stored as { tags?: unknown }).tags = 'storefront';
    }, testHome());
    const listed = (await listProjects(testHome())).find((p) => p.id === entry.id);
    expect(listed).toBeDefined();
    expect(listed?.tags).toBeUndefined();
  });
});
