import { productIdentity } from '../home/identity.ts';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { HomeStore } from '../home/store.ts';
import { migrateLegacyHome } from '../home/migrate.ts';
import { getHomeRecovery } from '../home/recovery.ts';
import { readMigrationRecord } from '../home/migration-record.ts';
import { digest } from '../home/version-log.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { listBackups } from './backups.ts';
import { runBackupCommand } from './backup-cli.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

function fixture() {
  const legacy = Home.sandbox(storeRoot(), { layout: 'legacy' });
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const file = 'remote-settings/4321.json';
  const source = join(legacy.root, file);
  const target = join(home.config, file);
  new HomeStore(legacy).writeJson(source, { enabled: false, liveOnly: 'base' });
  migrateLegacyHome(legacy, home);
  new HomeStore(home).writeJson(target, { enabled: false, liveOnly: 'live' });
  writeFileSync(source, JSON.stringify({ enabled: true, liveOnly: 'base' }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { legacy, home, file, source, target };
}

it.each(['import', 'ignore'])('resolves a legacy grant through host CLI %s', async action => {
  const { home, file, source, target } = fixture();
  const previous = readFileSync(target);
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file, reason: 'legacy-change' }));
  expect(await runBackupCommand([action, file], {}, home)).toBe(0);
  expect(getHomeRecovery(home).files).toEqual([]);
  expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ enabled: action === 'import', liveOnly: 'live' });
  const hash = digest(readFileSync(source));
  expect(readMigrationRecord(home)!.files.find(entry => entry.path === file)?.hash).toBe(hash);
  expect(readFileSync(join(home.config, '.versions', file, hash!))).toEqual(readFileSync(source));
  if (action === 'import') expect(listBackups(file, home).some(backup => readFileSync(backup.path).equals(previous))).toBe(true);
});

it('allows host CLI Ignore for a deleted grant and refuses Import', async () => {
  const { home, file, source, target } = fixture();
  const before = readFileSync(target);
  rmSync(source);
  expect(await runBackupCommand(['import', file], {}, home)).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot be imported'));
  expect(await runBackupCommand(['ignore', file], {}, home)).toBe(0);
  expect(getHomeRecovery(home).files).toEqual([]);
  expect(readFileSync(target)).toEqual(before);
});

it('shows legacy command usage', async () => {
  const { home } = fixture();
  expect(await runBackupCommand(['--help'], {}, home)).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining(`${productIdentity().command} backup import <file>`));
  expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining(`${productIdentity().command} backup ignore <file>`));
});

it.each([['import'], ['ignore', 'remote-settings/4321.json', '--at', '2026-11-07T00:00:00Z'],
  ['import', '../outside.json'], ['ignore', 'remote-settings/4321.json', 'extra']])('rejects invalid legacy CLI arguments %j', async (...argv) => {
  const { home, target } = fixture();
  const before = readFileSync(target);
  expect(await runBackupCommand(argv, {}, home)).toBe(1);
  expect(readFileSync(target)).toEqual(before);
});
