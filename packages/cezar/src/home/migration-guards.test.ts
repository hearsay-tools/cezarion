import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeStore } from './store.ts';
import { migrateLegacyHome } from './migrate.ts';
import { prepareOperatorHome } from './entry.ts';
import { prepareMigrationHome } from './migration-boot.ts';
import { readInstallMarker } from './install-marker.ts';
import { readMigrationRecord } from './migration-record.ts';
import { runMigrationCommand } from './migration-cli.ts';
import { loadSubcommand, SUBCOMMAND_NAMES } from '../subcommands.ts';
import { migrationFixture, rawJson, json } from './migration.testkit.ts';
import { cleanStoreRoots } from './store.testkit.ts';
import { REBRAND_SWITCH } from './switch.ts';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync), readFileSync: vi.fn(fs.readFileSync) };
});
afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('the unconditional HomeStore check refuses .migrating before waiting, and leaves reads free of migration probes', () => {
  const { legacy } = migrationFixture();
  const guard = join(legacy.root, '.migrating');
  rawJson(guard, { pid: process.pid });
  const store = new HomeStore(legacy);
  expect(() => store.writeJson(legacy.workspaceConfig, {})).toThrow(/migration in progress/);
  vi.mocked(lstatSync).mockClear(); vi.mocked(readFileSync).mockClear();
  expect(store.read(legacy.workspaceConfig)).toContain('original');
  expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === guard)).toHaveLength(0);
  expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === guard)).toHaveLength(0);
});

it('a write without .migrating uses one migration stat at most and preserves the normal write', () => {
  const { legacy } = migrationFixture();
  vi.mocked(lstatSync).mockClear();
  new HomeStore(legacy).writeJson(legacy.workspaceConfig, { saved: true });
  expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === join(legacy.root, '.migrating'))).toHaveLength(1);
  expect(json(legacy.workspaceConfig).saved).toBe(true);
});

it('the HomeStore check repeats inside write.lock when .migrating appears after its fast check', () => {
  const { legacy } = migrationFixture();
  const guard = join(legacy.root, '.migrating');
  const original = vi.mocked(lstatSync).getMockImplementation()!;
  vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof lstatSync>) => {
    try { return original(...args); } catch (error) {
      if (args[0] === guard) rawJson(guard, { pid: process.pid });
      throw error;
    }
  });
  expect(() => new HomeStore(legacy).writeJson(legacy.workspaceConfig, { saved: 'must not commit' })).toThrow(/migration in progress/);
  expect(json(legacy.workspaceConfig).saved).toBe('original');
});

it('nested writes reuse the fast migration stat and still check each locked mutation', () => {
  const { legacy } = migrationFixture();
  const store = new HomeStore(legacy);
  vi.mocked(lstatSync).mockClear();
  store.transaction(() => {
    store.writeJson(legacy.workspaceConfig, { saved: 'first' });
    store.writeJson(legacy.workspaceConfig, { saved: 'second' });
  });
  expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === join(legacy.root, '.migrating'))).toHaveLength(1);
  expect(json(legacy.workspaceConfig).saved).toBe('second');
});

it('with the default switch off, boot leaves legacy unchanged, migrates nothing, and does not register migrate', async () => {
  const { legacy, target, env } = migrationFixture();
  expect(REBRAND_SWITCH).toBe(false);
  const bytes = readFileSync(legacy.workspaceConfig);
  expect(prepareMigrationHome(target, env, { legacy })).toBe(false);
  prepareOperatorHome(legacy, 'serve', env);
  expect(readFileSync(legacy.workspaceConfig)).toEqual(bytes);
  expect(readMigrationRecord(target)).toBeUndefined();
  expect(existsSync(target.workspaceConfig)).toBe(false);
  expect(SUBCOMMAND_NAMES).not.toContain('migrate');
  expect(await loadSubcommand('migrate')).toBeUndefined();
  expect(await loadSubcommand('migrate', () => target, true)).toBeTypeOf('function');
});

it('a cockpit refuses to start on .migrating before registry preparation', () => {
  const { legacy, target, env } = migrationFixture();
  rawJson(join(legacy.root, '.migrating'), { pid: process.pid });
  expect(() => prepareOperatorHome(target, 'serve', env, { enabled: true, legacy })).toThrow(/migration in progress/);
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
  expect(existsSync(target.workspaceConfig)).toBe(false);
});

it('boot refuses a migration error and never seeds a fresh home over nonempty legacy data', () => {
  const { legacy, target, env } = migrationFixture();
  rawJson(legacy.workspaceConfig, { outside: true });
  expect(() => prepareOperatorHome(target, 'serve', env, { enabled: true, legacy })).toThrow(/Resolve home recovery/);
  expect(existsSync(target.workspaceConfig)).toBe(false);
});

it('boot serves a pending home read-only without running migration or seeding missing HEAD records', () => {
  const { legacy, target, env } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  const head = join(target.config, '.versions/config.json/HEAD');
  rmSync(head);
  rawJson(legacy.workspaceConfig, { changedWhilePending: true });
  prepareOperatorHome(target, 'serve', env, { enabled: true, legacy });
  expect(new HomeStore(target).outsideWrite(target.workspaceConfig)).toBeUndefined();
  expect(existsSync(head)).toBe(false);
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(() => new HomeStore(target).writeJson(target.workspaceConfig, {})).toThrow(/pending migration/);
});

it('cez migrate --dry-run lists the shared plan without restoring .bak or writing markers or copies', async () => {
  const { legacy, target, env } = migrationFixture();
  rmSync(legacy.workspaceConfig);
  rawJson(`${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
  rmSync(join(target.config, 'install.json'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runMigrationCommand(['--dry-run'], env, target, legacy)).toBe(0);
  const result = JSON.parse(String(output.mock.calls[0]![0]));
  expect(result).toMatchObject({ dryRun: true, plan: { managedInstall: false, accounts: [] } });
  expect(result.plan.files.some((file: { path: string }) => file.path === 'config.json.bak')).toBe(true);
  expect(existsSync(legacy.workspaceConfig)).toBe(false);
  expect(readInstallMarker(target.config)).toBeUndefined();
  expect(readMigrationRecord(target)).toBeUndefined();
});

it('the migration command provides help without resolving homes and reports invalid flags as errors', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runMigrationCommand(['--help'], {})).toBe(0);
  expect(await runMigrationCommand(['--bad-flag'], {})).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('migration failed'));
});
