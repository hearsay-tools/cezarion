import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ links: ['cwd', 'fd/7'], changed: false, closed: [] as number[], next: 10 }));
vi.mock('node:fs', () => ({
  opendirSync: () => { let n = 0; return { readSync: () => n++ === 0 ? { name: '7' } : null, closeSync: () => {} }; },
  readlinkSync: (path: string) => path.endsWith('/cwd') ? '/alias' : '/alias/file',
  openSync: () => state.next++,
  fstatSync: (fd: number) => ({ dev: 0x801n, ino: state.changed && fd % 2 === 1 ? 99n : 42n, mode: 0o100600n }),
  closeSync: (fd: number) => { state.closed.push(fd); },
}));

import { AliasWorkBudget, parseAliasMounts } from './linux-alias-model.ts';
import { linkAliasCandidates, readAliasLinks } from './linux-alias-links.ts';

it('pins link identities and closes both handles when identity changes', () => {
  state.next = 10; state.closed = []; state.changed = false;
  expect(readAliasLinks(5, new AliasWorkBudget())).toEqual([
    { handle: 'cwd', path: '/alias', dev: '8:1', ino: 42n },
    { handle: 'fd/7', path: '/alias/file', dev: '8:1', ino: 42n },
  ]);
  expect(state.closed).toEqual([11, 10, 13, 12]);
  state.next = 10; state.closed = []; state.changed = true;
  expect(() => readAliasLinks(5, new AliasWorkBudget())).toThrow('changed');
  expect(state.closed).toEqual([11, 10]);
});

it('translates file and cwd identities without treating unrelated descriptors as authority', () => {
  const mounts = parseAliasMounts('2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n');
  const roots = [{ path: '/fixture/owned', dev: '8:1', fsPath: '/fixture/owned' }];
  const links = [
    { handle: 'cwd', path: '/alias', dev: '8:1', ino: 11n },
    { handle: 'fd/7', path: '/alias/file', dev: '8:1', ino: 12n },
    { handle: 'fd/8', path: 'pipe:[9]', dev: '0:1', ino: 9n },
  ];
  expect(linkAliasCandidates(links, '/', mounts, roots, new AliasWorkBudget()).map(item => item.candidate.path))
    .toEqual(['/fixture/owned', '/fixture/owned/file']);
  expect(() => linkAliasCandidates(links, '/', mounts, roots, new AliasWorkBudget(2))).toThrow('work exceeds');
});
