import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import * as files from './private-files.ts';
import { cleanStoreRoots, storeChild, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['remote-settings', 'server-instances', '.versions', '.locks'])('refuses a %s directory that points into another live home before lock mutation', name => {
  const home = Home.sandbox(storeRoot());
  const victim = storeRoot();
  storeChild(victim, 'prepare', 'run');
  storeChild(victim, 'write', '{"keep":"live"}');
  const path = join(home.root, name);
  rmSync(path, { force: true, recursive: true });
  symlinkSync(victim, path, 'dir');
  const directory = vi.spyOn(files, 'privateDirectory');
  const target = name === 'remote-settings' || name === 'server-instances' ? join(path, 'config.json') : home.workspaceConfig;
  expect(() => new HomeStore(home).writeJson(target, {})).toThrow(/escapes canonical HomeStore root/);
  expect(directory).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(victim, 'config.json'), 'utf8'))).toEqual({ keep: 'live' });
});

it('refuses a journal record symlink before taking the write lock', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { saved: true });
  const victim = storeRoot();
  storeChild(victim, 'prepare', 'run');
  const record = join(home.root, '.versions/config.json/HEAD');
  rmSync(record);
  symlinkSync(join(victim, 'install.json'), record);
  const directory = vi.spyOn(files, 'privateDirectory');
  expect(() => new HomeStore(home).writeJson(home.workspaceConfig, {})).toThrow(/escapes canonical HomeStore root/);
  expect(directory).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ saved: true });
});
