import { createHash } from 'node:crypto';
import { homeFileLocation } from '../home/file-location.ts';
import { mkdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { HomeStore } from '../home/store.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { backupBeforeWrite, isBackupFile, listBackups } from './backups.ts';
import { restoreBackup, runBackupCommand } from './backup-cli.ts';

afterEach(() => { cleanStoreRoots(); vi.restoreAllMocks(); });

const files = ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json',
  'remote-settings/4321.json', 'server-instances/other.json'] as const;
const locks = ['server.install.lock', 'server-instances/other.install.lock'] as const;

it.each(files)('backs up changed and removed %s under its home-relative key', file => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  const path = homeFileLocation(home, file).path;
  const before = Buffer.from('original bytes\n');
  const next = Buffer.from('next bytes\n');
  store.replace(path, before);
  store.replace(path, before);
  expect(listBackups(file, home)).toEqual([]);
  store.replace(path, next);
  const [snapshot] = listBackups(file, home);
  expect(snapshot?.path.startsWith(join(home.backups, file))).toBe(true);
  expect(readFileSync(snapshot!.path)).toEqual(before);
  store.replace(path, null);
  expect(readFileSync(listBackups(file, home)[0]!.path)).toEqual(next);
  expect(() => readFileSync(path)).toThrow(/ENOENT/);
  if (process.platform !== 'win32') expect(statSync(snapshot!.path).mode & 0o777).toBe(0o600);
});

it.each(locks)('keeps no rotating snapshot of %s, which holds only an installer pid', file => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  const path = homeFileLocation(home, file).path;
  store.replace(path, Buffer.from('12345\n'));
  store.replace(path, Buffer.from('67890\n'));
  store.replace(path, null);
  expect(listBackups(file, home)).toEqual([]);
  expect(() => statSync(join(home.backups, file))).toThrow(/ENOENT/);
});

it.each(locks)('still lists and restores an older snapshot of %s byte for byte', async file => {
  const home = Home.sandbox(storeRoot());
  const previous = Buffer.from('12345\n');
  const sha = createHash('sha256').update(previous).digest('hex').slice(0, 8);
  mkdirSync(join(home.backups, file), { recursive: true });
  writeFileSync(join(home.backups, file, `2026-11-01T10-00-00.000Z-${sha}.json`), previous); // A snapshot an older version wrote.
  new HomeStore(home).replace(homeFileLocation(home, file).path, Buffer.from('current'));
  expect(listBackups(undefined, home).map(entry => entry.file)).toContain(file);
  await restoreBackup(file, undefined, home);
  expect(readFileSync(homeFileLocation(home, file).path)).toEqual(previous);
});

it('discovers nested backups after the live files and their directories are removed', () => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  for (const file of ['remote-settings/4321.json', 'server-instances/other.json'] as const) {
    store.writeJson(homeFileLocation(home, file).path, { first: true });
    store.writeJson(homeFileLocation(home, file).path, { second: true });
  }
  rmSync(home.remoteSettings, { recursive: true }); // Deliberate outside deletion; listing must stay read-only.
  rmSync(home.serverInstances, { recursive: true });
  expect(listBackups(undefined, home).map(entry => entry.file).sort()).toEqual([
    'remote-settings/4321.json', 'server-instances/other.json',
  ]);
});

it.each(['../config.json', '/config.json', 'remote-settings/../config.json', 'remote-settings/a/b.json', 'install.json', 'backups/config.json'])('refuses non-registry backup key %s', async file => {
  const home = Home.sandbox(storeRoot());
  expect(isBackupFile(file)).toBe(false);
  expect(() => listBackups(file, home)).toThrow(/Unsupported backup file/);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', file], process.env, home)).toBe(1);
});

it('uses the Home backup root for nested files and reads the old named-instance location', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'legacy' });
  const file = 'server-instances/config.json';
  const path = homeFileLocation(home, file).path;
  const store = new HomeStore(home);
  store.writeJson(path, { first: true });
  store.writeJson(path, { second: true });
  const [entry] = listBackups(file, home);
  expect(entry?.path.startsWith(join(home.backups, file))).toBe(true);
  const legacy = join(home.root, 'server-instances', 'backups', 'config.json');
  mkdirSync(dirname(legacy), { recursive: true });
  renameSync(join(home.backups, file), legacy);
  expect(listBackups(file, home)[0]?.path.startsWith(legacy)).toBe(true);
  expect(listBackups(undefined, home).some(item => item.file === file)).toBe(true);
  const before = listBackups(file, home).map(entry => ({ path: entry.path, bytes: readFileSync(entry.path) }));
  store.writeJson(path, { third: true });
  for (const entry of before) expect(readFileSync(entry.path)).toEqual(entry.bytes);
  expect(listBackups(file, home).filter(entry => entry.path.startsWith(legacy)).map(entry => entry.path)).toEqual(before.map(entry => entry.path));
  expect(listBackups(file, home)[0]?.path.startsWith(join(home.backups, file))).toBe(true);
});

it('lists config.json.bak first and uses it for an unflagged restore', async () => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  store.writeJson(home.workspaceConfig, { projects: [], extra: 'older' });
  store.writeJson(home.workspaceConfig, { projects: [], extra: 'live' });
  store.writeJson(`${home.workspaceConfig}.bak`, { projects: [], extra: 'snapshot' });
  expect(listBackups('config.json', home)[0]?.path).toBe(`${home.workspaceConfig}.bak`);
  await restoreBackup('config.json', undefined, home);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8')).extra).toBe('snapshot');
});

it.each(['remote-settings/4321.json', 'server-instances/other.json'])('restores %s byte for byte through the CLI helper', async file => {
  const home = Home.sandbox(storeRoot());
  const path = homeFileLocation(home, file).path;
  const store = new HomeStore(home);
  const previous = Buffer.from('{ "unknown": "preserved" }');
  store.replace(path, previous);
  store.replace(path, Buffer.from('current'));
  await restoreBackup(file, undefined, home);
  expect(readFileSync(path)).toEqual(previous);
});

it('keeps backup failures auxiliary for nested file writes', () => {
  const home = Home.sandbox(storeRoot());
  const path = join(home.remoteSettings, '4321.json');
  const store = new HomeStore(home);
  store.writeJson(path, { first: true });
  mkdirSync(home.state, { recursive: true });
  writeFileSync(home.backups, 'unavailable'); // Deliberate obstruction of auxiliary storage.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  store.writeJson(path, { next: true });
  store.writeJson(path, { last: true });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ last: true });
  expect(warn).toHaveBeenCalledTimes(1);
});

it('keeps the legacy direct backup helper usable for a root file', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { first: true });
  backupBeforeWrite(home.workspaceUiState, { next: true });
  expect(listBackups('ui-state.json', home)).toHaveLength(1);
});
