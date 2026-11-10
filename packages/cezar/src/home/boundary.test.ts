import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { homePathLocation } from './file-location.ts';
import * as files from './private-files.ts';
import * as boundary from './boundary.ts';
import { cleanStoreRoots, storeChild, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['remote-settings', 'server-instances', '.versions', '.locks'])('refuses a %s directory that points into another live home before lock mutation', name => {
  const home = Home.sandbox(storeRoot());
  const victim = storeRoot();
  storeChild(victim, 'prepare', 'run');
  storeChild(victim, 'write', '{"keep":"live"}');
  const path = join(name === 'server-instances' ? home.state : home.config, name);
  rmSync(path, { force: true, recursive: true });
  mkdirSync(dirname(path), { recursive: true });
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

it.each(['backups', 'backups/config.json', 'backups/agent-accounts.json', 'backups/server-instances/config.json'])('skips escaped %s before the first lock mutation and keeps saves working', name => {
  const home = Home.sandbox(storeRoot());
  const target = name.includes('server-instances') ? home.serverState('config')
    : name.endsWith('agent-accounts.json') ? home.agentAccounts : home.workspaceConfig;
  Home.seed(home, target, { saved: true });
  const victim = storeRoot();
  storeChild(victim, 'prepare', 'run');
  storeChild(victim, 'write', '{"keep":"old"}');
  storeChild(victim, 'write', '{"keep":"live"}');
  const victimDirectory = join(victim, 'backups', name === 'backups' ? '' : target.endsWith('agent-accounts.json') ? 'agent-accounts.json' : 'config.json');
  mkdirSync(victimDirectory, { recursive: true });
  const before = readdirSync(victim, { recursive: true }).sort();
  const path = join(home.backups, name === 'backups' ? '' : name.slice('backups/'.length));
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { recursive: true, force: true });
  symlinkSync(victimDirectory, path, 'dir');
  const preflight = vi.spyOn(boundary, 'assertHomePaths');
  const directory = vi.spyOn(files, 'privateDirectory');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new HomeStore(home);
  store.writeJson(target, { changed: 1 });
  store.writeJson(target, { changed: 2 });
  const backupPath = join(home.backups, homePathLocation(home, target).file);
  const check = preflight.mock.calls.findIndex(([, paths]) => paths.includes(backupPath));
  expect(check).toBeGreaterThanOrEqual(0);
  expect(preflight.mock.invocationCallOrder[check]).toBeLessThan(directory.mock.invocationCallOrder[0]!);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(String(warning.mock.calls[0]?.[0])).toContain('escapes canonical HomeStore root');
  expect(readdirSync(victim, { recursive: true }).sort()).toEqual(before);
  expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ changed: 2 });
});

it('skips a dangling backup directory and warns once while saving the primary', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { saved: true });
  mkdirSync(dirname(home.backups), { recursive: true });
  symlinkSync(join(storeRoot(), 'missing'), home.backups, 'dir');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = new HomeStore(home);
  store.writeJson(home.workspaceConfig, { changed: 1 });
  store.writeJson(home.workspaceConfig, { changed: 2 });
  expect(warning).toHaveBeenCalledTimes(1);
  expect(String(warning.mock.calls[0]?.[0])).toContain('Unresolved HomeStore symlink');
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ changed: 2 });
});

it('prunes only local snapshot links and leaves their live-home target intact', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { saved: true });
  const victim = storeRoot();
  storeChild(victim, 'prepare', 'run');
  storeChild(victim, 'write', '{"keep":"live"}');
  const target = join(victim, 'config.json');
  const before = readFileSync(target);
  const hash = createHash('sha256').update(before).digest('hex').slice(0, 8);
  const directory = join(home.backups, 'config.json');
  mkdirSync(directory, { recursive: true });
  const snapshots = Array.from({ length: 22 }, (_, index) => {
    const stamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString().replaceAll(':', '-');
    const name = `${stamp}-${hash}.json`;
    symlinkSync(target, join(directory, name));
    return name;
  });
  new HomeStore(home).writeJson(home.workspaceConfig, { next: true });
  expect(readdirSync(directory)).not.toContain(snapshots[0]);
  expect(readFileSync(target)).toEqual(before);
});
