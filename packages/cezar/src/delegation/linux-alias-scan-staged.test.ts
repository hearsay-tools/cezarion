import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ links: 0 }));
vi.mock('node:fs', () => ({
  constants: { O_DIRECTORY: 0x10000 }, openSync: () => 7, closeSync: () => {},
  readlinkSync: (path: string) => path.endsWith('/root') ? '/' : 'mnt',
  statSync: () => ({ dev: 2049n, ino: 1n }),
  lstatSync: () => ({ dev: 2049n, ino: 123n, isDirectory: () => true, isSymbolicLink: () => false }),
}));
vi.mock('../detached-process.ts', () => ({ processStartToken: () => 'boot:101' }));
vi.mock('./linux-alias-identity.ts', () => ({
  linuxDeviceNumber: () => '8:1',
  pinnedAliasIdentity: (_root: string, _path: string, expected: string) => {
    if (expected !== '2049:123') throw Error('root identity changed');
    return { dev: 2049n, ino: 42n };
  },
}));
vi.mock('./linux-proc-evidence.ts', () => ({ readProcEvidence: (path: string) => Buffer.from(path.endsWith('/maps')
  ? '1-2 r--p 0 08:01 42 /alias/file\n' : '2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n') }));
vi.mock('./linux-alias-links.ts', () => ({
  linkAliasCandidates: () => [],
  readAliasLinks: () => ++state.links === 1 ? [] : [{ handle: 'fd/3', path: '/other', dev: '8:1', ino: 5n }],
}));

import { AliasWorkBudget } from './linux-alias-model.ts';
import { scanAliases } from './linux-alias-scan.ts';

it('publishes an authenticated inode before an unstable target snapshot returns unknown', () => {
  state.links = 0;
  const confirmed = vi.fn();
  const result = scanAliases(101, 'boot:101', { roots: ['/owned'], rootIdentities: ['2049:123'],
    owned: [{ path: '/owned', dev: '8:1', fsPath: '/fixture/owned' }], selfMounts: '', selfNamespace: 'mnt',
    budget: new AliasWorkBudget() }, confirmed);
  expect(result.outcome).toBe('unknown');
  expect(confirmed).toHaveBeenCalledWith({ path: '/owned/file', dev: '8:1', ino: 42n });
});

it('publishes the pending marker at translation before inode confirmation', () => {
  state.links = 0;
  const events: string[] = [];
  const attempt = { roots: ['/owned'], rootIdentities: ['2049:123'],
    owned: [{ path: '/owned', dev: '8:1', fsPath: '/fixture/owned' }], selfMounts: '', selfNamespace: 'mnt',
    budget: new AliasWorkBudget() };
  scanAliases(101, 'boot:101', attempt, () => { events.push('confirmed'); }, () => { events.push('pending'); });
  expect(events).toEqual(['pending', 'confirmed']);
  state.links = 0;
  const confirmed = vi.fn();
  expect(() => scanAliases(101, 'boot:101', { ...attempt, budget: new AliasWorkBudget() }, confirmed,
    () => { throw new Error('write failed'); })).toThrow('Cannot persist pending alias scan');
  expect(confirmed).not.toHaveBeenCalled();
});
