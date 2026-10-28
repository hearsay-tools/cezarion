import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const boot = 'deffb118-419a-4586-af9e-748667bd30c8';
  const rootMount = '1 0 8:1 / / rw - ext4 /dev/root rw\n';
  const mounts = Array.from({ length: 30 }, (_, i) => `${i + 2} 1 8:1 /other /mount${i} rw - ext4 /dev/root rw`).join('\n') + '\n';
  return { boot, rootMount, mounts, nextFd: 10, files: new Map<number, { data: Buffer; offset: number }>(), removed: [] as string[] };
});
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const info = { dev: 2049n, ino: 123n, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false };
  return { ...actual,
    lstatSync: () => info, statSync: () => info, realpathSync: (path: string) => path,
    readlinkSync: (path: string) => path.endsWith('/ns/mnt') ? 'mnt' : path.endsWith('/root') ? '/' : '/unrelated',
    readdirSync: () => [],
    opendirSync: (path: string) => {
      const names = path === '/proc' ? ['101'] : path === `/proc/${process.pid}/task` ? [String(process.pid)] : path === '/proc/101/task' ? ['101'] : [];
      let index = 0;
      return { readSync: () => index < names.length ? { name: names[index++] } : null, closeSync: () => {} };
    },
    openSync: (path: string) => {
      if (path === '/proc/101') return 7;
      const contents = path.endsWith('/mountinfo') ? (path.includes('/fd/7/') ? fixture.mounts : fixture.rootMount)
        : path.endsWith('/maps') ? '1-2 r--p 0 08:01 42 /unrelated/file\n' : '';
      const fd = fixture.nextFd++; fixture.files.set(fd, { data: Buffer.from(contents), offset: 0 }); return fd;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
      const file = fixture.files.get(fd)!; const count = Math.min(length, file.data.length - file.offset);
      file.data.copy(buffer, offset, file.offset, file.offset + count); file.offset += count; return count;
    },
    closeSync: (fd: number) => { fixture.files.delete(fd); },
    rmSync: (path: string) => { fixture.removed.push(path); },
  };
});
vi.mock('../detached-process.ts', async original => ({ ...await original<typeof import('../detached-process.ts')>(),
  linuxBootId: () => fixture.boot, processStartToken: () => `${fixture.boot}:100` }));

import { AliasBudgetExceeded, AliasWorkBudget } from './linux-alias-model.ts';
import { reapDestroyHolders } from './destroy-holders.ts';
import type { WorkerAliasRetention, WorkerExecution } from '../runs/worker-execution.ts';

it('keeps the prior pending record when real index preprocessing exhausts in the reaper', async () => {
  const generation = 'b12898b9-8bf7-4c24-85e3-5ecf2b4d469e', resourceId = 'ff04f7e5-25b8-4f57-9050-895fe33fc6e6';
  let retention: WorkerAliasRetention | undefined = { generation, resourceId, bootId: fixture.boot,
    roots: [{ path: '/owned', identity: { dev: '8:1', ino: '123' } }], processes: [], pending: [{ pid: 101, start: '100' }] };
  const execution: WorkerExecution = { generation, phase: 'complete', aliasRetention: retention };
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
  class TracedBudget extends AliasWorkBudget {
    exhaustedAt = '';
    override spend(amount = 1) { try { super.spend(amount); } catch (error) { this.exhaustedAt ||= new Error().stack ?? ''; throw error; } }
  }
  const budget = new TracedBudget(100);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId, read: () => execution, write: value => { retention = value; } }, budget)).rejects.toBeInstanceOf(AliasBudgetExceeded);
    expect(budget.exhaustedAt).toContain('indexAliasMounts');
    expect(signal).not.toHaveBeenCalled(); expect(fixture.removed).toEqual([]);
    expect(retention?.pending).toEqual([{ pid: 101, start: '100' }]);
  } finally { signal.mockRestore(); }
});
