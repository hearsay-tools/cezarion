import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

vi.mock('node:child_process', async original => {
  const child = await original<typeof import('node:child_process')>();
  return { ...child, spawnSync: vi.fn(child.spawnSync), execFileSync: vi.fn(child.execFileSync) };
});
afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['darwin', 'win32'] as const)('does not spawn during peer-free reads on %s after preparing its process identity', async platform => {
  vi.resetModules();
  const { Home } = await import('./home.ts');
  const { HomeStore } = await import('./store.ts');
  const hostPlatform = process.platform;
  // Emulate Windows ACL writes; this test only measures peer-free reads.
  vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
  vi.mocked(spawnSync).mockClear();
  vi.mocked(execFileSync).mockClear();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    const home = Home.sandbox(storeRoot());
    Home.seed(home, home.workspaceConfig, { saved: true });
    expect(spawnSync).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0);
    const secondRoot = storeRoot();
    Home.sandbox(secondRoot); // Prepare its Windows ACL before measuring reads.
    vi.mocked(spawnSync).mockClear();
    vi.mocked(execFileSync).mockClear();
    const store = new HomeStore(home);
    expect(JSON.parse(store.read(home.workspaceConfig))).toEqual({ saved: true });
    expect(JSON.parse(store.read(home.workspaceConfig))).toEqual({ saved: true });
    Home.sandbox(secondRoot); // A second root reuses the same process identity.
    expect(spawnSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true }); }
});
