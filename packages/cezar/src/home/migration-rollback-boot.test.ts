import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareHomeLifecycle, prepareOperatorHome } from './entry.ts';
import { Home } from './home.ts';
import { readInstallMarker } from './install-marker.ts';
import { readCockpitLeases } from './leases.ts';
import { migrateLegacyHome, rollbackLegacyMigration } from './migrate.ts';
import { prepareMigrationHome } from './migration-boot.ts';
import { runMigrationCommand } from './migration-cli.ts';
import { migrationFiles } from './migration-files.ts';
import { json, migrationFixture, rawJson } from './migration.testkit.ts';
import { cleanStoreRoots } from './store.testkit.ts';
import { useTestHome } from './test-home.testkit.ts';
import { installInstance, serverFixture, serverMigrate, sharedHome } from '../server-install/server-migrate.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

function rolledBackHome() {
  const f = migrationFixture();
  migrateLegacyHome(f.legacy, f.target, { commit: false });
  rollbackLegacyMigration(f.target);
  return f;
}

function targetSnapshot(home: Home) {
  return [home.config, home.state, home.data, home.cache, home.runtime].flatMap(root =>
    migrationFiles(root).sort().map(path => [root, path, readFileSync(join(root, path)).toString('base64')]));
}

it('a rolled-back group serves legacy through both serve preparations, with one warning and a legacy lease', async () => {
  const f = sharedHome();
  f.host.unhealthy.add('hearsay-squawk-shop.service');
  await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
  const before = targetSnapshot(f.target);
  const legacyBytes = readFileSync(f.legacy.workspaceConfig);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // index.ts selects the Home that startServer then passes to prepareHomeLifecycle.
  const served = prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy });
  expect(served).toBe(f.legacy);
  const server = createServer();
  prepareHomeLifecycle(served, 'shop', { rebrand: true })(server);
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    expect(readCockpitLeases(served)).toEqual([expect.objectContaining({ instance: 'shop' })]);
    expect(existsSync(join(f.target.config, '.locks/cockpits'))).toBe(false);
    expect(readFileSync(served.workspaceConfig)).toEqual(legacyBytes);
    expect(targetSnapshot(f.target)).toEqual(before);
    expect(readInstallMarker(f.target.config)).toBeUndefined();
    expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('hsq server-migrate'));
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  expect(readCockpitLeases(served)).toEqual([]);
});

it('direct server preparation refuses a rolled-back target before its consumers or lease can use it', async () => {
  const f = sharedHome();
  f.host.unhealthy.add('hearsay-squawk-shop.service');
  await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
  const before = targetSnapshot(f.target);
  useTestHome(f.legacy);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // startServer calls this synchronously before constructing consumers of deps.home.
  expect(() => prepareHomeLifecycle(f.target, undefined, { rebrand: true })).toThrow(
    `[hsq] refusing to serve home ${f.target.root}: preparation selected ${f.legacy.root}. Prepare the home before starting the server.`,
  );
  expect(targetSnapshot(f.target)).toEqual(before);
  expect(readInstallMarker(f.target.config)).toBeUndefined();
  expect(existsSync(join(f.target.config, '.locks/cockpits'))).toBe(false);
  expect(readCockpitLeases(f.legacy)).toEqual([]);
});

it.each(['default', 'shop'])('recognizes a completed %s server record after rollback', instance => {
  const f = serverFixture();
  installInstance(f, { instance, port: 4321, externalProxy: true });
  migrateLegacyHome(f.legacy, f.target, { commit: false });
  rollbackLegacyMigration(f.target);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(prepareMigrationHome(f.target, f.env, { enabled: true, legacy: f.legacy }))
    .toEqual({ kind: 'legacy', home: f.legacy });
});

it('server-migrate after rollback and boot recopies the current legacy data and clears the boot skip', async () => {
  const f = sharedHome();
  f.host.unhealthy.add('hearsay-squawk.service');
  await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'rolled-back' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy })).toBe(f.legacy);
  Home.seed(f.legacy, f.legacy.workspaceConfig, { projects: [], saved: 'after rollback' });
  rawJson(f.target.workspaceConfig, { saved: 'failed target' });
  f.host.unhealthy.clear();
  await expect(serverMigrate(f)).resolves.toMatchObject({ status: 'migrated' });
  expect(json(f.target.workspaceConfig).saved).toBe('after rollback');
  expect(readInstallMarker(f.target.config)?.state).toBe('committed');
  expect(prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy })).toBe(f.target);
});

it('explicit migrate recopies legacy and clears the skip without removing the failure evidence', async () => {
  const f = serverFixture();
  installInstance(f, { instance: 'default', port: 4321, externalProxy: true });
  migrateLegacyHome(f.legacy, f.target, { commit: false });
  rollbackLegacyMigration(f.target);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const before = targetSnapshot(f.target);
  expect(await runMigrationCommand(['--dry-run'], f.env, f.target, f.legacy)).toBe(0);
  expect(targetSnapshot(f.target)).toEqual(before);
  expect(prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy })).toBe(f.legacy);
  Home.seed(f.legacy, f.legacy.workspaceConfig, { projects: [], saved: 'explicit retry' });
  expect(await runMigrationCommand([], f.env, f.target, f.legacy)).toBe(0);
  expect(json(f.target.workspaceConfig).saved).toBe('explicit retry');
  warn.mockClear();
  expect(prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy })).toBe(f.target);
  expect(readInstallMarker(f.target.config)?.state).toBe('committed');
  expect(existsSync(join(f.target.config, 'install.json.failed'))).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

it.each(['desktop', 'incomplete server', 'dry-run server'])('%s keeps the current boot migration after a failed copy', kind => {
  const f = rolledBackHome();
  if (kind !== 'desktop') Home.seed(f.legacy, f.legacy.serverState(), {
    schema: 1, installed: kind === 'dry-run server', dryRun: kind === 'dry-run server', steps: {},
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy })).toBe(f.target);
  expect(readInstallMarker(f.target.config)?.state).toBe('committed');
  expect(json(f.target.workspaceConfig).saved).toBe('original');
  expect(warn).not.toHaveBeenCalled();
});

it('a staged retry stays on the pending target even while the prior failed marker remains', () => {
  const f = serverFixture();
  installInstance(f, { instance: 'shop', port: 4321, externalProxy: true });
  migrateLegacyHome(f.legacy, f.target, { commit: false });
  rollbackLegacyMigration(f.target);
  migrateLegacyHome(f.legacy, f.target, { commit: false });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(prepareOperatorHome(f.target, 'serve', f.env, { enabled: true, legacy: f.legacy })).toBe(f.target);
  expect(readInstallMarker(f.target.config)?.state).toBe('pending');
  expect(warn).not.toHaveBeenCalled();
});

it('switch off leaves the legacy serve path and failed target unchanged', () => {
  const f = serverFixture();
  installInstance(f, { instance: 'default', port: 4321, externalProxy: true });
  migrateLegacyHome(f.legacy, f.target, { commit: false });
  rollbackLegacyMigration(f.target);
  const before = targetSnapshot(f.target);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(prepareMigrationHome(f.target, f.env, { enabled: false, legacy: f.legacy })).toEqual({ kind: 'ready' });
  expect(prepareOperatorHome(f.legacy, 'serve', f.env, { enabled: false, legacy: f.legacy })).toBe(f.legacy);
  expect(targetSnapshot(f.target)).toEqual(before);
  expect(warn).not.toHaveBeenCalled();
});
