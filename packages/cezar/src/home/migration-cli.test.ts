import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { homeFileLocation } from './file-location.ts';
import { LEGACY_RECOVERY_COMMAND, runMigrationCommand } from './migration-cli.ts';
import { prepareOperatorHome } from './entry.ts';
import { readInstallMarker } from './install-marker.ts';
import { getHomeRecovery } from './recovery.ts';
import { HomeStore } from './store.ts';
import { json, migrationFixture, rawJson } from './migration.testkit.ts';
import { cleanStoreRoots } from './store.testkit.ts';
import { listBackups } from '../workspace/backups.ts';
import { loadSubcommand } from '../subcommands.ts';
import * as migrationPlan from './migration-plan.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each([
  ['outside-write', 'restore'], ['outside-write', 'accept'],
  ['reset', 'restore'], ['reset', 'accept'],
] as const)('resolves a legacy %s with %s before the next migration', async (reason, action) => {
  const { legacy, target, env } = migrationFixture();
  Home.seed(legacy, legacy.workspaceConfig, { projects: [{ id: 'kept', root: '/kept' }] });
  const pinned = readFileSync(legacy.workspaceConfig);
  if (reason === 'reset') new HomeStore(legacy).writeJson(legacy.workspaceConfig, { projects: [] });
  else rawJson(legacy.workspaceConfig, { projects: [], outside: true });
  const current = readFileSync(legacy.workspaceConfig);
  expect(() => prepareOperatorHome(target, 'serve', env, { legacy }))
    .toThrow(`config.json (${reason}). Run ${LEGACY_RECOVERY_COMMAND}.`);
  expect(existsSync(target.workspaceConfig)).toBe(false);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runMigrationCommand(['--resolve-legacy', 'config.json', action], env, target, legacy)).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({ file: 'config.json', action });
  expect(readFileSync(legacy.workspaceConfig)).toEqual(action === 'restore' ? pinned : current);
  expect(getHomeRecovery(legacy)).toEqual({ files: [] });
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
  expect(existsSync(target.workspaceConfig)).toBe(false);
  if (action === 'restore') {
    expect(listBackups('config.json', legacy).some(backup => readFileSync(backup.path).equals(current))).toBe(true);
  }
  expect(await runMigrationCommand([], env, target, legacy)).toBe(0);
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(readFileSync(target.workspaceConfig)).toEqual(action === 'restore' ? pinned : current);
});

it('the dispatcher resolves the legacy home, not HSQ_HOME or the target factory', async () => {
  const { legacy, target, env } = migrationFixture();
  rawJson(legacy.workspaceConfig, { outside: true });
  const targetFactory = vi.fn(() => target);
  const run = await loadSubcommand('migrate', targetFactory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await run!(['--resolve-legacy', 'config.json', 'restore'], { ...env, CEZ_HOME: legacy.root, HSQ_HOME: target.root })).toBe(0);
  expect(json(legacy.workspaceConfig).saved).toBe('original');
  expect(existsSync(target.workspaceConfig)).toBe(false);
  expect(targetFactory).not.toHaveBeenCalled();
});

it.each(['restore', 'accept'])('resolves a backup-derived reset with %s after a report-only migration refusal', async action => {
  const { legacy, target, env } = migrationFixture();
  rawJson(`${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
  const pinned = readFileSync(`${legacy.workspaceConfig}.bak`);
  const current = readFileSync(legacy.workspaceConfig);
  expect(() => prepareOperatorHome(target, 'serve', env, { legacy })).toThrow('config.json (reset)');
  expect(existsSync(join(legacy.config, '.versions/config.json/RESET'))).toBe(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runMigrationCommand(['--resolve-legacy', 'config.json', action], env, target, legacy)).toBe(0);
  expect(readFileSync(legacy.workspaceConfig)).toEqual(action === 'restore' ? pinned : current);
  expect(getHomeRecovery(legacy)).toEqual({ files: [] });
  expect(await runMigrationCommand([], env, target, legacy)).toBe(0);
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it.each(['agent-accounts.json', 'remote-settings/4321.json'])
('restores the pinned legacy %s through HomeStore and keeps a backup of the outside bytes', async file => {
  const { legacy, target, env } = migrationFixture();
  const { path } = homeFileLocation(legacy, file);
  Home.seed(legacy, path, { saved: true });
  rawJson(path, { outside: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runMigrationCommand(['--resolve-legacy', file, 'restore'], env, target, legacy)).toBe(0);
  expect(json(path)).toEqual({ saved: true });
  expect(listBackups(file, legacy).some(backup => json(backup.path).outside === true)).toBe(true);
});

it('restores a pinned legacy install lock without making rotating lock backups', async () => {
  const { legacy, target, env } = migrationFixture();
  const file = 'server-instances/named.install.lock';
  const { path } = homeFileLocation(legacy, file);
  Home.seed(legacy, path, { saved: true });
  rawJson(path, { outside: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runMigrationCommand(['--resolve-legacy', file, 'restore'], env, target, legacy)).toBe(0);
  expect(json(path)).toEqual({ saved: true });
  // Locks hold no registry data; recovery uses the version log without a rotating snapshot.
  expect(listBackups(file, legacy)).toEqual([]);
});

it('repeated recovery actions do not fall back to unrelated backups or migrate the home', async () => {
  const { legacy, target, env } = migrationFixture();
  const pinned = readFileSync(legacy.workspaceConfig);
  rawJson(legacy.workspaceConfig, { outside: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const action of ['restore', 'restore', 'accept']) {
    expect(await runMigrationCommand(['--resolve-legacy', 'config.json', action], env, target, legacy)).toBe(0);
    expect(readFileSync(legacy.workspaceConfig)).toEqual(pinned);
  }
  expect(existsSync(target.workspaceConfig)).toBe(false);
});

it('reports unavailable pinned recovery on stderr without replacing the outside file', async () => {
  const { legacy, target, env } = migrationFixture();
  rawJson(legacy.workspaceConfig, { outside: true });
  new HomeStore(legacy).recovery(legacy.workspaceConfig);
  const journal = join(legacy.config, '.versions/config.json');
  const head = json(join(journal, 'HEAD'));
  rmSync(join(journal, head.hash));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runMigrationCommand(['--resolve-legacy', 'config.json', 'restore'], env, target, legacy)).toBe(1);
  expect(output).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('migration failed'));
  expect(json(legacy.workspaceConfig)).toEqual({ outside: true });
});

it.each([
  ['--resolve-legacy'], ['--resolve-legacy', 'config.json'],
  ['--resolve-legacy', 'config.json', 'ignore'], ['--resolve-legacy', 'config.json', 'accept', 'extra'],
  ['--resolve-legacy', 'config.json', 'restore', '--dry-run'],
  ['--resolve-legacy', '../config.json', 'restore'], ['--resolve-legacy', '/config.json', 'accept'],
  ['--resolve-legacy', 'install.json', 'accept'], ['accept'],
])('rejects invalid recovery arguments %j before creating an empty home', async (...argv) => {
  const { directory } = migrationFixture();
  const root = join(directory, 'untouched');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runMigrationCommand(argv, { CEZ_HOME: root })).toBe(1);
  expect(output).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('migration failed'));
  expect(existsSync(root)).toBe(false);
});

it('lists recovery help without creating a home', async () => {
  const { directory } = migrationFixture();
  const root = join(directory, 'untouched');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runMigrationCommand(['--help'], { CEZ_HOME: root })).toBe(0);
  expect(output).toHaveBeenCalledWith(expect.stringContaining(LEGACY_RECOVERY_COMMAND));
  expect(existsSync(root)).toBe(false);
});

it('keeps migration error text literal while formatting the invoked command prefix', async () => {
  const { legacy, target, env } = migrationFixture();
  const argv = [...process.argv];
  const message = 'unsupported file /cez; run `cez` or npx cezarion to inspect /hsq';
  vi.spyOn(migrationPlan, 'planLegacyMigration').mockImplementation(() => { throw new Error(message); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv[1] = '/bin/hsq';
  try {
    expect(await runMigrationCommand(['--dry-run'], env, target, legacy)).toBe(1);
    expect(error).toHaveBeenCalledExactlyOnceWith(`[hsq] migration failed: ${message}`);
    expect(output).not.toHaveBeenCalled();
  } finally { process.argv = argv; }
});
