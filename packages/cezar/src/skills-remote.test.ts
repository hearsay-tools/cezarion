import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bareDirFor,
  isPinnedSha,
  lastFetchStampPath,
  readLastFetchAt,
  shouldPassiveFetch,
  writeLastFetchAt,
} from './skills-remote.ts';

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
