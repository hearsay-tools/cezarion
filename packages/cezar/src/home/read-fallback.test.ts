import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { VersionLog } from './version-log.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { withHomeLock } from './write-lock.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

vi.hoisted(() => vi.resetModules());
vi.mock('./write-lock.ts', async original => {
  const module = await original<typeof import('./write-lock.ts')>();
  return { ...module, withHomeLock: vi.fn(module.withHomeLock) };
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(withHomeLock).mockReset(); cleanStoreRoots(); });

it.each(['ENOSPC', 'journal error'])('keeps projects and saved limits visible after auxiliary %s', async failure => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { projects: [{ id: 'keep', root: '/saved/repo' }], resources: { maxParallel: 9 } });
  let injected = false;
  if (failure === 'ENOSPC') vi.mocked(withHomeLock).mockImplementationOnce(() => { injected = true; throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
  else vi.spyOn(VersionLog.prototype, 'inspect').mockImplementationOnce(() => { injected = true; throw new Error('invalid auxiliary record'); });
  const config = await loadWorkspaceConfig(home.workspaceConfig);
  expect(injected).toBe(true);
  expect(config.projects.map(project => project.id)).toEqual(['keep']);
  expect(config.resources.maxParallel).toBe(9);
});

it('still reports failure when the live file itself cannot be read', () => {
  const home = Home.sandbox(storeRoot());
  vi.mocked(withHomeLock).mockImplementationOnce(() => { throw new Error('auxiliary failure'); });
  expect(() => new HomeStore(home).read(join(home.root, 'config.json'))).toThrow(/ENOENT/);
});
