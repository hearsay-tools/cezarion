import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeStore } from './store.ts';
import { migrateLegacyHome } from './migrate.ts';
import { prepareOperatorHome } from './entry.ts';
import { readInstallMarker } from './install-marker.ts';
import { readMigrationRecord } from './migration-record.ts';
import { runMigrationCommand } from './migration-cli.ts';
import { migrationFixture, rawJson, json } from './migration.testkit.ts';
import { cleanStoreRoots } from './store.testkit.ts';
import * as writeLock from './write-lock.ts';
import { migrationFiles } from './migration-files.ts';
import { Home } from './home.ts';
import { acceptHomeRecovery } from './recovery.ts';

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

it('a cockpit refuses to start on .migrating before registry preparation', () => {
  const { legacy, target, env } = migrationFixture();
  rawJson(join(legacy.root, '.migrating'), { pid: process.pid });
  expect(() => prepareOperatorHome(target, 'serve', env, { legacy })).toThrow(/migration in progress/);
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
  expect(existsSync(target.workspaceConfig)).toBe(false);
});

it('D2: boot reclaims a dead migration holder and rebuilds its crashed pending copy', () => {
  const { legacy, target, env } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  rawJson(target.workspaceConfig, { crashed: true });
  rawJson(join(legacy.root, '.migrating'), { pid: process.pid, startToken: 'dead-process-incarnation' });
  prepareOperatorHome(target, 'serve', env, { legacy });
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it.each(['migrating', 'pending'] as const)('D3: %s inspections report without changing HEAD, OUTSIDE, RESET or journal bytes', protection => {
  for (const scenario of ['outside', 'missing-head', 'pending-reset', 'backup-reset']) {
    const { legacy } = migrationFixture();
    const journal = join(legacy.root, '.versions');
    if (scenario === 'pending-reset') {
      Home.seed(legacy, legacy.workspaceConfig, { projects: [{ id: 'kept', root: '/kept' }] });
      Home.seed(legacy, legacy.workspaceConfig, { projects: [] });
      const reset = join(journal, 'config.json/RESET');
      rawJson(reset, { ...json(reset), pending: true });
    } else if (scenario === 'backup-reset') {
      rawJson(`${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
    } else {
      rawJson(legacy.workspaceConfig, { changedOutside: true });
      if (scenario === 'missing-head') rmSync(join(journal, 'config.json/HEAD'));
    }
    const snapshot = () => migrationFiles(journal).map(path => [path, readFileSync(join(journal, path)).toString('base64'), lstatSync(join(journal, path)).mtimeMs]);
    const before = snapshot();
    const lock = writeLock.withHomeLock;
    let switched = false;
    vi.spyOn(writeLock, 'withHomeLock').mockImplementation((root, operation) => lock(root, () => {
      if (!switched) {
        switched = true;
        if (protection === 'migrating') rawJson(join(legacy.root, '.migrating'), { pid: process.pid });
        else rawJson(join(legacy.root, 'install.json'), { ...readInstallMarker(legacy.root), state: 'pending' });
      }
      return operation();
    }));
    const store = new HomeStore(legacy);
    const outside = store.outsideWrite(legacy.workspaceConfig);
    if (scenario === 'outside') expect(outside).toBeDefined();
    if (protection === 'migrating') rmSync(join(legacy.root, '.migrating'));
    else rawJson(join(legacy.root, 'install.json'), { ...readInstallMarker(legacy.root), state: undefined });
    switched = false;
    const recovery = store.recovery(legacy.workspaceConfig);
    if (scenario !== 'missing-head') expect(recovery, scenario).toBeDefined();
    expect(snapshot(), scenario).toEqual(before);
    vi.restoreAllMocks();
  }
});

it('D3: a normal read rechecks pending under its lock without probing .migrating', () => {
  const { legacy } = migrationFixture();
  const head = join(legacy.root, '.versions/config.json/HEAD');
  rmSync(head);
  const lock = writeLock.withHomeLock;
  vi.spyOn(writeLock, 'withHomeLock').mockImplementation((root, operation) => lock(root, () => {
    rawJson(join(legacy.root, 'install.json'), { ...readInstallMarker(legacy.root), state: 'pending' });
    return operation();
  }));
  vi.mocked(readFileSync).mockClear(); vi.mocked(lstatSync).mockClear();
  expect(new HomeStore(legacy).read(legacy.workspaceConfig)).toContain('original');
  expect(existsSync(head)).toBe(false);
  const guard = join(legacy.root, '.migrating');
  expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === guard)).toHaveLength(0);
  expect(vi.mocked(lstatSync).mock.calls.filter(([path]) => path === guard)).toHaveLength(0);
});

it('boot refuses a migration error and never seeds a fresh home over nonempty legacy data', () => {
  const { legacy, target, env } = migrationFixture();
  rawJson(legacy.workspaceConfig, { outside: true });
  expect(() => prepareOperatorHome(target, 'serve', env, { legacy })).toThrow(/Resolve home recovery/);
  expect(existsSync(target.workspaceConfig)).toBe(false);
});

it.each(['recovery', 'copy', 'recheck'] as const)('D6: a handled %s failure is not a staged home; the next boot resumes the migration', failure => {
  const { legacy, target, env } = migrationFixture();
  const invalid = join(legacy.root, 'tracker-connections', 'invalid.json');
  if (failure === 'recovery') rawJson(legacy.workspaceConfig, { outside: true });
  if (failure === 'copy') { rawJson(invalid, {}); writeFileSync(invalid, 'invalid JSON'); }
  let write = 0;
  const onStep = (step: string) => { if (failure === 'recheck' && step === 'recheck') rawJson(legacy.workspaceUiState, { write: write++ }); };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => migrateLegacyHome(legacy, target, { onStep })).toThrow();
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
  if (failure === 'recovery') acceptHomeRecovery(legacy, 'config.json');
  if (failure === 'copy') rawJson(invalid, { fixed: true });
  expect(prepareOperatorHome(target, 'serve', env, { legacy })).toBe(target);
  expect(readInstallMarker(target.config)?.state).toBe('committed');
  expect(readMigrationRecord(target)?.stagedAt).toBeUndefined();
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(true);
});

it('boot serves a pending home read-only without running migration or seeding missing HEAD records', () => {
  const { legacy, target, env } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  const head = join(target.config, '.versions/config.json/HEAD');
  rmSync(head);
  rawJson(legacy.workspaceConfig, { changedWhilePending: true });
  prepareOperatorHome(target, 'serve', env, { legacy });
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
