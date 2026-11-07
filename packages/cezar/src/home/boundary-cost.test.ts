import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

vi.hoisted(() => vi.resetModules());
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), realpathSync: vi.fn(fs.realpathSync) };
});
afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('does not enumerate retained versions or increase path checks as history grows', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { saved: true });
  const store = new HomeStore(home);
  const measure = () => {
    vi.mocked(readdirSync).mockClear();
    vi.mocked(realpathSync).mockClear();
    expect(JSON.parse(store.read(home.workspaceConfig))).toEqual({ saved: true });
    return {
      directories: vi.mocked(readdirSync).mock.calls.map(([path]) => String(path)),
      pathChecks: vi.mocked(realpathSync).mock.calls.length,
    };
  };
  const before = measure();
  const versions = join(home.root, '.versions', 'config.json');
  for (let index = 0; index < 2000; index++) {
    writeFileSync(join(versions, index.toString(16).padStart(64, '0')), 'retained version');
  }
  const after = measure();
  expect(after).toEqual(before);
  expect(after.directories.every(path => path === join(home.root, '.locks', 'write.lock'))).toBe(true);
  expect(readFileSync(home.workspaceConfig, 'utf8')).toContain('saved');
});
