import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __holdFetchForTests,
  __pauseAfterCachedListForTests,
  bareDirFor,
  getTeamSkillsCached,
  isPinnedSha,
  lastFetchStampPath,
  listRemoteSkills,
  materializeSkillToCache,
  readLastFetchAt,
  refreshTeamSkills,
  shouldPassiveFetch,
  shouldRecordFetchFailure,
  skillFilesCacheDirFor,
  waitForCachedTeamSkills,
  waitForTeamSkills,
  writeLastFetchAt,
} from './skills-remote.ts';
import { discoverSkills, type Skill } from './skills.ts';
import { seedTeamDirSkillClone, seedTeamSkillsClone, writeSkillsReposConfig } from './skills-remote.testkit.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches when no stamp exists (unknown freshness)', () => {
    // A clone left by an earlier run, or a cache that never wrote a stamp,
    // must refresh on first read — otherwise every process serves whatever
    // ref that old clone happened to have.
    expect(shouldPassiveFetch({ fetchedAt: null, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once a stamp is present', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the stamp is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('shouldRecordFetchFailure', () => {
  it('does not record a local failure when a sibling already stamped the clone', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldRecordFetchFailure({ fetchedAt: now - 1_000, now, ttlMs: TTL })).toBe(false);
  });

  it('records a failure when there is still no usable stamp', () => {
    expect(shouldRecordFetchFailure({ fetchedAt: null, now: 1_000, ttlMs: TTL })).toBe(true);
  });
});

describe('last-fetch stamp IO', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-stamp-'));
    dirs.push(dir);
    return dir;
  }

  it('returns null when the stamp file is missing', () => {
    expect(readLastFetchAt(scratch())).toBeNull();
  });

  it('returns null when the stamp is empty, non-numeric, or non-positive', () => {
    const dir = scratch();
    writeFileSync(lastFetchStampPath(dir), '\n');
    expect(readLastFetchAt(dir)).toBeNull();
    writeFileSync(lastFetchStampPath(dir), 'not-a-time\n');
    expect(readLastFetchAt(dir)).toBeNull();
    writeFileSync(lastFetchStampPath(dir), '0\n');
    expect(readLastFetchAt(dir)).toBeNull();
    writeFileSync(lastFetchStampPath(dir), '-12\n');
    expect(readLastFetchAt(dir)).toBeNull();
  });

  it('round-trips a positive millisecond timestamp', async () => {
    const dir = scratch();
    await writeLastFetchAt(dir, 1_700_000_000_123);
    expect(readLastFetchAt(dir)).toBe(1_700_000_000_123);
    expect(readFileSync(lastFetchStampPath(dir), 'utf8').trim()).toBe('1700000000123');
  });

  it('does not throw when the stamp cannot be written (read-only cache)', async () => {
    await expect(writeLastFetchAt('/no/such/cez-stamp-dir', 1)).resolves.toBeUndefined();
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('open-mercato/skills');
    expect(bareDirFor('https://github.com/open-mercato/skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:open-mercato/skills')).toBe(expected);
    expect(expected.endsWith('open-mercato__skills')).toBe(true);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});

describe('cached team-skill list before the passive fetch (#859)', () => {
  const dirs: string[] = [];
  const releases: Array<() => void> = [];
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** A fresh home + project naming one source whose passive fetch never returns until released. */
  function heldFetchProject(): { repoRoot: string; repo: string; release: () => void } {
    vi.stubEnv('HOME', scratch('cez-team-home-'));
    const repoRoot = scratch('cez-team-root-');
    const repo = `org-${randomUUID().slice(0, 8)}/skills`;
    writeSkillsReposConfig(repoRoot, [repo]);
    let release!: () => void;
    __holdFetchForTests(repo, new Promise<void>((resolve) => { release = resolve; }));
    releases.push(release);
    return { repoRoot, repo, release };
  }

  const names = (skills: Array<{ name: string }>) => skills.map((skill) => skill.name).sort();
  const settledWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  it('lists the on-disk clone while the fetch hangs, then the post-fetch list replaces it', async () => {
    const { repoRoot, repo, release } = heldFetchProject();
    const clone = await seedTeamSkillsClone(repo, { alpha: 'ALPHA-BODY' });
    dirs.push(clone.sourceDir);

    expect(getTeamSkillsCached(repoRoot)).toEqual([]);
    const cached = await waitForCachedTeamSkills(repoRoot);
    expect(names(cached)).toEqual(['alpha']);
    expect(cached[0]).toMatchObject({ body: 'ALPHA-BODY', source: 'team', team: { repo, ref: 'main' } });
    expect(names(getTeamSkillsCached(repoRoot))).toEqual(['alpha']);
    expect(await settledWithin(waitForTeamSkills(repoRoot), 200)).toBe(false);

    await clone.addSkill('beta', 'BETA-BODY');
    release();
    expect(names(await waitForTeamSkills(repoRoot))).toEqual(['alpha', 'beta']);
    expect(names(getTeamSkillsCached(repoRoot))).toEqual(['alpha', 'beta']);
    expect(names(await waitForCachedTeamSkills(repoRoot))).toEqual(['alpha']);
  });

  it('a passive load that listed the old clone never overwrites a concurrent refresh', async () => {
    vi.stubEnv('HOME', scratch('cez-team-home-'));
    const repoRoot = scratch('cez-team-root-');
    const repo = `org-${randomUUID().slice(0, 8)}/skills`;
    writeSkillsReposConfig(repoRoot, [repo]);
    const clone = await seedTeamSkillsClone(repo, { alpha: 'ALPHA-BODY' });
    dirs.push(clone.sourceDir);
    let resume!: () => void;
    const parked = __pauseAfterCachedListForTests(repoRoot, new Promise<void>((resolve) => { resume = resolve; }));
    releases.push(resume);

    // The passive load snapshots [alpha], then a refresh fetches beta, stamps
    // the clone fresh and publishes first; the passive load must not undo it.
    const passive = waitForTeamSkills(repoRoot);
    await parked;
    await clone.addSkill('beta', 'BETA-BODY');
    expect(names(await refreshTeamSkills(repoRoot))).toEqual(['alpha', 'beta']);
    resume();

    const passiveList = await passive;
    expect(names(getTeamSkillsCached(repoRoot))).toEqual(['alpha', 'beta']);
    expect(names(passiveList)).toEqual(['alpha', 'beta']);
  });

  it('a passive load re-lists a shared clone that another project refreshed after its snapshot', async () => {
    vi.stubEnv('HOME', scratch('cez-team-home-'));
    const repoRoot = scratch('cez-team-root-');
    const otherRoot = scratch('cez-team-root-');
    const repo = `org-${randomUUID().slice(0, 8)}/skills`;
    writeSkillsReposConfig(repoRoot, [repo]);
    writeSkillsReposConfig(otherRoot, [repo]);
    const clone = await seedTeamSkillsClone(repo, { alpha: 'ALPHA-BODY' });
    dirs.push(clone.sourceDir);
    let resume!: () => void;
    const parked = __pauseAfterCachedListForTests(repoRoot, new Promise<void>((resolve) => { resume = resolve; }));
    releases.push(resume);

    // The bare clone and its stamp are shared by every project (and process);
    // this project's own publications never see a refresh made from another.
    const passive = waitForTeamSkills(repoRoot);
    await parked;
    await clone.addSkill('beta', 'BETA-BODY');
    expect(names(await refreshTeamSkills(otherRoot))).toEqual(['alpha', 'beta']);
    resume();

    expect(names(await passive)).toEqual(['alpha', 'beta']);
    expect(names(getTeamSkillsCached(repoRoot))).toEqual(['alpha', 'beta']);
  });

  it('resolves empty without waiting on the fetch when no clone exists', async () => {
    const { repoRoot } = heldFetchProject();

    expect(await waitForCachedTeamSkills(repoRoot)).toEqual([]);
    expect(await settledWithin(waitForTeamSkills(repoRoot), 200)).toBe(false);
  });
});

describe('materializeSkillToCache — the per-commit copy for runs without a task worktree (#1024)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** The skill as a fresh listing reads it now — its body and `team.commit` at the current `main`. */
  async function listGreeter(repo: string) {
    const greeter = (await listRemoteSkills({ repo, ref: 'main' })).find((skill) => skill.name === 'greeter');
    if (!greeter) throw new Error('expected the directory skill to be listed');
    return greeter;
  }

  /** A temp `$HOME` and a bare-cloned source whose `greeter` directory skill can move upstream. */
  async function greeterSource() {
    const home = scratch('cez-team-home-');
    vi.stubEnv('HOME', home);
    const repo = `org-${randomUUID().slice(0, 8)}/skills`;
    const source = await seedTeamDirSkillClone(repo, 'greeter', {
      'SKILL.md': 'say hi v1\n',
      'references/notes.md': 'notes v1\n',
    });
    dirs.push(source.sourceDir);
    const greeter = await listGreeter(repo);
    // Keyed exactly like the bare clone, under a sibling cache root.
    const cacheRoot = join(home, '.cache', 'cez', 'skill-files', basename(bareDirFor(repo)));
    return { home, repo, source, greeter, cacheRoot };
  }

  it('copies the whole directory into <cache>/<commit>/<name> and reuses it for the same commit', async () => {
    const { repo, source, greeter, cacheRoot } = await greeterSource();
    expect(skillFilesCacheDirFor(repo)).toBe(cacheRoot);

    const first = await materializeSkillToCache(greeter);
    expect(first).toBe(join(cacheRoot, source.commit, 'greeter'));
    expect(readFileSync(join(first!, 'SKILL.md'), 'utf8')).toBe('say hi v1\n');
    expect(readFileSync(join(first!, 'references', 'notes.md'), 'utf8')).toBe('notes v1\n');

    // Same commit: the complete copy is reused as-is, not rebuilt.
    writeFileSync(join(first!, 'sentinel'), 'kept\n');
    expect(await materializeSkillToCache(greeter)).toBe(first);
    expect(readFileSync(join(first!, 'sentinel'), 'utf8')).toBe('kept\n');

    // A newer commit gets its own directory; the old one is still fresh, so it stays.
    const v2 = await source.update({ 'SKILL.md': 'say hi v2\n' });
    const second = await materializeSkillToCache(await listGreeter(repo));
    expect(second).toBe(join(cacheRoot, v2, 'greeter'));
    expect(readFileSync(join(second!, 'SKILL.md'), 'utf8')).toBe('say hi v2\n');
    expect(existsSync(join(second!, 'references'))).toBe(false);
    expect(existsSync(first!)).toBe(true);
  });

  it('copies the commit the skill was listed at, not where the ref moved since', async () => {
    const { source, greeter, cacheRoot } = await greeterSource();
    // Another project fetches main to v2 between listing and materializing.
    await source.update({ 'SKILL.md': 'say hi v2\n' });

    const dir = await materializeSkillToCache(greeter);
    expect(dir).toBe(join(cacheRoot, source.commit, 'greeter'));
    expect(readFileSync(join(dir!, 'SKILL.md'), 'utf8')).toBe('say hi v1\n');
    expect(readFileSync(join(dir!, 'references', 'notes.md'), 'utf8')).toBe('notes v1\n');
  });

  it('falls back to the ref when the listed commit is absent or not in the clone', async () => {
    const { source, greeter, cacheRoot } = await greeterSource();
    const v2 = await source.update({ 'SKILL.md': 'say hi v2\n' });
    const team = greeter.team!;
    for (const commit of [undefined, 'f'.repeat(40)]) {
      const dir = await materializeSkillToCache({ ...greeter, team: { ...team, commit } });
      expect(dir, String(commit)).toBe(join(cacheRoot, v2, 'greeter'));
      expect(readFileSync(join(dir!, 'SKILL.md'), 'utf8')).toBe('say hi v2\n');
    }
  });

  it('prunes commit dirs untouched for a week', async () => {
    const { repo, source, greeter, cacheRoot } = await greeterSource();
    expect(await materializeSkillToCache(greeter)).toBe(join(cacheRoot, source.commit, 'greeter'));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(join(cacheRoot, source.commit), eightDaysAgo, eightDaysAgo);

    const v2 = await source.update({ 'SKILL.md': 'say hi v2\n' });
    expect(await materializeSkillToCache(await listGreeter(repo))).toBe(join(cacheRoot, v2, 'greeter'));
    expect(existsSync(join(cacheRoot, source.commit))).toBe(false);
  });

  it('touches a reused commit dir so pruning measures last use, not creation', async () => {
    const { source, greeter, cacheRoot } = await greeterSource();
    expect(await materializeSkillToCache(greeter)).toBe(join(cacheRoot, source.commit, 'greeter'));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    utimesSync(join(cacheRoot, source.commit), eightDaysAgo, eightDaysAgo);

    expect(await materializeSkillToCache(greeter)).toBe(join(cacheRoot, source.commit, 'greeter'));
    expect(statSync(join(cacheRoot, source.commit)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('degrades to null, never a throw, when the cache cannot be written', async () => {
    const { home, greeter } = await greeterSource();
    writeFileSync(join(home, '.cache', 'cez', 'skill-files'), 'not a directory\n');
    await expect(materializeSkillToCache(greeter)).resolves.toBeNull();
  });
});

describe('team skills from several sources (#1494)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** Two real sources both offering `shared`; A is listed twice (two refs), so its copies repeat. */
  async function twoSourceProject(uiState?: Record<string, unknown>): Promise<{ repoRoot: string; a: string; b: string }> {
    vi.stubEnv('HOME', scratch('cez-team-home-'));
    vi.stubEnv('CEZ_HOME', scratch('cez-team-cezhome-'));
    const repoRoot = scratch('cez-team-root-');
    const a = `org-${randomUUID().slice(0, 8)}/skills`;
    const b = `org-${randomUUID().slice(0, 8)}/skills`;
    for (const [repo, skills] of [[a, { shared: 'A-SHARED', onlya: 'A-ONLY' }], [b, { shared: 'B-SHARED' }]] as const) {
      const clone = await seedTeamSkillsClone(repo, skills);
      dirs.push(clone.sourceDir);
      // A fresh stamp: the load lists the on-disk clone and never fetches.
      await writeLastFetchAt(clone.bareDir, Date.now());
    }
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({
      skillsRepos: [{ repo: a, ref: 'main' }, { repo: b, ref: 'main' }, { repo: a, ref: 'main' }],
    }));
    if (uiState) writeFileSync(join(repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify(uiState));
    return { repoRoot, a, b };
  }

  const refs = (skills: Skill[]) => skills.map((skill) => `${skill.team?.repo}:${skill.name}`).sort();

  it('keeps one copy per source and name in the team list', async () => {
    const { repoRoot, a, b } = await twoSourceProject();
    expect(refs(await waitForTeamSkills(repoRoot))).toEqual([`${a}:onlya`, `${a}:shared`, `${b}:shared`].sort());
    expect(refs(getTeamSkillsCached(repoRoot))).toEqual([`${a}:onlya`, `${a}:shared`, `${b}:shared`].sort());
  });

  it('the first source wins a name until its copy is switched off, then the next source shows', async () => {
    const on = await twoSourceProject();
    await waitForTeamSkills(on.repoRoot);
    expect((await discoverSkills(on.repoRoot)).find((skill) => skill.name === 'shared')).toMatchObject({ body: 'A-SHARED', team: { repo: on.a } });

    const off = await twoSourceProject();
    writeFileSync(join(off.repoRoot, '.ai/cezar/ui-state.json'), JSON.stringify({ disabledTeamSkills: [{ repo: off.a, name: 'shared' }] }));
    await waitForTeamSkills(off.repoRoot);
    const shared = (await discoverSkills(off.repoRoot)).filter((skill) => skill.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ body: 'B-SHARED', team: { repo: off.b } });
  });
});
