import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, linkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { acquireLock, LockHeldError } from '../server-install/state.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

vi.hoisted(() => vi.resetModules());
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, linkSync: vi.fn(fs.linkSync), renameSync: vi.fn(fs.renameSync) };
});
afterEach(() => { vi.mocked(linkSync).mockReset(); vi.mocked(renameSync).mockReset(); cleanStoreRoots(); });

it('keeps an older wx writer lock that appears after inspection and before exclusive publication', async () => {
  const home = Home.sandbox(storeRoot());
  const path = home.serverLock();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const foreign = `${process.ppid}\n`;
  vi.mocked(linkSync).mockImplementationOnce((stage, target) => {
    writeFileSync(path, foreign, { flag: 'wx', mode: 0o600 }); // Deliberate older-binary race.
    fs.linkSync(stage, target);
  });
  expect(() => acquireLock('default', home)).toThrow(LockHeldError);
  expect(readFileSync(path, 'utf8')).toBe(foreign);
  expect(() => readFileSync(join(home.state, '.versions/server.install.lock/PENDING'))).toThrow(/ENOENT/);
});

it('recovers a crash after PENDING and before exclusive publication without an outside flag', () => {
  const home = Home.sandbox(storeRoot());
  const path = home.serverLock();
  vi.mocked(linkSync).mockImplementationOnce(() => { throw new Error('crash before link'); });
  expect(() => acquireLock('default', home)).toThrow('crash before link');
  const store = new HomeStore(home);
  expect(store.outsideWrite(path)).toBeUndefined();
  expect(() => readFileSync(path)).toThrow(/ENOENT/);
  expect(() => readFileSync(join(home.state, '.versions/server.install.lock/PENDING'))).toThrow(/ENOENT/);
});

it('recovers a crash after exclusive publication and before HEAD without an outside flag', async () => {
  const home = Home.sandbox(storeRoot());
  const path = home.serverLock();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  let published = false;
  vi.mocked(linkSync).mockImplementationOnce((stage, target) => { fs.linkSync(stage, target); published = true; });
  vi.mocked(renameSync).mockImplementation((stage, target) => {
    if (published && String(target).endsWith('/HEAD')) throw new Error('crash before HEAD');
    fs.renameSync(stage, target);
  });
  expect(() => acquireLock('default', home)).toThrow('crash before HEAD');
  vi.mocked(renameSync).mockReset();
  const store = new HomeStore(home);
  expect(store.outsideWrite(path)).toBeUndefined();
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  expect(JSON.parse(readFileSync(join(home.state, '.versions/server.install.lock/HEAD'), 'utf8'))).toEqual({ hash });
});
