import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home, homePaths } from './home.ts';
import { migrateLegacyHome, commitLegacyMigration, rollbackLegacyMigration } from './migrate.ts';
import { planLegacyMigration } from './migration-plan.ts';
import { readMigrationRecord } from './migration-record.ts';
import { readInstallMarker } from './install-marker.ts';
import { getHomeRecovery } from './recovery.ts';
import { HomeStore } from './store.ts';
import { holdCockpitLease } from './leases.ts';
import { VersionLog } from './version-log.ts';
import { migrationFixture, json, rawJson } from './migration.testkit.ts';
import { prepareOperatorHome } from './entry.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('D5: historical backup snapshots migrate as opaque bytes even when their JSON suffix hides malformed data', () => {
  const { legacy, target } = migrationFixture();
  const bytes = Buffer.from('malformed historical outside write\0\xff', 'latin1');
  const paths = ['backups/config.json/2026-11-07-badbytes.json', 'remote-settings/backups/4321.json/bad.json', 'server-instances/backups/one.json/bad.json'];
  for (const path of paths) {
    mkdirSync(join(legacy.root, path, '..'), { recursive: true });
    writeFileSync(join(legacy.root, path), bytes);
  }
  migrateLegacyHome(legacy, target);
  for (const path of ['config.json/2026-11-07-badbytes.json', 'remote-settings/4321.json/bad.json', 'server-instances/one.json/bad.json']) {
    expect(readFileSync(join(target.backups, path))).toEqual(bytes);
  }
});

it('B2: an accepted empty legacy registry keeps its exact acceptance and raises no target reset row', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, `${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
  const store = new HomeStore(legacy);
  expect(store.recovery(legacy.workspaceConfig)?.reason).toBe('reset');
  store.acceptRecovery(legacy.workspaceConfig);
  const accepted = new VersionLog(legacy.root, 'config.json').record('ACCEPTED');
  expect(getHomeRecovery(legacy)).toEqual({ files: [] });
  migrateLegacyHome(legacy, target);
  expect(new VersionLog(target.config, 'config.json').record('ACCEPTED')).toEqual(accepted);
  expect(new VersionLog(target.config, 'config.json').record('RESET')).toBeUndefined();
  expect(new VersionLog(target.config, 'config.json').record('OUTSIDE')).toBeUndefined();
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('B2: a recopy clears target acceptance when the legacy acceptance no longer matches the copied bytes', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, `${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }] });
  const store = new HomeStore(legacy);
  store.recovery(legacy.workspaceConfig);
  store.acceptRecovery(legacy.workspaceConfig);
  migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    if (step === 'recheck' && attempt === 0) rawJson(legacy.workspaceConfig, { projects: [], oldWriter: true });
  } });
  expect(new VersionLog(target.config, 'config.json').record('ACCEPTED')).toBeUndefined();
  expect(getHomeRecovery(target).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset' }));
});

it('B3: a reset interrupted after replacement but before HEAD advanced refuses migration under the claim', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.agentAccounts, { accounts: [{ id: 'before-crash' }] });
  const setRecord = VersionLog.prototype.setRecord;
  vi.spyOn(VersionLog.prototype, 'setRecord').mockImplementation(function (this: VersionLog, name, record) {
    if (name === 'HEAD') throw new Error('crash before HEAD');
    setRecord.call(this, name, record);
  });
  expect(() => new HomeStore(legacy).writeJson(legacy.agentAccounts, { accounts: [] })).toThrow('crash before HEAD');
  vi.restoreAllMocks();
  const journal = join(legacy.root, '.versions/agent-accounts.json');
  const before = readdirSync(journal).map(name => [name, readFileSync(join(journal, name)).toString('base64')]);
  expect(() => migrateLegacyHome(legacy, target)).toThrow(/Resolve home recovery before migration: agent-accounts\.json \(reset\)/);
  expect(readdirSync(journal).map(name => [name, readFileSync(join(journal, name)).toString('base64')])).toEqual(before);
  expect(readInstallMarker(target.config)?.state).toBeUndefined();
  expect(getHomeRecovery(legacy).files).toContainEqual(expect.objectContaining({ file: 'agent-accounts.json', reason: 'reset', canRestore: true }));
});

it.each(['absent', 'empty'])('step 1: an %s legacy home commits a fresh decision with an empty inventory', kind => {
  const root = storeRoot(), old = join(root, 'legacy');
  if (kind === 'empty') mkdirSync(old);
  const legacy = homePaths(old, join(root, 'cache'), old);
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  expect(migrateLegacyHome(legacy, target).status).toBe('fresh');
  expect(readInstallMarker(target.config)).toMatchObject({ state: 'committed', migratedFrom: old });
  expect(readMigrationRecord(target)).toMatchObject({ files: [], backup: '', legacyRoot: old });
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
  if (kind === 'absent') expect(existsSync(old)).toBe(false);
  else expect(readdirSync(old).filter(name => name !== '.locks')).toEqual(['MOVED.json']);
  expect(migrateLegacyHome(legacy, target).status).toBe('unchanged');
  if (kind === 'absent') expect(existsSync(old)).toBe(false);
});

it.each(['pending', 'rolled-back'] as const)('a %s copy is never committed as a fresh home after the legacy registry disappears', state => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  if (state === 'rolled-back') rollbackLegacyMigration(target);
  const record = readFileSync(join(target.state, 'migration.json'));
  rmSync(legacy.workspaceConfig);
  rmSync(`${legacy.workspaceConfig}.bak`, { force: true });
  expect(planLegacyMigration(legacy, target).empty).toBe(true);
  expect(() => migrateLegacyHome(legacy, target)).toThrow(new RegExp(`legacy home is empty.*${state} migration copy.*backup`, 's'));
  expect(readFileSync(join(target.state, 'migration.json'))).toEqual(record);
  expect(readInstallMarker(target.config)?.state).toBe(state === 'pending' ? 'pending' : undefined);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('T1: after a fresh boot, an older binary that writes legacy config.json does not block the next boot', () => {
  const root = storeRoot(), old = join(root, 'legacy');
  const legacy = homePaths(old, join(root, 'cache'), old);
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  const env = { HOME: root, SHELL: '/bin/bash' };
  prepareOperatorHome(target, 'serve', env, { legacy });
  new HomeStore(target).writeJson(target.workspaceConfig, { projects: [], saved: 'split home' });
  rawJson(legacy.workspaceConfig, { projects: [{ id: 'old', root: '/old' }] }); // Older binary.
  expect(prepareOperatorHome(target, 'serve', env, { legacy })).toBe(target);
  expect(json(target.workspaceConfig).saved).toBe('split home');
  expect(readMigrationRecord(target)!.files).toEqual([]);
  expect(json(legacy.workspaceConfig).projects[0].id).toBe('old');
});

it('step 1: a .bak-only legacy home recovers through the loader and merge writer before migrating', () => {
  const root = storeRoot();
  const legacy = Home.sandbox(join(root, 'legacy'), { layout: 'legacy' });
  const target = Home.sandbox(join(root, 'new'), { layout: 'split' });
  Home.seed(legacy, `${legacy.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept' }], unknown: 'preserved' });
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(json(legacy.workspaceConfig).projects[0].id).toBe('kept');
  expect(json(target.workspaceConfig)).toMatchObject({ unknown: 'preserved', projects: [{ id: 'kept' }] });
  expect(json(`${target.workspaceConfig}.bak`).projects[0].id).toBe('kept');
});

it('step 2: a live cockpit lease refuses migration and names pid, port and instance', () => {
  const { legacy, target } = migrationFixture();
  const release = holdCockpitLease(legacy, 4321, 'named');
  try {
    expect(() => migrateLegacyHome(legacy, target)).toThrow(`pid ${process.pid}, port 4321, instance named`);
    expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
    expect(readInstallMarker(target.config)?.state).toBeUndefined();
  } finally { release(); }
});

it('step 2: reclaims a stale .migrating holder and refuses a live second migration', () => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.root, '.migrating'), { pid: process.pid, startToken: 'a-different-process-incarnation' });
  let checked = false;
  migrateLegacyHome(legacy, target, { onStep(step) {
    if (step !== 'claimed') return;
    expect(() => migrateLegacyHome(legacy, target)).toThrow(/already running/);
    checked = true;
  } });
  expect(checked).toBe(true);
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it('step 3: a second committed migration is a no-op, even when an old binary later writes', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target);
  const before = statSync(target.workspaceConfig).mtimeMs;
  const record = readFileSync(join(target.state, 'migration.json'));
  rawJson(legacy.workspaceConfig, { saved: 'later outside write' });
  expect(migrateLegacyHome(legacy, target).status).toBe('unchanged');
  expect(statSync(target.workspaceConfig).mtimeMs).toBe(before);
  expect(readFileSync(join(target.state, 'migration.json'))).toEqual(record);
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('steps 4–5: copies every file family and nested backups into the owning private root with HEAD', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.workspaceUiState, { sidebar: 'closed' });
  Home.seed(legacy, legacy.serverState('one'), { port: 4321 });
  Home.seed(legacy, join(legacy.remoteSettings, '4321.json'), { secret: 'kept' });
  for (const path of ['tracker-connections/github.json', 'application-updates/update.json', 'backups/config.json/snapshot.json',
    'remote-settings/backups/4321.json/snapshot.json', 'server-instances/backups/one.json/snapshot.json']) rawJson(join(legacy.root, path), { path });
  writeFileSync(legacy.serverLock(), 'old lock');
  const result = migrateLegacyHome(legacy, target);
  for (const path of [target.workspaceConfig, target.workspaceUiState, target.serverState('one'), join(target.remoteSettings, '4321.json'),
    join(target.config, 'tracker-connections/github.json'), join(target.state, 'application-updates/update.json'),
    join(target.backups, 'config.json/snapshot.json'), join(target.backups, 'remote-settings/4321.json/snapshot.json'),
    join(target.backups, 'server-instances/one.json/snapshot.json'), join(target.state, 'migration.json'), result.record!.backup]) {
    expect(existsSync(path), path).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777, path).toBe(0o600);
  }
  expect(existsSync(target.serverLock())).toBe(false);
  expect(json(join(target.state, '.versions/server-instances/one.json/HEAD')).hash).toMatch(/^[a-f0-9]{64}$/);
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it.each(['outside-write', 'reset'])('step 5: refuses unresolved %s recovery without changing legacy bytes', reason => {
  const { legacy, target } = migrationFixture();
  if (reason === 'reset') {
    Home.seed(legacy, legacy.workspaceConfig, { projects: [{ id: 'kept', root: '/kept' }] });
    Home.seed(legacy, legacy.workspaceConfig, { projects: [] });
  } else rawJson(legacy.workspaceConfig, { projects: [], outside: true });
  const bytes = readFileSync(legacy.workspaceConfig);
  expect(() => migrateLegacyHome(legacy, target)).toThrow(new RegExp(`config.json \\(${reason}\\)`));
  expect(readFileSync(legacy.workspaceConfig)).toEqual(bytes);
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it('step 6: recopies an older-binary write before commit, including new and deleted files', () => {
  const { legacy, target } = migrationFixture();
  Home.seed(legacy, legacy.serverState('deleted'), { existed: true });
  const result = migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    if (step === 'recheck' && attempt === 0) {
      rawJson(legacy.workspaceConfig, { projects: [], saved: 'newer' });
      rawJson(join(legacy.remoteSettings, '7777.json'), { token: 'added' });
      rmSync(legacy.serverState('deleted')); // Older writers do not use HomeStore.
    }
  } });
  expect(json(target.workspaceConfig).saved).toBe('newer');
  expect(json(join(target.remoteSettings, '7777.json')).token).toBe('added');
  expect(existsSync(target.serverState('deleted'))).toBe(false);
  expect(result.record!.files.find(file => file.path === 'server-instances/deleted.json')).toMatchObject({ hash: null, mtimeMs: null });
  expect(result.record!.files.find(file => file.path === 'config.json')?.target).toEqual({ kind: 'config', path: 'config.json' });
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('step 6: three older-binary writes abort with the filename and process diagnostic', () => {
  const { legacy, target } = migrationFixture();
  expect(() => migrateLegacyHome(legacy, target, { onStep(step, attempt) {
    if (step === 'recheck') rawJson(legacy.workspaceConfig, { projects: [], attempt });
  } })).toThrow(/config.json.*Stop older binaries.*Running processes/s);
  expect(readInstallMarker(target.config)?.state).toBe('pending');
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(false);
  expect(existsSync(join(legacy.root, '.migrating'))).toBe(false);
});

it('D13: copying a running legacy managed installation into an empty target never changes its source', () => {
  const { legacy, target, env } = migrationFixture();
  const entry = join(legacy.versions, '1.2.3/node_modules/@wjarka/cezarion/dist/index.js');
  mkdirSync(join(entry, '..'), { recursive: true });
  const bytes = Buffer.from('export const runningFromLegacy = true;\n');
  writeFileSync(entry, bytes); // Fixture managed vendor file, outside the registry writer.
  rawJson(join(legacy.versions, '1.2.3/.cezar-install.json'), { version: '1.2.3', source: 'registry' });
  writeFileSync(join(legacy.versions, 'current'), '1.2.3');
  const before = statSync(entry);
  expect(existsSync(target.versions)).toBe(false);
  migrateLegacyHome(legacy, target, { env });
  const copied = join(target.versions, '1.2.3/node_modules/@wjarka/cezarion/dist/index.js');
  expect(readFileSync(copied)).toEqual(bytes);
  expect(readFileSync(entry)).toEqual(bytes);
  expect(statSync(entry).ino).toBe(before.ino);
  expect(statSync(entry).mtimeMs).toBe(before.mtimeMs);
  expect(readFileSync(join(legacy.versions, 'current'), 'utf8')).toBe('1.2.3');
  expect(readInstallMarker(target.config)?.state).toBe('committed');
});

it('step 6: recopy removes managed files deleted by an older binary', () => {
  const { legacy, target } = migrationFixture();
  rawJson(join(legacy.versions, 'v1/removed.json'), { stale: true });
  rawJson(join(legacy.versions, 'v1/kept.json'), { kept: true });
  migrateLegacyHome(legacy, target, { env: {}, onStep(step, attempt) {
    if (step === 'recheck' && attempt === 0) rmSync(join(legacy.versions, 'v1/removed.json'));
  } });
  expect(existsSync(join(target.versions, 'v1/removed.json'))).toBe(false);
  expect(json(join(target.versions, 'v1/kept.json'))).toEqual({ kept: true });
});

it('step 8: pending copies refuse ordinary writes, allow leases, commit once, and record every root in MOVED.json', () => {
  const { legacy, target } = migrationFixture();
  expect(migrateLegacyHome(legacy, target, { commit: false }).status).toBe('pending');
  expect(readMigrationRecord(target)!.stagedAt).toEqual(expect.any(String));
  expect(() => new HomeStore(target).writeJson(target.workspaceConfig, {})).toThrow(/pending migration/);
  const release = holdCockpitLease(target, 4322, 'pending-instance');
  release();
  expect(existsSync(join(legacy.root, 'MOVED.json'))).toBe(false);
  commitLegacyMigration(target, {});
  expect(readInstallMarker(target.config)).toMatchObject({ state: 'committed', migratedFrom: legacy.root });
  expect(json(join(legacy.root, 'MOVED.json')).roots).toEqual(readMigrationRecord(target)!.roots);
  expect(new HomeStore(target).read(target.workspaceConfig)).toContain('original');
});

it('step 8: final commit refuses changes made to legacy during a pending group health check', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  rawJson(legacy.workspaceConfig, { changedWhilePending: true });
  expect(() => commitLegacyMigration(target)).toThrow(/config.json/);
  expect(readInstallMarker(target.config)?.state).toBe('pending');
});

it('a pending home with a live target cockpit cannot be overwritten by another migration', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  const release = holdCockpitLease(target, 4333, 'health-check');
  try { expect(() => migrateLegacyHome(legacy, target)).toThrow(/port 4333, instance health-check/); }
  finally { release(); }
  expect(json(target.workspaceConfig).saved).toBe('original');
});

it('rolls back to install.json.failed and overwrites the crashed pending home on the next migration', () => {
  const { legacy, target } = migrationFixture();
  migrateLegacyHome(legacy, target, { commit: false });
  rollbackLegacyMigration(target);
  expect(existsSync(join(target.config, 'install.json.failed'))).toBe(true);
  rawJson(target.workspaceConfig, { crashResidue: true });
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(json(target.workspaceConfig).crashResidue).toBeUndefined();
});

it('rejects an invalid JSON copy before committing and leaves the legacy data unchanged', () => {
  const { legacy, target } = migrationFixture();
  const path = join(legacy.root, 'tracker-connections', 'invalid.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'invalid JSON');
  expect(() => migrateLegacyHome(legacy, target)).toThrow(SyntaxError);
  expect(readFileSync(path, 'utf8')).toBe('invalid JSON');
  expect(readInstallMarker(target.config)?.state).toBe('pending');
});

it('the shared dry-run planner inventories without creating a marker, journal or target', () => {
  const { legacy, target } = migrationFixture();
  rmSync(join(target.config, 'install.json'));
  const before = readdirSync(legacy.root);
  const plan = planLegacyMigration(legacy, target);
  expect(plan.files.some(file => file.path === 'config.json')).toBe(true);
  expect(plan.backup).toContain('legacy-cezar-home-');
  expect(readdirSync(legacy.root)).toEqual(before);
  expect(readInstallMarker(target.config)).toBeUndefined();
});
