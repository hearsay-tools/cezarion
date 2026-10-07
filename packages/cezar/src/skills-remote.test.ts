import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __holdFetchForTests,
  __pauseAfterCachedListForTests,
  bareDirFor,
  getTeamSkillsCached,
  isPinnedSha,
  lastFetchStampPath,
  readLastFetchAt,
  refreshTeamSkills,
  shouldPassiveFetch,
  shouldRecordFetchFailure,
  waitForCachedTeamSkills,
  waitForTeamSkills,
  writeLastFetchAt,
} from './skills-remote.ts';
import { seedTeamSkillsClone, writeSkillsReposConfig } from './skills-remote.testkit.ts';

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
