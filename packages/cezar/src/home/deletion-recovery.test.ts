import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeOutsideWriteError, HomeStore } from './store.ts';
import { getHomeRecovery, restoreHomeRecovery } from './recovery.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

const project = (id: string) => ({ id, root: `/${id}`, name: id, addedAt: '', lastOpenedAt: '', source: 'local' as const });

async function registry() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const home = Home.sandbox(storeRoot());
  await mergeWriteWorkspaceConfig(config => { config.projects.push(project('saved')); }, home);
  return home;
}

it('self-heals a deleted registry from its pinned backup, merges and clears the incident', async () => {
  const home = await registry();
  expect(readFileSync(`${home.workspaceConfig}.bak`)).toEqual(readFileSync(home.workspaceConfig));
  rmSync(home.workspaceConfig); // Outside deletion carries no content into the merge.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'outside-write' }));
  await mergeWriteWorkspaceConfig(config => { config.projects.push(project('new')); }, home);
  const saved = JSON.parse(readFileSync(home.workspaceConfig, 'utf8'));
  expect(saved.projects.map((entry: { id: string }) => entry.id)).toEqual(['saved', 'new']);
  expect(readFileSync(`${home.workspaceConfig}.bak`)).toEqual(readFileSync(home.workspaceConfig));
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it('refuses a deletion when the recovered backup differs from the pinned base', async () => {
  const home = await registry();
  const original = readFileSync(home.workspaceConfig);
  new HomeStore(home).writeJson(`${home.workspaceConfig}.bak`, { projects: [project('different')] });
  rmSync(home.workspaceConfig); // The loader recovers a backup, but it is not the pinned registry.
  await expect(mergeWriteWorkspaceConfig(config => { config.projects.push(project('new')); }, home)).rejects.toThrow(HomeOutsideWriteError);
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'outside-write' }));
  await restoreHomeRecovery(home, 'config.json');
  expect(readFileSync(home.workspaceConfig)).toEqual(original);
});

it.each(['valid', 'corrupt'] as const)('still refuses outside %s content despite an available pinned backup', async kind => {
  const home = await registry();
  const original = readFileSync(home.workspaceConfig);
  const outside = kind === 'valid' ? JSON.stringify({ projects: [project('outside')] }) : '{broken';
  writeFileSync(home.workspaceConfig, outside); // Present outside bytes must never become a merge base.
  await expect(mergeWriteWorkspaceConfig(config => { config.projects.push(project('new')); }, home)).rejects.toThrow(HomeOutsideWriteError);
  expect(readFileSync(home.workspaceConfig, 'utf8')).toBe(outside);
  await restoreHomeRecovery(home, 'config.json');
  expect(readFileSync(home.workspaceConfig)).toEqual(original);
});

it.each(['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json',
  'server.install.lock', 'remote-settings/4321.json', 'server-instances/named.json', 'server-instances/named.install.lock'])(
  'keeps deletion enforcement for %s without a loader-proven recovery base', file => {
    const home = Home.sandbox(storeRoot());
    const path = join(home.root, file);
    Home.seed(home, path, { original: true });
    rmSync(path); // Every family still refuses a normal save over outside deletion.
    expect(() => new HomeStore(home).writeJson(path, { next: true })).toThrow(HomeOutsideWriteError);
    expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file, reason: 'outside-write' }));
  });
