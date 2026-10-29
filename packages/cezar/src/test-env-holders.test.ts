import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { leaseGroupLive, leaseIdentity, reclaimTestEnvHolders } from './detached-process.ts';

afterEach(() => vi.unstubAllGlobals());
it.each([
  { name: 'dead process without a group', identity: { dead: true }, group: undefined, keep: false, pgid: null },
  { name: 'dead process with an absent group', identity: { dead: true }, group: false, keep: false, pgid: 42 },
  { name: 'dead process with surviving group', identity: { dead: true }, group: true, keep: true, pgid: 42 },
  { name: 'dead process with unknown group', identity: { dead: true }, group: undefined, keep: true, pgid: 42 },
  { name: 'reused process with absent group', identity: { start: 'new' }, group: false, keep: false, pgid: 42 },
  { name: 'reused process with live group', identity: { start: 'new' }, group: true, keep: true, pgid: 42 },
  { name: 'unknown process', identity: {}, group: false, keep: true, pgid: null },
  { name: 'live process', identity: { start: 'old' }, group: false, keep: true, pgid: null },
])('reclaims conservatively: $name', ({ identity, group, keep, pgid }) => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT, pid INTEGER, start TEXT, pgid INTEGER)');
    db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, ?)').run('holder', 'token', 42, 'old', pgid);
    db.exec('BEGIN IMMEDIATE');
    expect(reclaimTestEnvHolders(db, () => identity, () => group)).toHaveLength(keep ? 1 : 0);
    db.exec('COMMIT');
    expect(db.prepare('SELECT * FROM holders').all()).toHaveLength(keep ? 1 : 0);
  } finally { db.close(); }
});
it.each([['true', true], ['false', false], ['unknown', undefined], [undefined, undefined]] as const)(
  'Windows job probe %s is %s', (result, expected) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    expect(leaseGroupLive('job', () => result)).toBe(expected);
  },
);
it.each([['gone', { dead: true }], ['123', { start: '123' }], [undefined, {}]] as const)(
  'Windows identity probe preserves uncertainty: %s', (result, expected) => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
    expect(leaseIdentity(process.pid, 1000, () => result)).toEqual(expected);
  },
);
